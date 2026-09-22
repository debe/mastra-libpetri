import {
  Transition,
  all,
  and,
  exactly,
  one,
  outPlace,
  place,
  xor,
  type Place,
  type TransitionAction,
} from 'libpetri';
import type { EntryPath } from '../names.js';
import { scopeOf, viewOf, type RunScope } from '../scope.js';
import type {
  BailToken,
  Exits,
  FailureToken,
  FlowToken,
  PauseToken,
  StepDescription,
  StepOutcome,
  SuspendToken,
} from '../types.js';
import type { Gadget, GadgetResult } from './types.js';

/**
 * What `decide` hands one arm's gate: the verdict for that arm, made once for the whole block.
 *
 * `reuse` is Mastra's, not ours: a truthy arm whose step id already holds a `success` result is
 * not executed again — `executeConditional` returns the stored result instead
 * (`handlers/control-flow.ts:543-553`). A plain JSON value rather than a `Set` or a closure,
 * because a marking snapshot is JSON ([CORE-073]).
 */
export type GateToken =
  | { readonly decision: 'run'; readonly data: unknown }
  | { readonly decision: 'skip' }
  | { readonly decision: 'reuse'; readonly output: unknown };

/**
 * One arm's settlement, as the join counts it. Every arm deposits exactly one, whichever way it
 * went, so the join is a cardinality join over `arrived` and never waits on an arm that will not
 * come.
 *
 * Only `ok` carries a value: it is the only status whose data reaches the block's own output.
 * The index is stamped by *which* transition deposited it, so arm identity is topology rather
 * than a value the join has to trust.
 */
export type ArmArrival =
  | { readonly status: 'ok'; readonly index: number; readonly data: unknown }
  | { readonly status: 'failed' }
  | { readonly status: 'suspended' }
  /** Bailed or paused: the arm is done, and the block does not report it. */
  | { readonly status: 'settled' }
  | { readonly status: 'skipped' };

/**
 * `.branch([[cond, step], ...])` — **inclusive**, not if/else.
 *
 * Mastra evaluates every condition concurrently and runs *every* arm whose condition is truthy,
 * then joins all of them (`handlers/control-flow.ts:395-498,540`). No truthy condition is a legal
 * success that continues the run. Compiling this as an exclusive choice is a correctness bug,
 * not a simplification.
 *
 * ```text
 *   in --decide--> xor( and(gate_0 .. gate_{n-1}), exits.failed )    the decision itself broke
 *
 *   gate_i --gate-i--> xor( arm_i.in, arrived{skipped | ok(reused)} )
 *   arm_i.in -> [step i] -> armDone_i --collect-i--> arrived{ok, i, data}
 *                        -> armErr    --collect-err--> arrived{failed}    + errSeen   (one firing)
 *                        -> armSusp   --collect-susp-> arrived{suspended} + suspSeen  (one firing)
 *                        -> armBail   --collect-bail-> arrived{settled}              (swallowed)
 *                        -> armPause  --collect-pause> arrived{settled}              (swallowed)
 *
 *   exactly(n, arrived), all(errSeen),  reset(suspSeen)       --join-fail--> exits.failed
 *   exactly(n, arrived), all(suspSeen), inhibitor(errSeen)    --join-susp--> exits.suspended
 *   exactly(n, arrived), inhibitor(errSeen), inhibitor(suspSeen) --join-ok--> next
 * ```
 *
 * **The join is Mastra's aggregation, shared with `.parallel()`.** Mastra awaits every arm
 * (`Promise.all`, and an arm failure never rejects), then reports failed > suspended > success
 * (`handlers/control-flow.ts:596-625`). The three joins are that ladder as topology: `join-fail`
 * needs a failure, `join-susp` needs a suspension and no failure, `join-ok` needs neither. They
 * are structurally exclusive, so no priority is involved. A bailed or paused arm falls through to
 * success in Mastra and is simply absent from the block's output, so its arrival is `settled`.
 *
 * **Why the ladder is race-free.** `collect-err` writes the arrival and the failure marker in one
 * firing, and a firing's outputs are deposited together before enablement is re-evaluated
 * ([EXEC-001]). So the arrival that completes the count is never observable without the marker
 * that goes with it: there is no marking with `n` arrivals and a failure still pending, and
 * `join-ok` cannot win a race it should lose. `collect-susp` is the same for suspensions.
 *
 * **Every token has a consumer on every path.** `join-fail` takes every failure (`all`) and
 * drains any suspension (`reset`); `join-susp` takes every suspension. `errSeen` and `suspSeen`
 * are empty after the block whichever join fired, which is what the residue check and
 * `DeadlockFree` both hold the gadget to.
 *
 * **One decision, not n.** `selectBranches` is called once, inside `decide`, and each gate is
 * handed its own verdict. Calling it per arm would be n independent evaluations that could
 * disagree with each other — Mastra evaluates the conditions once per block.
 *
 * **Why n independent `xor`s, though the design skill warns against `and` of `xor`.** That warning
 * is about combinations no execution can produce, on which a proof then fails. An inclusive
 * branch is the case where it does not apply: `selectBranches` may return any of the 2^n subsets,
 * so every combination the gates can reach genuinely is a runtime outcome. The structural branches
 * equal the runtime outcomes, which is what [IO-015] asks for. A reader will take this for a bug;
 * it is not.
 *
 * **Why gates, rather than one `decide` naming every subset.** [IO-016] enumerates `and` as the
 * Cartesian product of its children, so a `decide` declaring `and(xor(run_0, skip_0), ...)` is
 * 2^n branches in one transition, and every skip would have to land in a place of its own
 * because a branch models one token per named place. The gates keep `decide` at two branches and
 * the declared branches linear in n (8n + 9 with single-attempt arms). The reachable state space
 * still grows exponentially, because every subset and interleaving is genuinely reachable; its
 * cost per arm count is measured in `tests/verify/branch.test.ts`, which is where a split
 * threshold should be chosen from.
 *
 * **The value handed on differs by position** (`ctx.nextIsResult`):
 * - as the workflow's last entry, the run's result is the block's own output: the arms that
 *   arrived `ok` in this block, keyed by arm id, in arm order (`handlers/control-flow.ts:616-624`);
 * - otherwise the next entry receives what Mastra's `getStepOutput` builds: every *declared* arm,
 *   each read from the run's step results (`default.ts:1141-1149`). A skipped arm is present with
 *   whatever its id last recorded — `undefined`, or an earlier entry's output when the same step
 *   ran before, because Mastra records nothing for a skipped arm (`handlers/control-flow.ts:511-529`
 *   writes only under time travel).
 *
 * **What `decide` refuses.** A condition that throws is the runner's to report as falsy, as
 * Mastra's per-condition `catch` does (`handlers/control-flow.ts:467-492`). A throw out of
 * `selectBranches` itself, a runner without one, a non-array answer or an index outside the arms
 * fails the block to `exits.failed` with a message naming the entry, because each is a broken
 * evaluation rather than a falsy condition. A repeated index is not an error: Mastra filters arms
 * by `truthyIndexes.includes(index)` (`handlers/control-flow.ts:498`), so membership is all that
 * counts and the arm runs once.
 */
export const branchGadget: Gadget = (entry, next, ctx): GadgetResult => {
  if (entry.kind !== 'branch') throw new Error(`branchGadget received a '${entry.kind}' entry`);

  const { names, path, exits } = ctx;
  const arms: readonly StepDescription[] = entry.arms;
  for (const arm of arms) {
    // The type already says so; this is for a caller that is not type-checked. Mastra types an
    // arm as `SingleStepEntry` (`types.d.ts:577,583`), so a nested combinator here is a net for a
    // workflow Mastra cannot express.
    if ((arm as { kind: string }).kind !== 'step') {
      throw new Error(
        `branch '${entry.id}': arm '${arm.id}' is a '${(arm as { kind: string }).kind}' entry. A .branch() ` +
          'arm is a single step; nest a workflow to branch into more than one.',
      );
    }
  }

  const n = arms.length;
  const inPlace = place<FlowToken>(names.entryIn(path, entry.id));

  if (n === 0) {
    // Mastra evaluates no condition, runs no arm and reduces an empty result list to
    // `{status: 'success', output: {}}` (`handlers/control-flow.ts:540,616-624`); `getStepOutput`
    // over zero declared arms is `{}` as well, so both value shapes coincide. `exactly(0)` and an
    // empty `and()` are illegal in libpetri, so the block is one pass-through transition.
    const pass = Transition.builder(names.entryTransition(path, entry.id, 'pass'))
      .inputs(one(inPlace))
      .outputs(outPlace(next))
      .action(async (tctx) => {
        tctx.output(next, { data: {} });
      })
      .build();
    return { inPlace, transitions: [pass] };
  }

  const arrived = place<ArmArrival>(names.entryPlace(path, entry.id, 'arrived'));
  /** The arms' failure exit. Local, so a failing arm cannot end the run while siblings run. */
  const armErr = place<FailureToken>(names.entryPlace(path, entry.id, 'arm-err'));
  const armSusp = place<SuspendToken>(names.entryPlace(path, entry.id, 'arm-susp'));
  const armBail = place<BailToken>(names.entryPlace(path, entry.id, 'arm-bail'));
  const armPause = place<PauseToken>(names.entryPlace(path, entry.id, 'arm-pause'));
  /** The marking's memory that an arm failed, kept past `armErr`'s consumption for the joins. */
  const errSeen = place<FailureToken>(names.entryPlace(path, entry.id, 'err-seen'));
  /** Likewise for a suspension. */
  const suspSeen = place<SuspendToken>(names.entryPlace(path, entry.id, 'susp-seen'));

  // Where an arm's bail and suspend go is this block's decision, made here and nowhere else: all
  // four land in local places, so every arm settles before the block decides its own outcome.
  const armExits: Exits = { failed: armErr, bailed: armBail, suspended: armSusp, paused: armPause };

  const gates: Place<GateToken>[] = [];
  const transitions: Transition[] = [];

  for (let i = 0; i < n; i++) {
    const arm = arms[i]!;
    const gateIn = place<GateToken>(names.entryPlace(path, entry.id, `gate-${i}`));
    const armDone = place<FlowToken>(names.entryPlace(path, entry.id, `arm-${i}-done`));
    // The arm's own transitions are recorded by `emitNested` under the arm's path; returning them
    // again would put each into the net twice, and a duplicated transition fires twice.
    const child = ctx.emitNested(arm, [...path, i], armDone, armExits);
    gates.push(gateIn);

    transitions.push(
      Transition.builder(names.entryTransition(path, entry.id, `gate-${i}`))
        .inputs(one(gateIn))
        // Both legs are declared, which is what lets the verdict ride in a token value: the
        // verifier is value-blind, so it explores run *and* skip whatever the token says.
        // `reuse` writes the same place as `skip` — one declared place set, two runtime values.
        .outputs(xor(outPlace(child.inPlace), outPlace(arrived)))
        .action(async (tctx) => {
          const gate = tctx.input(gateIn);
          switch (gate.decision) {
            case 'run':
              tctx.output(child.inPlace, { data: gate.data });
              return;
            case 'skip':
              tctx.output(arrived, { status: 'skipped' });
              return;
            case 'reuse':
              tctx.output(arrived, { status: 'ok', index: i, data: gate.output });
              return;
          }
        })
        .build(),

      Transition.builder(names.entryTransition(path, entry.id, `collect-${i}`))
        .inputs(one(armDone))
        .outputs(outPlace(arrived))
        .action(async (tctx) => {
          tctx.output(arrived, { status: 'ok', index: i, data: tctx.input(armDone).data });
        })
        .build(),
    );
  }

  transitions.push(
    Transition.builder(names.entryTransition(path, entry.id, 'decide'))
      .inputs(one(inPlace))
      // Either the evaluation succeeded and every gate is armed, or it broke and nothing
      // downstream exists at all. No gate armed means no sibling token to strand, so the failure
      // goes straight to the block's failure exit rather than through the join.
      .outputs(xor(and(...gates.map(outPlace)), outPlace(exits.failed)))
      .action(async (tctx) => {
        const incoming = tctx.input(inPlace);
        const scope = scopeOf(tctx);

        // Decide, then emit ([EXEC-031]): the input is consumed and not restored on failure, so
        // everything that can throw happens here and writes nothing.
        let verdicts: readonly GateToken[] | undefined;
        let error: unknown;
        try {
          const selected = await selectArms(entry.id, n, scope, incoming.data, path);
          verdicts = arms.map((arm, i) => gateVerdict(selected.has(i), scope.getStepResult(arm.id), incoming.data));
        } catch (e) {
          error = e;
        }

        if (verdicts === undefined) {
          tctx.output(exits.failed, { stepId: entry.id, error });
          return;
        }
        for (let i = 0; i < n; i++) tctx.output(gates[i]!, verdicts[i]!);
      })
      .build(),

    // One firing writes the arrival and the marker together. That is the race-freedom argument.
    Transition.builder(names.entryTransition(path, entry.id, 'collect-err'))
      .inputs(one(armErr))
      .outputs(and(outPlace(arrived), outPlace(errSeen)))
      .action(async (tctx) => {
        const failure = tctx.input(armErr);
        tctx.output(arrived, { status: 'failed' });
        tctx.output(errSeen, failure);
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'collect-susp'))
      .inputs(one(armSusp))
      .outputs(and(outPlace(arrived), outPlace(suspSeen)))
      .action(async (tctx) => {
        const suspension = tctx.input(armSusp);
        tctx.output(arrived, { status: 'suspended' });
        tctx.output(suspSeen, suspension);
      })
      .build(),

    // A bail inside an arm does not end the run: Mastra lets it fall through to the block's
    // success branch and leaves it out of the block's output (`handlers/control-flow.ts:616-624`).
    Transition.builder(names.entryTransition(path, entry.id, 'collect-bail'))
      .inputs(one(armBail))
      .outputs(outPlace(arrived))
      .action(async (tctx) => {
        tctx.input(armBail);
        tctx.output(arrived, { status: 'settled' });
      })
      .build(),

    // Likewise a paused nested workflow: not failed, not suspended, so it reaches the success
    // branch and contributes nothing to the block's output.
    Transition.builder(names.entryTransition(path, entry.id, 'collect-pause'))
      .inputs(one(armPause))
      .outputs(outPlace(arrived))
      .action(async (tctx) => {
        tctx.input(armPause);
        tctx.output(arrived, { status: 'settled' });
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'join-fail'))
      // `all` takes every failure and the reset drains every suspension: failed outranks
      // suspended, and neither marker may outlive the block.
      .inputs(exactly(n, arrived), all(errSeen))
      .reset(suspSeen)
      .outputs(outPlace(exits.failed))
      .action(async (tctx) => {
        // The failure Mastra reports is `results.find(r => r.status === 'failed')` over an array
        // in arm order (`handlers/control-flow.ts:596`): the lowest arm index, not the first in
        // time. An arm is one step, so a failure's `stepId` is its arm's id. The token goes on
        // unchanged, `tripwire` included, so a tripwire still ends the run as `'tripwire'`.
        tctx.output(exits.failed, lowest(tctx.inputs(errSeen), (f) => firstIndex(arms, f.stepId)));
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'join-susp'))
      .inputs(exactly(n, arrived), all(suspSeen))
      .inhibitor(errSeen)
      .outputs(outPlace(exits.suspended))
      .action(async (tctx) => {
        // `results.find(r => r.status === 'suspended')`: the lowest arm index again. A suspension
        // carries the arm's path, whose last segment is the arm's index — exact even when two
        // arms share a step id.
        tctx.output(exits.suspended, lowest(tctx.inputs(suspSeen), (s) => armIndexOf(s, path, arms)));
      })
      .build(),

    Transition.builder(names.entryTransition(path, entry.id, 'join-ok'))
      .inputs(exactly(n, arrived))
      .inhibitors(errSeen, suspSeen)
      .outputs(outPlace(next))
      .action(ctx.nextIsResult ? blockOutput(arrived, arms, next) : nextEntryInput(arrived, arms, next))
      .build(),
  );

  return { inPlace, transitions };
};

/**
 * Asks the runner which arms are truthy, and refuses an answer that cannot be one.
 *
 * Returned as a set: Mastra keeps an arm iff `truthyIndexes.includes(index)`, so an index named
 * twice selects its arm once. Every error names the entry, so a run that fails here says which
 * `.branch()` broke.
 */
async function selectArms(
  entryId: string,
  n: number,
  scope: RunScope,
  input: unknown,
  path: EntryPath,
): Promise<ReadonlySet<number>> {
  const select = scope.runner.selectBranches;
  if (select === undefined) {
    throw new Error(
      `branch '${entryId}' needs a runner with selectBranches(entryId, input, view), and this run's ` +
        'runner has none. .branch() is inclusive: the engine needs the set of truthy arms, not one choice.',
    );
  }

  let chosen: unknown;
  try {
    chosen = await select.call(scope.runner, entryId, input, viewOf(scope, path));
  } catch (cause) {
    throw new Error(`branch '${entryId}': selectBranches threw: ${messageOf(cause)}`, { cause });
  }

  if (!Array.isArray(chosen)) {
    throw new Error(`branch '${entryId}': selectBranches returned ${describe(chosen)}, not an array of arm indexes`);
  }
  const selected = new Set<number>();
  for (const index of chosen as readonly unknown[]) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= n) {
      throw new Error(
        `branch '${entryId}': selectBranches returned arm index ${describe(index)}, outside 0..${n - 1}. ` +
          'An index that names no arm would silently skip the arm it was meant for.',
      );
    }
    selected.add(index);
  }
  return selected;
}

/**
 * One arm's verdict. A truthy arm whose id already holds a `success` result is reused rather than
 * run: `executeConditional` returns the stored result for any id already `success` or `failed`
 * (`handlers/control-flow.ts:552-553`). A stored `failed` cannot be reached on a start or a
 * resume — any earlier failure has already ended the run — so only `success` is reproduced
 * (`docs/divergences.md`).
 */
function gateVerdict(truthy: boolean, earlier: StepOutcome | undefined, data: unknown): GateToken {
  if (!truthy) return { decision: 'skip' };
  if (earlier?.status === 'success') return { decision: 'reuse', output: earlier.output };
  return { decision: 'run', data };
}

/**
 * The block's own output, which is the run's result when the block is the last entry: the arms
 * that arrived `ok` in this block, keyed by arm id, in arm order. Bailed, paused and skipped arms
 * are absent (`handlers/control-flow.ts:616-624`).
 *
 * Built with `Object.fromEntries`: arm ids are user strings, and `record['__proto__'] = value`
 * would call the prototype setter instead of creating a key. Two arms sharing an id collapse to
 * the later one, as Mastra's `acc[id] = ...` does.
 */
function blockOutput(
  arrived: Place<ArmArrival>,
  arms: readonly StepDescription[],
  next: Place<FlowToken>,
): TransitionAction {
  return async (tctx) => {
    const byIndex = new Map<number, unknown>();
    for (const arrival of tctx.inputs(arrived)) {
      if (arrival.status === 'ok') byIndex.set(arrival.index, arrival.data);
    }
    const entries: (readonly [string, unknown])[] = [];
    arms.forEach((arm, i) => {
      if (byIndex.has(i)) entries.push([arm.id, byIndex.get(i)]);
    });
    tctx.output(next, { data: Object.fromEntries(entries) });
  };
}

/**
 * What Mastra hands the entry after a `.branch()`: `getStepOutput` over **every declared arm**,
 * each read from the step results (`default.ts:1141-1149`) — not from this block's arrivals. So a
 * bailed arm carries its bail payload, a paused or skipped arm is present as `undefined`, and a
 * skipped arm whose id ran earlier in the workflow carries that earlier output.
 */
function nextEntryInput(
  arrived: Place<ArmArrival>,
  arms: readonly StepDescription[],
  next: Place<FlowToken>,
): TransitionAction {
  return async (tctx) => {
    // Consumed by the input spec; the values are deliberately not what goes on.
    tctx.inputs(arrived);
    const scope = scopeOf(tctx);
    tctx.output(next, {
      data: Object.fromEntries(arms.map((arm) => [arm.id, outputOf(scope.getStepResult(arm.id))] as const)),
    });
  };
}

/**
 * Mastra's `stepResults[id]?.output`. Only a success and a bail carry `output` in Mastra's
 * records; a suspension's value is `suspendOutput`, a different field, so it reads as `undefined`.
 */
function outputOf(outcome: StepOutcome | undefined): unknown {
  if (outcome === undefined) return undefined;
  return outcome.status === 'success' || outcome.status === 'bailed' ? outcome.output : undefined;
}

/** The first arm carrying `stepId` — `Infinity` for an id that is no arm's, which then loses. */
function firstIndex(arms: readonly StepDescription[], stepId: string): number {
  const index = arms.findIndex((arm) => arm.id === stepId);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/** The arm a suspension came from: its path's segment below the block, else its step id. */
function armIndexOf(suspension: SuspendToken, blockPath: EntryPath, arms: readonly StepDescription[]): number {
  const segment = suspension.path.length === blockPath.length + 1 ? suspension.path[blockPath.length] : undefined;
  return segment ?? firstIndex(arms, suspension.stepId);
}

/** The token with the lowest arm index; ties keep arrival order. `tokens` is never empty. */
function lowest<T>(tokens: readonly T[], indexOf: (token: T) => number): T {
  let best = tokens[0] as T;
  let bestIndex = indexOf(best);
  for (const token of tokens.slice(1)) {
    const index = indexOf(token);
    if (index < bestIndex) {
      best = token;
      bestIndex = index;
    }
  }
  return best;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : describe(error);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'symbol' || typeof value === 'function' || typeof value === 'bigint') return String(value);
  if (value instanceof Set) return 'a Set';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
