import { compile } from '../compiler/compile.js';
import type { CompiledWorkflow } from '../compiler/types.js';
import { verify, type VerificationReport, type WorkflowVerifyOptions } from '../verify/workflow.js';
import { adaptExecutionGraph, MASTRA_WORKFLOW_COMPONENT } from './adapt.js';
import { PetriExecutionEngine } from './engine.js';
import type { ExecutionGraph, SingleStepEntry, StepFlowEntry } from './host.js';

/**
 * A committed Mastra `Workflow`, read structurally: the three members `execute()` itself is handed
 * (`workflow.ts:2745-2751` — `graph`, `retryConfig`, the workflow's id), and `component`, which is
 * how a workflow is told apart from a step (`step-entry.ts:61-70`).
 */
export interface VerifiableWorkflow {
  readonly id: string;
  readonly component?: string;
  /** `Workflow.retryConfig` (`workflow.ts:1765,1797`) — the fallback a step's own count overrides. */
  readonly retryConfig?: { readonly attempts?: number; readonly delay?: number };
  /** A pure pass-through, `{ id, steps: stepFlow }` (`workflow.ts:2661-2666`). */
  buildExecutionGraph(): ExecutionGraph;
}

/**
 * What {@link verifyMastraWorkflow} is given, in Mastra's words: the engine's own two options,
 * then everything `verify` takes. `concurrency` and `iterationBound` default, per workflow, to the
 * workflow's own `PetriExecutionEngine`'s — so what is proven is the net that engine runs. Given,
 * they apply to every workflow verified, nested ones included.
 */
export type MastraVerifyOptions = {
  /** As `PetriEngineOptions.concurrency`: at most this many step attempts in flight in one run. */
  readonly concurrency?: number;
  /** As `PetriEngineOptions.iterationBound`: required by a `.dowhile` / `.dountil`. */
  readonly iterationBound?: number;
} & WorkflowVerifyOptions;

/**
 * Every claim about one workflow and about each workflow it nests.
 *
 * `nested` is flat, keyed by workflow id, and covers every depth: a nested workflow runs as a run
 * of its own, on its own engine and with its own budget (`workflow.ts:2966-2968` — `this.createRun`),
 * so its claims are about its own net, not a part of the parent's. The parent's net treats the
 * nested run as one step (`adapt.ts`, source `workflow`).
 */
export interface MastraVerification {
  readonly workflow: VerificationReport;
  readonly nested: Readonly<Record<string, VerificationReport>>;
  /** Every claim of the workflow and of every nested workflow holds. */
  readonly holds: boolean;
}

/**
 * Proves every claim `verify` makes ([ADR 0009]) about the net this engine compiles for a Mastra
 * workflow, and about each nested workflow's.
 *
 * The net is built exactly as `PetriExecutionEngine.execute()` builds it: `adaptExecutionGraph`
 * over `buildExecutionGraph()` with the workflow's `retryConfig` and the iteration bound, then
 * `compile` with the concurrency. Where the options omit those two, a workflow whose engine is a
 * `PetriExecutionEngine` supplies its own; on any other engine they stay unset, and a loop is then
 * refused as `execute()` would refuse it.
 *
 * Nested workflows are found through every single-step position Mastra allows — a plain entry, a
 * `.parallel()` or `.branch()` arm, a loop or `.foreach()` body — and verified once each, however
 * often they are nested; a nested workflow on another engine is verified as the net this engine
 * would compile for it.
 *
 * Throws `UnsupportedWorkflowError` for a workflow this engine cannot run, and whatever `verify`
 * throws (a structural violation, a missing libpetri member). Never passes on `unknown`: a claim
 * holds only on `proven`, or on a confirmed witness.
 */
export async function verifyMastraWorkflow(
  workflow: VerifiableWorkflow,
  options: MastraVerifyOptions = {},
): Promise<MastraVerification> {
  const { concurrency, iterationBound, ...verifyOptions } = options;
  const verifyOne = (wf: VerifiableWorkflow): Promise<VerificationReport> =>
    verify(compileMastraWorkflow(wf, { ...(concurrency === undefined ? {} : { concurrency }), ...(iterationBound === undefined ? {} : { iterationBound }) }), verifyOptions);

  const report = await verifyOne(workflow);
  const nested: Record<string, VerificationReport> = {};
  // One at a time: each `verify` already runs its queries in a pool as wide as `jobs`.
  for (const [id, wf] of nestedWorkflows(workflow)) nested[id] = await verifyOne(wf);
  return { workflow: report, nested, holds: report.holds && Object.values(nested).every((r) => r.holds) };
}

/**
 * The net `verifyMastraWorkflow` proves for `workflow` itself (not its nested workflows): adapted and
 * compiled exactly as its engine would, with the engine's iteration bound and budget unless the
 * options override them. For a caller that proves one segment at a time (`segmentsFor`).
 */
export function compileMastraWorkflow(
  workflow: VerifiableWorkflow,
  options: { readonly concurrency?: number; readonly iterationBound?: number } = {},
): CompiledWorkflow {
  const engine = engineSettings(workflow);
  const bound = options.iterationBound ?? engine.iterationBound;
  const k = options.concurrency ?? engine.concurrency;
  const description = adaptExecutionGraph(workflow.buildExecutionGraph(), {
    ...(workflow.retryConfig ? { retryConfig: workflow.retryConfig } : {}),
    ...(bound === undefined ? {} : { iterationBound: bound }),
  });
  return compile(description, k === undefined ? {} : { concurrency: k });
}

/** The workflow's own engine's settings, when that engine is this one; otherwise none. */
function engineSettings(workflow: VerifiableWorkflow): { readonly concurrency?: number; readonly iterationBound?: number } {
  // `executionEngine` is protected on `Workflow` (`workflow.ts:1761`); read, never written.
  const engine = (workflow as unknown as { readonly executionEngine?: unknown }).executionEngine;
  return engine instanceof PetriExecutionEngine ? engine.settings() : {};
}

/** A Mastra `Workflow`, by the comparison Mastra itself uses (`step-entry.ts:61-70`). */
export function isMastraWorkflow(value: unknown): value is VerifiableWorkflow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { component?: unknown; id?: unknown; buildExecutionGraph?: unknown };
  return v.component === MASTRA_WORKFLOW_COMPONENT && typeof v.id === 'string' && typeof v.buildExecutionGraph === 'function';
}

/**
 * Every workflow nested in `workflow`, at any depth, in step-flow order, each once, keyed by id —
 * a second, distinct workflow with an id already taken is keyed `id#2`, `id#3`, … rather than
 * dropped. An uncommitted nested workflow has no step flow and contributes none of its own; the
 * adapter refuses it when it is verified.
 */
export function nestedWorkflows(workflow: VerifiableWorkflow): ReadonlyMap<string, VerifiableWorkflow> {
  const found = new Map<string, VerifiableWorkflow>();
  const seen = new Set<VerifiableWorkflow>([workflow]);
  const visit = (wf: VerifiableWorkflow): void => {
    for (const child of childWorkflows(wf.buildExecutionGraph().steps ?? [])) {
      if (seen.has(child)) continue;
      seen.add(child);
      let key = child.id;
      for (let n = 2; found.has(key); n++) key = `${child.id}#${n}`;
      found.set(key, child);
      visit(child);
    }
  };
  visit(workflow);
  return found;
}

/** The workflows among the single steps of one step flow — every position one can occupy. */
function childWorkflows(entries: readonly StepFlowEntry[]): VerifiableWorkflow[] {
  const singles = entries.flatMap((entry): readonly SingleStepEntry[] => {
    switch (entry.type) {
      case 'parallel':
      case 'conditional':
        return entry.steps;
      case 'loop':
      case 'foreach':
        return [entry.step];
      case 'sleep':
      case 'sleepUntil':
        return [];
      default:
        return [entry];
    }
  });
  return singles.flatMap((single) => (single.type === 'step' && isMastraWorkflow(single.step) ? [single.step] : []));
}

/** A `Mastra` instance, read structurally: `getWorkflows()` (`mastra/index.ts`). */
function isMastraInstance(value: unknown): value is { getWorkflows(): Record<string, unknown> } {
  return typeof value === 'object' && value !== null && typeof (value as { getWorkflows?: unknown }).getWorkflows === 'function';
}

/**
 * The workflows a module offers, for the CLI: every export that is a `Workflow`, and every
 * workflow registered on an exported `Mastra` instance (`getWorkflows()`), each once, in export
 * order. With `exportName`, only that export — which must be a workflow or a `Mastra`.
 *
 * Each is named by where it was found — the export name, or `<export>.<registration key>` — and
 * nested workflows are left to {@link verifyMastraWorkflow}.
 */
export function workflowsIn(
  moduleExports: Readonly<Record<string, unknown>>,
  exportName?: string,
): readonly { readonly name: string; readonly workflow: VerifiableWorkflow }[] {
  const names = exportName === undefined ? Object.keys(moduleExports) : [exportName];
  if (exportName !== undefined && !(exportName in moduleExports)) {
    throw new Error(`the module has no export '${exportName}'`);
  }
  const out: { name: string; workflow: VerifiableWorkflow }[] = [];
  const seen = new Set<unknown>();
  const add = (name: string, value: unknown): void => {
    if (!isMastraWorkflow(value) || seen.has(value)) return;
    seen.add(value);
    out.push({ name, workflow: value });
  };
  for (const name of names) {
    const value = moduleExports[name];
    if (isMastraWorkflow(value)) add(name, value);
    else if (isMastraInstance(value)) for (const [key, wf] of Object.entries(value.getWorkflows())) add(`${name}.${key}`, wf);
    else if (exportName !== undefined) throw new Error(`export '${exportName}' is neither a Mastra Workflow nor a Mastra instance`);
  }
  return out;
}
