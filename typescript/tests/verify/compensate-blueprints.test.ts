/**
 * **`compensate` composes** ([ADR 0017], amended by the W0 spike; with [ADR 0006], [ADR 0010],
 * [ADR 0012], [ADR 0013]): the W0 fixture matrix, built through `init()`'s factories — the Layer 3
 * surface an author writes, `createStep({ …, compensate: undo })` chained with `.then()` — and proven
 * through `verifyMastraWorkflow`, so the net proven is the one `PetriExecutionEngine.execute()`
 * compiles: the adapter's compensator description (the parent's `retryConfig`, the compensator's own
 * `retries`, `timeout` and `uses`), the engine's own run budget, a marked checkpoint.
 *
 * `tests/verify/compensate.test.ts` proves the ladder from hand-written descriptions (m1, m2, m3, m2
 * beside `foreach(2)`) and holds the arc rules S1–S8 with a mutant each; this file proves what the
 * adapter makes of the author's workflow, and adds the W0 shapes that file proves only structurally:
 * retries, a run budget, timeouts, a timed retry, a checkpoint before `k_1`, `parallel(3)`, a
 * `limit(1)` shared by a compensator and a forward step (one quota, row 116's composition), a
 * compensator inheriting the workflow's `retryConfig.attempts`, and the chains `[u_1*, …, u_m*, z]`
 * for m = 1, 2, 5, 12 that the Amendment's per-compensator cost is measured on.
 *
 * Per shape:
 *
 * - the compiled ladder: `m`, each rung's compensated entry `k_j`, its compensator's id, naming path
 *   `[n + j - 1]` and view path `[k_j]`, attempts and timeout funnels as the adapter described them;
 *   the delayed transitions (a timed net only where a retry delay is); the pools and their takers;
 * - places / transitions against the ADR Amendment's W0 figure *as annotated*: one place and one
 *   transition fewer per compensator (amendment 3, five compensator exits, not six). The limit shape
 *   is not in the Amendment (it is m2 plus the quota place, as the budget shape is); `[a*,parallel(3),
 *   c*,d]` is in it by classes only, so its P/T is pinned as measured;
 * - every claim of all four families holds, by verdict — a proof `proven`, a liveness witness
 *   `violated` with its run confirmed — and the claim count is the Amendment's less one bound a
 *   compensator a segment (the place amendment 3 removed);
 * - the segment list, pinned: `closed`, `cancel`, `resume@s[+cancel]` per resume site, and
 *   `restart@p[+cancel]` per top-level boundary; completion, bounds and exclusion in every one,
 *   liveness in `closed` only (`verify` asks it there);
 * - each segment's seed is one token in `wf.comp.level.a`, `a = |{j : k_j < at}|`, counted here from the
 *   segment's own start, not through `ladderLevel`;
 * - C1–C4 present by name in every segment and holding by verdict: C1 `rolledBack` in the completion
 *   set over exactly `level.1..m` with `min = max = 0`; C2 `exclusive(level.j, wf.settle.failed)`,
 *   j = 1..m; C3 `exclusive(wf.comp.fault, ·)` over every top-level entry input, the five settle places
 *   and the six terminals; C4 `exclusive(wf.canceled, wf.comp.{failure,pending})` — and their
 *   provenance off `exclusions`, sourced from the ladder's declaration, exactly;
 * - every `wf.comp` place and every compensator place 1-bounded in every segment;
 * - every compensator attempt and timeout funnel a liveness target, witnessed: on an untimed net `u_1`
 *   by an executor run and every later compensator (and, with the checkpoint, both) by the verifier's
 *   enumeration — a confirmed model run with no host run behind it; on the timed net, by SMT (the W0
 *   Amendment's provenance);
 * - classes closed / cancel (`deadlockFree`'s enumeration) against the Amendment, which C4 makes
 *   meaningful: a cancel can arrive mid-rollback in every `+cancel` segment. On the timed net
 *   `deadlockFree` goes by SMT, and C4 is discharged structurally, as the Amendment recorded.
 *
 * Environment: `@mastra/core` from the pinned registry package; libpetri 8.0.0 from the registry, not
 * linked (`scripts/link-libpetri.sh --check`: "error: not linked: …/node_modules/libpetri"); z3 4.13.0
 * on PATH. Proven, per claim: property, segment, initial marking and route are printed for every
 * claim on failure (`describeClaim`); environment mode none (one closed net, the arrival modelled by
 * `t.cancel.arrive`, under VER-004 in-flight firing); 30 s a query — a proof that does not close in
 * that is a net to redesign, never a budget to raise — and 30 s of `verifyMastraWorkflow` wall a shape
 * (`WALL_MS`). Nothing here is run on Mastra: no runtime claim is made, tested or proven. The only
 * executor runs are `verify`'s own liveness witnesses on immediate nets (no clock involved). Two
 * assertions are timing-dependent, and only they: each claim's measured query time under 30 s, and
 * each shape's `verifyMastraWorkflow` wall under `WALL_MS` (30 s). Both are ceilings with about 5x
 * headroom over the slowest shape (the timed one, about 6 s); every other assertion is deterministic.
 *
 * Measured 2026-10-06, libpetri 8.0.0 from npm (not linked), z3 4.13.0, this file alone (9.6–9.7 s, 17 tests);
 * wall is `verifyMastraWorkflow`, slowest the one slowest query (ties of 1–4 ms move between runs):
 *
 * | Shape                                        | P / T    | Segments / claims | Classes closed / cancel | Wall   | Slowest query                               |
 * |----------------------------------------------|----------|-------------------|-------------------------|--------|---------------------------------------------|
 * | m1 `[a*,x,z]`                                | 34 / 37  | 14 / 1,075        | 31 / 96                 | 0.06 s | 3 ms deadlockFree, enumeration              |
 * | m2 `[a*,x,b*,z]`                             | 44 / 52  | 18 / 1,725        | 44 / 136                | 0.05 s | 2 ms deadlockFree @cancel, enumeration      |
 * | m3 `[a*,x,b*,y,c*,z]`                        | 55 / 69  | 26 / 3,220        | 58 / 179                | 0.09 s | 3 ms deadlockFree @cancel, enumeration      |
 * | m2, retries 2 (a, undo-a, x, undo-b, z)      | 64 / 72  | 18 / 3,607        | 64 / 196                | 0.09 s | 3 ms deadlockFree, enumeration              |
 * | m2 beside `foreach(2)` `[a*,each(2),b*,z]`   | 70 / 110 | 18 / 5,614        | 184 / 556               | 0.34 s | 34 ms deadlockFree @resume@1+cancel, enum.  |
 * | m2, run budget 1                             | 45 / 52  | 18 / 1,761        | 44 / 136                | 0.04 s | 2 ms deadlockFree @cancel, enumeration      |
 * | m2, `timeout` 50 on b and on undo-a          | 46 / 54  | 18 / 1,889        | 46 / 142                | 0.04 s | 2 ms deadlockFree, enumeration              |
 * | m2, timed (retry delay 5 ms on x and undo-b) | 48 / 56  | 18 / 2,051        | SMT (80 smt, 1,971 str.)| 5.5–6.1 s | 255–298 ms @cancel, smt (deadlockFree or exactlyOneTerminal) |
 * | m2, checkpoint at 0 before `k_1`             | 46 / 56  | 22 / 2,482        | 46 / 142                | 0.05 s | 2 ms deadlockFree @cancel, enumeration      |
 * | m2, `limit(1)` on b and on undo-a            | 45 / 52  | 18 / 1,761        | 44 / 136                | 0.04 s | 2 ms deadlockFree @cancel, enumeration      |
 * | `[a*,parallel(3),c*,d]`                      | 63 / 74  | 22 / 5,453        | 595 / 1,789             | 0.43 s | 62 ms deadlockFree @cancel, enumeration     |
 * | m2, `retryConfig.attempts` 2, undo-a inherits | 48 / 56 | 18 / 1,799        | 48 / 148                | 0.09 s | 4 ms deadlockFree @cancel, enumeration      |
 * | chain m1 `[a*,b]`                            | 33 / 35  | 10 / 678          | 30 / 93                 | 0.02 s | 1 ms deadlockFree @cancel, enumeration      |
 * | chain m2 `[a*,b*,c]`                         | 43 / 50  | 14 / 1,216        | 43 / 133                | 0.03 s | 1 ms deadlockFree @cancel, enumeration      |
 * | chain m5 `[a*,…,e*,f]`                       | 73 / 95  | 26 / 3,742        | 82 / 253                | 0.13 s | 4 ms deadlockFree @cancel, enumeration      |
 * | chain m12 `[a*,…,l*,m]`                      | 143 / 200| 54 / 14,956       | 173 / 533               | 0.85 s | 12 ms deadlockFree @cancel, enumeration     |
 * | no compensate `[a,b,c]` (the cost base)      | 16 / 17  | 14 / 556          | 13 / 40                 | 0.01 s | —                                           |
 *
 * Against the Amendment (W0, six compensator exits): P / T one fewer per compensator on every shape it
 * lists (m1 35 / 38, m2 46 / 54, m3 58 / 72, retries 66 / 74, foreach 72 / 112, budget 47 / 54,
 * timeouts 48 / 56, timed 50 / 58, checkpoint 48 / 58, and the W0 spike's chains m1 34 / 36, m2
 * 45 / 52, m5 78 / 100, m12 155 / 212); classes identical; claims one fewer a compensator a segment
 * (m2 1,761 → 1,725; m12 15,604 → 14,956). The chains pin the Amendment's cost line: the base 13 / 40,
 * the first compensator +17 / +53, each later one exactly +13 / +40, so m5 82 / 253 and m12 173 / 533
 * — checked against the formula and against the Amendment's literal figures; m12 verifies in under 1 s. The timed shape's slowest query moved from
 * `deadlockFree`@closed (254–304 ms) to `deadlockFree` or `exactlyOneTerminal` @cancel (255–298 ms over three runs). No query near 30 s,
 * so no shape was dropped and no redesign is called for.
 *
 * Each test names the src mutation that breaks it; each was applied in a scratch copy of
 * `typescript/` (never the live `src/`) and seen to fail the test there.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CompensationSite, CompiledWorkflow } from '../../src/compiler/types.js';
import { init } from '../../src/mastra/index.js';
import { compileMastraWorkflow, verifyMastraWorkflow } from '../../src/mastra/verify.js';
import {
  compensatorAttempts,
  describeClaim,
  exclusions,
  FAMILIES,
  livenessTargets,
  segmentInitialMarking,
  segmentLabel,
  type Segment,
  type VerificationReport,
} from '../../src/verify/index.js';
import { completionProperties } from '../../src/verify/properties.js';

const ANY = z.any();
const TIMEOUT_MS = 30_000;
/**
 * The per-query cap does not bound `verifyMastraWorkflow`'s wall (thousands of queries), so a shape's
 * wall has its own ceiling, and each `it` headroom above it, so a slow verdict fails on its message,
 * not on a vitest timeout. The slowest shape measured 5.5–6.1 s.
 */
const WALL_MS = 30_000;
const IT_MS = 45_000;

// ---------------------------------------------------------------------------------------------
// The workflow an author writes
// ---------------------------------------------------------------------------------------------

type Api = ReturnType<typeof init>;
type Options = Record<string, unknown>;

/** The factories a shape builds from: a pass-through step, a compensated one (`undo-<id>`), the workflow. */
function kit(api: Api, id: string, retryConfig?: { readonly attempts?: number; readonly delay?: number }) {
  const step = (sid: string, extra: Options = {}) =>
    api.createStep({ id: sid, inputSchema: ANY, outputSchema: ANY, ...extra, execute: async ({ inputData }) => inputData });
  /** `sid`, compensated by `undo-<sid>`; `own` its options, `undo` its compensator's. */
  const comp = (sid: string, own: Options = {}, undo: Options = {}) => step(sid, { ...own, compensate: step(`undo-${sid}`, undo) });
  const workflow = () => api.createWorkflow({ id, inputSchema: ANY, outputSchema: ANY, ...(retryConfig ? { retryConfig } : {}) });
  return { step, comp, workflow };
}

interface Rung {
  /** The compensator's id. */
  readonly stepId: string;
  /** `k_j`, the compensated entry's top-level index. */
  readonly k: number;
  /** Attempts as compiled, retries included. */
  readonly attempts: number;
  /** Timeout funnels as compiled: one per attempt when the compensator has a `timeout`. */
  readonly timeouts: number;
  /** How its liveness is witnessed (the W0 provenance): an executor run, the enumeration, or SMT. */
  readonly witness: 'execution' | 'enumeration' | 'smt';
}

interface Shape {
  readonly name: string;
  readonly build: () => { readonly workflow: Parameters<typeof verifyMastraWorkflow>[0]; readonly budget: boolean };
  /** Top-level entries, `n`. */
  readonly n: number;
  /** Resume-site keys, in `verify`'s order. */
  readonly resumes: readonly string[];
  readonly rungs: readonly Rung[];
  /** The Amendment's W0 places / transitions (six exits), or `undefined` where it lists none. */
  readonly w0?: readonly [number, number];
  /** Places / transitions as measured, where the Amendment has no figure. */
  readonly measured?: readonly [number, number];
  /** The Amendment's claim count (six exits); this net has `m` bounds a segment fewer. */
  readonly w0Claims?: number;
  /** Claims as measured, where the Amendment has no figure. */
  readonly measuredClaims?: number;
  /** `deadlockFree`'s state classes closed / cancel, or `'smt'` on a timed net. */
  readonly classes: readonly [number, number] | 'smt';
  /** Every delayed transition: a timed net only where a retry delay is. */
  readonly delayed: readonly string[];
  /** The `limit` pool's takers, when one is used. */
  readonly limitTakers?: readonly string[];
  /** A chain `[u_1*, …, u_m*, z]`: its `m`, so its classes are pinned to the cost line. */
  readonly chain?: number;
}

/** `verify`'s default segment labels: closed, cancel, each resume site, each top-level boundary, each ± cancel. */
const segmentsOf = (resumes: readonly string[], n: number): string[] => [
  'closed',
  'cancel',
  ...resumes.flatMap((s) => [`resume@${s}`, `resume@${s}+cancel`]),
  ...Array.from({ length: n }, (_, i) => [`restart@${i}`, `restart@${i}+cancel`]).flat(),
];
const tops = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i));

// ---------------------------------------------------------------------------------------------
// The matrix (ADR 0017's Amendment: the W0 spike's fixtures)
// ---------------------------------------------------------------------------------------------

/**
 * The design round's chain `[u_1*, …, u_m*, z]`: `m` compensated steps back to back, then one plain
 * one — the W0 spike's `cmp: m<m>` fixtures, the ones the Amendment's cost line is measured on.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function chain(m: number, w0: readonly [number, number], w0Claims: number): Shape {
  const ids = [...LETTERS.slice(0, m)];
  const n = m + 1;
  return {
    name: `chain m${m} [${ids.map((x) => `${x}*`).join(',')},${LETTERS[m]}]`,
    build: () => {
      const { step, comp, workflow } = kit(init(), `c${m}`);
      let wf = workflow().then(comp(ids[0]!));
      for (const x of ids.slice(1)) wf = wf.then(comp(x));
      return { workflow: wf.then(step(LETTERS[m]!)).commit(), budget: false };
    },
    n,
    resumes: tops(n),
    rungs: ids.map((x, i) => ({ stepId: `undo-${x}`, k: i, attempts: 1, timeouts: 0, witness: i === 0 ? 'execution' : 'enumeration' })),
    w0,
    w0Claims,
    classes: chainClasses(m),
    delayed: [],
    chain: m,
  };
}

/**
 * The Amendment's cost line: no compensation `[a,b,c]` is 13 / 40 classes closed / cancel; the first
 * compensator costs +17 / +53, each later one exactly +13 / +40 (m1 30 / 93, m2 43 / 133, m5 82 / 253,
 * m12 173 / 533). Every chain shape is pinned to this, and the base by its own test below.
 */
const BASE_CLASSES = [13, 40] as const;
const FIRST_COST = [17, 53] as const;
const LATER_COST = [13, 40] as const;
/** The Amendment's figures, literally, so the cost line above cannot drift from what it recorded. */
const AMENDMENT_CHAIN_CLASSES: Readonly<Record<number, readonly [number, number]>> = { 1: [30, 93], 2: [43, 133], 5: [82, 253], 12: [173, 533] };
function chainClasses(m: number): readonly [number, number] {
  return [BASE_CLASSES[0] + FIRST_COST[0] + (m - 1) * LATER_COST[0], BASE_CLASSES[1] + FIRST_COST[1] + (m - 1) * LATER_COST[1]];
}

const SHAPES: readonly Shape[] = [
  {
    name: 'm1 [a*,x,z]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm1');
      return { workflow: workflow().then(comp('a')).then(step('x')).then(step('z')).commit(), budget: false };
    },
    n: 3,
    resumes: tops(3),
    rungs: [{ stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' }],
    w0: [35, 38],
    w0Claims: 1_089,
    classes: [31, 96],
    delayed: [],
  },
  {
    name: 'm2 [a*,x,b*,z]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2');
      return { workflow: workflow().then(comp('a')).then(step('x')).then(comp('b')).then(step('z')).commit(), budget: false };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [46, 54],
    w0Claims: 1_761,
    classes: [44, 136],
    delayed: [],
  },
  {
    name: 'm3 [a*,x,b*,y,c*,z]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm3');
      return {
        workflow: workflow().then(comp('a')).then(step('x')).then(comp('b')).then(step('y')).then(comp('c')).then(step('z')).commit(),
        budget: false,
      };
    },
    n: 6,
    resumes: tops(6),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
      { stepId: 'undo-c', k: 4, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [58, 72],
    w0Claims: 3_298,
    classes: [58, 179],
    delayed: [],
  },
  {
    // The W0 fixture: retries 2 on a, undo-a, x, undo-b and z, immediate (no delay).
    name: 'm2, retries 2 (immediate)',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2r');
      return {
        workflow: workflow()
          .then(comp('a', { retries: 2 }, { retries: 2 }))
          .then(step('x', { retries: 2 }))
          .then(comp('b', {}, { retries: 2 }))
          .then(step('z', { retries: 2 }))
          .commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 3, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 3, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [66, 74],
    w0Claims: 3_643,
    classes: [64, 196],
    delayed: [],
  },
  {
    name: 'm2 beside foreach(2) [a*,each(2),b*,z]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2f');
      return { workflow: workflow().then(comp('a')).foreach(step('item'), { concurrency: 2 }).then(comp('b')).then(step('z')).commit(), budget: false };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [72, 112],
    w0Claims: 5_650,
    classes: [184, 556],
    delayed: [],
  },
  {
    // `init({ concurrency: 1 })`: one step attempt in flight in the run, compensators included.
    name: 'm2, run budget 1',
    build: () => {
      const { step, comp, workflow } = kit(init({ concurrency: 1 }), 'm2k');
      return { workflow: workflow().then(comp('a')).then(step('x')).then(comp('b')).then(step('z')).commit(), budget: true };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [47, 54],
    w0Claims: 1_797,
    classes: [44, 136],
    delayed: [],
  },
  {
    // A step `timeout` compiles to an `xor` branch of an untimed net ([ADR 0013]).
    name: 'm2, timeout 50 ms on b and on undo-a',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2o');
      return {
        workflow: workflow().then(comp('a', {}, { timeout: 50 })).then(step('x')).then(comp('b', { timeout: 50 })).then(step('z')).commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 1, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [48, 56],
    w0Claims: 1_925,
    classes: [46, 142],
    delayed: [],
  },
  {
    // The workflow's `retryConfig.delay` reaches the compensator (`retries` its own, the delay the parent's).
    name: 'm2, timed (retry delay 5 ms on x and undo-b)',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2t', { delay: 5 });
      return {
        workflow: workflow().then(comp('a')).then(step('x', { retries: 1 })).then(comp('b', {}, { retries: 1 })).then(step('z')).commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'smt' },
      { stepId: 'undo-b', k: 2, attempts: 2, timeouts: 0, witness: 'smt' },
    ],
    w0: [50, 58],
    w0Claims: 2_087,
    classes: 'smt',
    delayed: ['t.1.x.retry-1', 't.5.undo-b.retry-1'],
  },
  {
    // A marked checkpoint before k_1 (decision 4 A refuses one at or after it): `[w,a*,x,b*,z]`.
    name: 'm2, checkpoint at 0 before k_1 [w,a*,x,b*,z]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2c');
      return {
        workflow: workflow().then(step('w', { metadata: { checkpoint: true } })).then(comp('a')).then(step('x')).then(comp('b')).then(step('z')).commit(),
        budget: false,
      };
    },
    n: 5,
    resumes: tops(5),
    rungs: [
      { stepId: 'undo-a', k: 1, attempts: 1, timeouts: 0, witness: 'enumeration' },
      { stepId: 'undo-b', k: 3, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    w0: [48, 58],
    w0Claims: 2_526,
    classes: [46, 142],
    delayed: [],
  },
  {
    // One `limit(1)` used by the forward step b and by undo-a, the compensator of an earlier step:
    // one quota, so the rollback after b fails waits on what b returned. Not in the Amendment.
    name: 'm2, limit(1) shared by b and undo-a',
    build: () => {
      const api = init();
      const gpu = api.limit(1, { id: 'gpu' });
      const { step, comp, workflow } = kit(api, 'm2q');
      return {
        workflow: workflow().then(comp('a', {}, { uses: [gpu] })).then(step('x')).then(comp('b', { uses: [gpu] })).then(step('z')).commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    measured: [45, 52],
    measuredClaims: 1_761,
    classes: [44, 136],
    delayed: [],
    limitTakers: ['t.2.b.run', 't.4.undo-a.run'],
  },
  {
    // The Amendment lists this shape by classes only (595 / 1,789, no checkpoint).
    name: '[a*,parallel(3),c*,d]',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2p');
      return {
        workflow: workflow().then(comp('a')).parallel([step('b1'), step('b2'), step('b3')]).then(comp('c')).then(step('d')).commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: ['0', '1.0', '1.1', '1.2', '2', '3'],
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 1, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-c', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    measured: [63, 74],
    measuredClaims: 5_453,
    classes: [595, 1_789],
    delayed: [],
  },
  {
    // The workflow's `retryConfig.attempts` reaches a compensator with no `retries` of its own
    // (`step.retries ?? retryConfig.attempts`, handlers/step.ts:314): undo-a runs three times; every
    // other step sets `retries: 0`, which beats the workflow's (`??`, not `||`), undo-b included.
    // Immediate: no `delay`. Not in the Amendment.
    name: 'm2, retryConfig.attempts 2 inherited by undo-a only',
    build: () => {
      const { step, comp, workflow } = kit(init(), 'm2w', { attempts: 2 });
      const none = { retries: 0 };
      return {
        workflow: workflow().then(comp('a', none)).then(step('x', none)).then(comp('b', none, none)).then(step('z', none)).commit(),
        budget: false,
      };
    },
    n: 4,
    resumes: tops(4),
    rungs: [
      { stepId: 'undo-a', k: 0, attempts: 3, timeouts: 0, witness: 'execution' },
      { stepId: 'undo-b', k: 2, attempts: 1, timeouts: 0, witness: 'enumeration' },
    ],
    measured: [48, 56],
    measuredClaims: 1_799,
    classes: [48, 148],
    delayed: [],
  },
  // The chains: m = 1, 2 (the cost line's first two points), 5 and 12 (ADR 0017's Evidence planned).
  chain(1, [34, 36], 688),
  chain(2, [45, 52], 1_244),
  chain(5, [78, 100], 3_872),
  chain(12, [155, 212], 15_604),
];

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Every claim holds, by verdict: `proven` for a proof, a confirmed witness for liveness. */
function expectHolds(report: VerificationReport): void {
  expect(report.families).toEqual([...FAMILIES]);
  for (const c of report.claims) {
    const line = describeClaim(c);
    if (c.kind === 'proof') expect(c.result.verdict.type, line).toBe('proven');
    else {
      expect(c.result.verdict.type, line).toBe('violated');
      expect(c.result.counterexampleConfirmed, line).toBe(true);
    }
    expect(c.result.elapsedMs, line).toBeLessThan(TIMEOUT_MS);
    expect(c.holds, line).toBe(true);
  }
  expect(report.holds).toBe(true);
}

const siteOf = (compiled: CompiledWorkflow): CompensationSite => {
  const site = compiled.compensations;
  if (site === undefined) throw new Error(`'${compiled.net.name}' has no compensation site: the adapter dropped compensate`);
  return site;
};

/** The top-level index a segment starts at, read off the segment itself. */
const startOf = (segment: Segment): number =>
  typeof segment === 'string' ? 0 : 'restart' in segment ? segment.restart : Number(segment.resume.split('.')[0]);

/** `State classes: N` from a `deadlockFree` report on the enumeration route. */
function classes(report: VerificationReport, segment: string): number {
  const c = report.claims.find((x) => x.property === 'deadlockFree' && segmentLabel(x.segment) === segment);
  expect(c?.result.route, `deadlockFree@${segment}`).toBe('enumeration');
  const m = /State classes: (\d+)/.exec((c!.result as { readonly report?: string }).report ?? '');
  if (m === null) throw new Error(`no class count on deadlockFree@${segment}`);
  return Number(m[1]);
}

/** Claims, wall, classes and slowest query, for the report line (and `$PROOF_LOG` when set). */
function timing(name: string, compiled: CompiledWorkflow, report: VerificationReport, ms: number, cls: string): string {
  const slowest = [...report.claims].sort((a, b) => b.result.elapsedMs - a.result.elapsedMs)[0]!;
  const routes = new Map<string, number>();
  for (const c of report.claims) routes.set(c.result.route, (routes.get(c.result.route) ?? 0) + 1);
  return `[compensate-blueprints] ${name}: P/T ${compiled.net.places.size}/${compiled.net.transitions.size}; ${report.segments.length} segments, ` +
    `${report.claims.length} claims hold in ${ms.toFixed(0)}ms; classes ${cls}; routes ${[...routes].map(([r, n]) => `${r} ${n}`).join(', ')}; ` +
    `slowest ${slowest.result.elapsedMs.toFixed(1)}ms ${slowest.property} @${segmentLabel(slowest.segment)} via ${slowest.result.route}`;
}

describe('verify() on compensate through init(): every claim holds in every default segment, C1–C4 included', () => {
  for (const shape of SHAPES) {
    // Breaks if (each applied in a scratch copy of src/, never the live tree, and seen to fail there):
    // - every shape: the adapter dropping a step's `compensate` (adapt.ts; no site); C1 `rolledBack`
    //   left out of `completionProperties` (properties.ts); the ladder no longer declaring C2, the
    //   terminals among C3's targets, or C4's `pending` pair (blueprints/compensate.ts; counts and
    //   provenance); C3 handed only the first entry input (compile.ts `entryInputs`); `ladderLevel`
    //   seeding `level.0` from every start (blueprints/compensate.ts; the seed pin); compensators left
    //   out of the liveness targets (claims.ts); a compensator emitted with the cancel signal
    //   (compile.ts; one transition more, so the P/T pin, before S5);
    // - the retrying and timed shapes: the adapter dropping a compensator's `retries`;
    // - the timed shape: the adapter dropping a compensator's retry delay (the parent's `retryConfig`);
    // - the timeout shape: the adapter dropping a compensator's `timeout`;
    // - the retryConfig shape: the adapter ignoring the workflow's `retryConfig.attempts` for a
    //   compensator (adapt.ts; undo-a's attempts pin);
    // - the limit shape: the adapter dropping a compensator's `uses`;
    // - the budget shape: `verifyMastraWorkflow` ignoring its engine's budget (mastra/verify.ts);
    // - the checkpoint shape: the checkpoint sweep's cancel sent to `wf.canceled`, not intercepted
    //   (compile.ts);
    // and, without a mutant, any query past 30 s (`unknown` is not `proven`).
    it(shape.name, { timeout: IT_MS }, async () => {
      const { workflow, budget } = shape.build();
      const compiled = compileMastraWorkflow(workflow);
      const site = siteOf(compiled);
      const m = shape.rungs.length;

      // The ladder the adapter described: rung by rung, as compiled.
      expect(site.m).toBe(m);
      expect(site.levels).toEqual(Array.from({ length: m + 1 }, (_, j) => `wf.comp.level.${j}`));
      expect(compiled.entries).toHaveLength(shape.n);
      expect(site.compensators.map((u) => ({ j: u.j, k: u.k, stepId: u.stepId, path: [...u.path], viewPath: [...u.viewPath] }))).toEqual(
        shape.rungs.map((r, i) => ({ j: i + 1, k: r.k, stepId: r.stepId, path: [shape.n + i], viewPath: [r.k] })),
      );
      for (const [i, r] of shape.rungs.entries()) {
        const u = site.compensators[i]!;
        expect(u.forwardId, r.stepId).toBe(r.stepId.replace(/^undo-/, ''));
        const chain = compiled.steps.find((st) => st.path.length === 1 && st.path[0] === shape.n + i);
        expect(chain?.stepId, r.stepId).toBe(r.stepId);
        expect([chain!.attempts.length, chain!.timeouts.length], r.stepId).toEqual([r.attempts, r.timeouts]);
        expect([...u.attempts], r.stepId).toEqual([...chain!.attempts]);
      }
      expect([...compiled.net.transitions].filter((t) => t.timing.type !== 'immediate').map((t) => t.name).sort()).toEqual([...shape.delayed].sort());
      expect(compiled.pools.some((p) => p.kind === 'permits')).toBe(budget);
      const limit = compiled.pools.find((p) => p.kind === 'limit');
      if (shape.limitTakers === undefined) expect(limit).toBeUndefined();
      else expect([...limit!.takers].sort()).toEqual([...shape.limitTakers].sort());

      // Places / transitions: the Amendment's W0 figure less one of each a compensator (five exits).
      const pt = [compiled.net.places.size, compiled.net.transitions.size];
      if (shape.w0 !== undefined) expect(pt, 'W0 P/T less one a compensator').toEqual([shape.w0[0] - m, shape.w0[1] - m]);
      else expect(pt, 'P/T as measured').toEqual([...shape.measured!]);

      const t0 = performance.now();
      const verification = await verifyMastraWorkflow(workflow, { timeoutMs: TIMEOUT_MS });
      const ms = performance.now() - t0;
      const report = verification.workflow;
      const cls = shape.classes === 'smt' ? 'smt' : `${classes(report, 'closed')}/${classes(report, 'cancel')}`;
      const line = timing(shape.name, compiled, report, ms, cls);
      console.log(line);
      const log = process.env['PROOF_LOG'];
      if (log) appendFileSync(log, `${line}\n`);

      expect(Object.keys(verification.nested)).toEqual([]);
      expect(ms, `${shape.name}: verifyMastraWorkflow wall`).toBeLessThan(WALL_MS);
      expect(report.k).toBe(budget ? 1 : 'unbounded');
      expectHolds(report);
      expect(verification.holds).toBe(true);
      expect(report.structuralHash).toBe(compiled.structuralHash);

      // Every default segment proven, none quietly dropped.
      const labels = segmentsOf(shape.resumes, shape.n);
      expect(report.segments.map(segmentLabel)).toEqual(labels);
      if (shape.w0Claims !== undefined) expect(report.claims.length, 'W0 claims less one bound a compensator a segment').toBe(shape.w0Claims - m * labels.length);
      else expect(report.claims.length, 'claims as measured').toBe(shape.measuredClaims);

      // Each segment's seed: one token in level.a, a = |{j : k_j < start}| — counted here, not by ladderLevel.
      for (const segment of report.segments) {
        const at = startOf(segment);
        const a = shape.rungs.filter((r) => r.k < at).length;
        const seeded = [...segmentInitialMarking(compiled, segment)].filter(([p]) => p.name.startsWith('wf.comp.')).map(([p, n]) => [p.name, n]);
        expect(seeded, segmentLabel(segment)).toEqual([[`wf.comp.level.${a}`, 1]]);
      }

      // Families: completion, bounds and exclusion in every segment; liveness in closed only.
      for (const label of labels) {
        const families = new Set(report.claims.filter((c) => segmentLabel(c.segment) === label).map((c) => c.family));
        expect([...families].sort(), label).toEqual((label === 'closed' ? [...FAMILIES] : FAMILIES.filter((f) => f !== 'liveness')).sort());
      }

      // C1–C4, by name in every segment (each already held by verdict above), counted.
      const t = compiled.terminals;
      const terminals = [t.done, t.failed, t.bailed, t.suspended, t.paused, t.canceled].map((p) => p.name);
      const settles = [...compiled.net.places].map((p) => p.name).filter((p) => p.startsWith('wf.settle.'));
      expect(settles, 'the five settle places').toHaveLength(5);
      const inputs = compiled.boundaries.map((b) => b.place.name);
      expect(inputs).toHaveLength(shape.n);
      const c2 = site.levels.slice(1).map((l) => `exclusive(${l},wf.settle.failed)`);
      const c3 = [...inputs, ...settles, ...terminals].map((p) => `exclusive(${site.fault},${p})`);
      const c4 = [`exclusive(wf.canceled,${site.failure})`, `exclusive(wf.canceled,${site.pending})`];
      expect(new Set(c3).size).toBe(shape.n + 5 + 6);
      const proven = (re: RegExp): number => report.claims.filter((c) => re.test(c.property) && c.result.verdict.type === 'proven').length;
      expect(proven(/^rolledBack$/), 'C1').toBe(labels.length);
      expect(proven(/^exclusive\(wf\.comp\.level\.[1-9]\d*,wf\.settle\.failed\)$/), 'C2').toBe(labels.length * m);
      expect(proven(/^exclusive\(wf\.comp\.fault,/), 'C3').toBe(labels.length * (shape.n + 5 + 6));
      expect(proven(/^exclusive\(wf\.canceled,wf\.comp\.(failure|pending)\)$/), 'C4').toBe(labels.length * 2);
      for (const label of labels) {
        const at = new Set(report.claims.filter((c) => segmentLabel(c.segment) === label).map((c) => c.property));
        for (const p of ['rolledBack', ...c2, ...c3, ...c4]) expect(at.has(p), `${p} @${label}`).toBe(true);
      }
      for (const segment of report.segments) {
        // C1 over exactly level.1..m, none at rest: level.0 is the empty stack, a level left out an unchecked rung.
        const c1 = completionProperties(compiled, segment).find(([p]) => p === 'rolledBack')?.[1];
        expect(c1 !== undefined && c1.type === 'quiescent-count' && { places: c1.places.map((p) => p.name).sort(), min: c1.min, max: c1.max }, segmentLabel(segment)).toEqual({
          places: site.levels.slice(1).sort(),
          min: 0,
          max: 0,
        });
      }
      // Provenance: C2–C4 are the ladder's declaration, sourced from it, exactly — nothing else
      // claims an exclusion on a `wf.comp` place.
      const key = (a: string, b: string): string => `exclusive(${a},${b})`;
      const ladder = exclusions(compiled).filter((e) => /^C[234]\b/.test(e.why));
      expect(ladder.every((e) => e.source === 'gadget')).toBe(true);
      expect(ladder.map((e) => key(e.a.name, e.b.name)).sort()).toEqual([...c2, ...c3, ...c4].sort());
      // (The barrier's own pairs reach `wf.comp.exit.done`, the last entry's `next`: entry, not ladder.)
      const onLadder = exclusions(compiled).filter((e) => e.source !== 'barrier' && (e.a.name.startsWith('wf.comp.') || e.b.name.startsWith('wf.comp.')));
      expect(onLadder.map((e) => key(e.a.name, e.b.name)).sort()).toEqual([...c2, ...c3, ...c4].sort());

      // Every ladder and compensator place 1-bounded, in every segment.
      const places = [...compiled.net.places].map((p) => p.name);
      const ladderPlaces = places.filter((p) => p.startsWith('wf.comp.'));
      const compensatorPlaces = site.compensators.flatMap((u) => places.filter((p) => p.startsWith(`s.${u.path[0]}.${u.stepId}.`)));
      for (const u of site.compensators) expect(places.filter((p) => p.startsWith(`s.${u.path[0]}.${u.stepId}.`)).length, u.stepId).toBeGreaterThan(0);
      for (const label of labels) {
        const at = new Set(report.claims.filter((c) => segmentLabel(c.segment) === label).map((c) => c.property));
        for (const p of [...ladderPlaces, ...compensatorPlaces]) expect(at.has(`bound(${p}<=1)`), `bound(${p}<=1) @${label}`).toBe(true);
      }

      // Every compensator attempt and timeout funnel live, witnessed as the Amendment recorded.
      const targets = new Set(livenessTargets(compiled).map((x) => x.transition));
      expect([...compensatorAttempts(compiled)].sort()).toEqual(site.compensators.flatMap((u) => [...u.attempts]).sort());
      for (const [i, r] of shape.rungs.entries()) {
        const chain = compiled.steps.find((st) => st.path.length === 1 && st.path[0] === shape.n + i)!;
        for (const target of [...chain.attempts, ...chain.timeouts]) {
          expect(targets.has(target), target).toBe(true);
          const live = report.claims.find((c) => c.property === `live(${target})` && segmentLabel(c.segment) === 'closed');
          expect(live, `live(${target})`).toBeDefined();
          // A timeout funnel goes by the same route as its attempt: undo-a's by an executor run.
          expect(live!.result.route, describeClaim(live!)).toBe(r.witness);
        }
      }

      // Classes against the Amendment; on the timed net, SMT, and C4 discharged structurally.
      if (shape.classes === 'smt') {
        for (const label of ['closed', 'cancel']) {
          const c = report.claims.find((x) => x.property === 'deadlockFree' && segmentLabel(x.segment) === label);
          expect(c?.result.route, `deadlockFree@${label}`).toBe('smt');
        }
        for (const c of report.claims.filter((x) => c4.includes(x.property))) expect(c.result.route, describeClaim(c)).toBe('structural');
      } else {
        expect([classes(report, 'closed'), classes(report, 'cancel')]).toEqual([...shape.classes]);
      }
      // A chain: the cost line, and the Amendment's own figure for this m.
      if (shape.chain !== undefined) {
        expect(shape.classes, `chain m${shape.chain}: the cost line`).toEqual(chainClasses(shape.chain));
        expect(shape.classes, `chain m${shape.chain}: the Amendment`).toEqual(AMENDMENT_CHAIN_CLASSES[shape.chain]);
      }
    });
  }

  // The cost line's base: no compensation, `[a,b,c]`, through the same path. No ladder, no C1–C4.
  // Breaks if: the base net changes under the compensate work (any extra `wf.comp` place or class).
  it('the cost base: [a,b,c] with no compensate is 13 / 40 classes and has no ladder', { timeout: IT_MS }, async () => {
    const { step, workflow } = kit(init(), 'c0');
    const wf = workflow().then(step('a')).then(step('b')).then(step('c')).commit();
    const compiled = compileMastraWorkflow(wf);
    expect(compiled.compensations).toBeUndefined();
    expect([...compiled.net.places].filter((p) => p.name.startsWith('wf.comp.'))).toEqual([]);
    expect([compiled.net.places.size, compiled.net.transitions.size]).toEqual([16, 17]);
    const verification = await verifyMastraWorkflow(wf, { timeoutMs: TIMEOUT_MS });
    const report = verification.workflow;
    expectHolds(report);
    expect(report.claims.length).toBe(556);
    expect(report.claims.some((c) => c.property === 'rolledBack')).toBe(false);
    expect([classes(report, 'closed'), classes(report, 'cancel')]).toEqual([...BASE_CLASSES]);
  });
});
