#!/usr/bin/env node
/**
 * `mastra-libpetri verify <module>` — proves every claim M6 makes ([ADR 0009]) about each Mastra
 * workflow a module exports, and exits 0 only when every one holds.
 *
 * The CLI reaches Mastra through the package root, as a consumer would: `src/index.ts` is the one
 * file outside `src/mastra/` that re-exports the host ([ADR 0005]). Argument parsing, the exit
 * code and the formatting are pure and exported, so they are tested without a solver.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Z3Unavailable } from 'libpetri/verification';
import { nestedWorkflows, verifyMastraWorkflow, workflowsIn, type MastraVerifyOptions } from './index.js';
import { describeClaim, describeUnclaimedTarget, FAMILIES, segmentLabel, type Family, type VerificationReport } from './verify/index.js';

export const USAGE = `usage: mastra-libpetri verify <module-path> [options]

Proves every claim about each Mastra workflow the module exports (and each workflow registered on
an exported Mastra instance, and each workflow they nest). Exits 0 when every claim holds, 1 when
any fails or is unknown, 2 on a usage error, a missing z3 or a workflow this engine cannot run.

options:
  --export <name>           verify only this export (a Workflow or a Mastra instance)
  --concurrency <k>         step attempts in flight per run; default: the workflow's engine's
  --iteration-bound <n>     .dowhile / .dountil bound; default: the workflow's engine's
  --timeout <ms>            per-query budget (default 30000); a query that runs out is unknown
  --families <list>         comma-separated subset of ${FAMILIES.join(',')} (default: all)
  --json                    print the reports as JSON instead of text
  -h, --help                print this and exit`;

/** A command line the CLI refuses: exit 2, with the usage. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface VerifyCommand {
  readonly command: 'verify';
  readonly modulePath: string;
  readonly exportName?: string;
  readonly concurrency?: number;
  readonly iterationBound?: number;
  readonly timeoutMs?: number;
  readonly families?: readonly Family[];
  readonly json: boolean;
}

export type CliCommand = VerifyCommand | { readonly command: 'help' };

/** Parses `argv` (without `node` and the script). Throws {@link UsageError}. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        export: { type: 'string' },
        concurrency: { type: 'string' },
        'iteration-bound': { type: 'string' },
        timeout: { type: 'string' },
        families: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  const [command, modulePath, ...rest] = positionals;
  if (command === undefined) throw new UsageError('missing command: expected `verify <module-path>`');
  if (command !== 'verify') throw new UsageError(`unknown command '${command}': expected 'verify'`);
  if (modulePath === undefined) throw new UsageError('missing <module-path>');
  if (rest.length > 0) throw new UsageError(`unexpected argument${rest.length > 1 ? 's' : ''}: ${rest.join(' ')}`);

  const concurrency = positiveInt('--concurrency', values.concurrency);
  const iterationBound = positiveInt('--iteration-bound', values['iteration-bound']);
  const timeoutMs = positiveInt('--timeout', values.timeout);
  const families = values.families === undefined ? undefined : parseFamilies(values.families);
  return {
    command: 'verify',
    modulePath,
    ...(values.export === undefined ? {} : { exportName: values.export }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(iterationBound === undefined ? {} : { iterationBound }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(families === undefined ? {} : { families }),
    json: values.json,
  };
}

function positiveInt(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive whole number, got '${raw}'`);
  return n;
}

function parseFamilies(raw: string): readonly Family[] {
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) throw new UsageError('--families names no family');
  const unknown = names.filter((n) => !(FAMILIES as readonly string[]).includes(n));
  if (unknown.length > 0) throw new UsageError(`unknown famil${unknown.length > 1 ? 'ies' : 'y'} ${unknown.join(', ')}: expected ${FAMILIES.join(', ')}`);
  return [...new Set(names)] as Family[];
}

/** One report, and where it came from: the export it was found under, and its parent if nested. */
export interface NamedReport {
  readonly name: string;
  readonly nestedIn?: string;
  readonly report: VerificationReport;
}

/**
 * The exit code for a finished run: `2` when any query found no route to run (`unavailable` — no
 * solver), else `1` when any claim does not hold (`violated` or `unknown` alike — a timeout is
 * never a pass), else `0`. No report at all is `2`: a module with no workflow proves nothing.
 */
export function exitCodeFor(reports: readonly NamedReport[]): 0 | 1 | 2 {
  if (reports.length === 0) return 2;
  if (reports.some((r) => r.report.claims.some((c) => c.result.route === 'unavailable'))) return 2;
  return reports.every((r) => r.report.holds) ? 0 : 1;
}

/**
 * The exit code for a thrown error: `2` for a usage error, a missing z3 and a workflow this engine
 * cannot run (`UnsupportedWorkflowError`, matched by name so a second copy of the package still
 * counts); `1` for anything else — a structural violation is a claim that fails.
 */
export function exitCodeForError(error: unknown): 1 | 2 {
  if (error instanceof UsageError || error instanceof Z3Unavailable) return 2;
  if (error instanceof Error && (error.name === 'UnsupportedWorkflowError' || error.name === 'Z3Unavailable')) return 2;
  return 1;
}

/** `smt 12, enumeration 30` — which routes decided the claims, most first. */
export function routeMix(report: VerificationReport): string {
  const counts = new Map<string, number>();
  for (const c of report.claims) counts.set(c.result.route, (counts.get(c.result.route) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([route, n]) => `${route} ${n}`).join(', ') || 'none';
}

/**
 * The text for one report: a `describeClaim` line per claim that does not hold, then the summary —
 * claims held, `k`, segments, families, route mix, every unclaimed place and every unclaimed liveness
 * target ([ADR 0014]) with its reason.
 */
export function formatReport(named: NamedReport): string {
  const { report } = named;
  const held = report.claims.filter((c) => c.holds).length;
  const where = named.nestedIn === undefined ? `'${named.name}'` : `'${named.name}' (nested in '${named.nestedIn}')`;
  const lines = [
    ...report.claims.filter((c) => !c.holds).map((c) => describeClaim(c)),
    `${report.holds ? 'HOLDS' : 'FAILS'} workflow ${where} [${report.workflow}]: ${held}/${report.claims.length} claims hold`,
    `  k: ${report.k}; structural hash: ${report.structuralHash}`,
    `  segments (${report.segments.length}): ${report.segments.map(segmentLabel).join(', ')}`,
    `  families: ${report.families.join(', ')}`,
    `  routes: ${routeMix(report)}`,
    report.unclaimed.length === 0 ? '  unclaimed places: none' : `  unclaimed places (${report.unclaimed.length}):`,
    ...report.unclaimed.map((u) => `    ${u.place} — ${u.why}`),
    report.unclaimedTargets.length === 0 ? '  unclaimed liveness targets: none' : `  unclaimed liveness targets (${report.unclaimedTargets.length}):`,
    ...report.unclaimedTargets.map((u) => `    ${describeUnclaimedTarget(u)}`),
  ];
  return lines.join('\n');
}

/**
 * The JSON form of one report: every claim with its verdict, route and marking, but not the raw
 * solver result — its invariants and traces are libpetri objects, not a stable output format.
 */
export function reportJson(named: NamedReport): unknown {
  const { report } = named;
  return {
    name: named.name,
    ...(named.nestedIn === undefined ? {} : { nestedIn: named.nestedIn }),
    workflow: report.workflow,
    k: report.k,
    structuralHash: report.structuralHash,
    holds: report.holds,
    segments: report.segments.map(segmentLabel),
    families: report.families,
    claims: report.claims.map((c) => ({
      family: c.family,
      kind: c.kind,
      property: c.property,
      segment: segmentLabel(c.segment),
      marking: c.marking,
      verdict: c.result.verdict.type,
      ...(c.result.verdict.type === 'unknown' ? { reason: c.result.verdict.reason } : {}),
      route: c.result.route,
      elapsedMs: c.result.elapsedMs,
      ...(c.kind === 'witness' ? { witness: c.result.counterexampleTransitions } : {}),
      holds: c.holds,
    })),
    unclaimed: report.unclaimed,
    unclaimedTargets: report.unclaimedTargets,
  };
}

interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Runs the CLI; resolves to the exit code. Never throws. */
export async function main(argv: readonly string[], io: Io = { out: (t) => console.log(t), err: (t) => console.error(t) }): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (command.command === 'help') {
    io.out(USAGE);
    return 0;
  }
  try {
    const path = resolve(command.modulePath);
    if (!existsSync(path)) throw new UsageError(`no such module: ${command.modulePath}`);
    const moduleExports = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    let found: ReturnType<typeof workflowsIn>;
    try {
      found = workflowsIn(moduleExports, command.exportName);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    if (found.length === 0) {
      io.err(`${command.modulePath} exports no Mastra Workflow and no Mastra instance with workflows`);
      return 2;
    }
    const options: MastraVerifyOptions = {
      ...(command.concurrency === undefined ? {} : { concurrency: command.concurrency }),
      ...(command.iterationBound === undefined ? {} : { iterationBound: command.iterationBound }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(command.families === undefined ? {} : { families: command.families }),
    };
    // A workflow exported and also nested in another is verified once, as the nested run it is.
    const nested = new Set(found.flatMap((f) => [...nestedWorkflows(f.workflow).values()]));
    const reports: NamedReport[] = [];
    for (const { name, workflow } of found.filter((f) => !nested.has(f.workflow))) {
      const verification = await verifyMastraWorkflow(workflow, options);
      const own: NamedReport = { name, report: verification.workflow };
      reports.push(own);
      if (!command.json) io.out(formatReport(own));
      for (const [id, report] of Object.entries(verification.nested)) {
        const child: NamedReport = { name: id, nestedIn: name, report };
        reports.push(child);
        if (!command.json) io.out(formatReport(child));
      }
    }
    const code = exitCodeFor(reports);
    if (command.json) io.out(JSON.stringify({ holds: code === 0, reports: reports.map(reportJson) }, null, 2));
    else io.out(code === 0 ? `every claim of ${reports.length} workflow(s) holds` : code === 2 ? 'no solver could run: z3 is unavailable' : 'some claims do not hold');
    return code;
  } catch (error) {
    const code = exitCodeForError(error);
    io.err(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    if (error instanceof UsageError) io.err(`\n${USAGE}`);
    return code;
  }
}

/** True when this file is the process entry — directly, or through the `bin` symlink. */
function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
