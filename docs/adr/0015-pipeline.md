# ADR 0015 — `pipeline()` compiles a `.foreach()` over a chain of stages into the parent net, one bound per stage, items handed lane to lane

Status: proposed (2026-10-05, M7b second wave). Maintainer decisions taken (below, each the
recommended option); the net to be measured by the W0 spike before W1.

## Context

README's blueprint table names `pipeline()` — "stage 2 of item 1 while stage 1 of item 2 runs" — as
the blueprint join-before-next-index rules out ([ADR 0002]), and [ADR 0006] puts pipelining in
Layer 3. The acceptance test is todo.md's: "`limit` inside `pipeline` is a bounded pipeline", with
no special-casing.

Mastra already overlaps stages across items: `.foreach(nestedWorkflow, { concurrency: W })` runs
each item as its own child run walking a, then b, then c, so with W ≥ 2 item 2's `a` overlaps item
1's `b`. What it cannot express:

1. a bound per stage (at most one `embed` at a time while `fetch` runs two);
2. the stages inside the parent's net — its proofs, its run budget, its quotas: a `limit` used in a
   child run is that child's own (row 101), so today a stage `limit` bounds nothing across items.

It does not buy overlap across two top-level `.foreach()` entries (H2, rejected: it breaks
one-entry-one-gadget, the checkpoint boundary of [ADR 0010], and on the twin `b` gets no records
once `a` fails — an outcome change where H1's twin matches).

The twin is a nested workflow per item, and its semantics are not the plain foreach's. Traced in
Mastra's sources:

| Behaviour | Plain `.foreach(step)` | `.foreach(nestedWorkflow)` — the twin |
|---|---|---|
| A step bails | the foreach exits (`control-flow.ts:1373`) | the child's `bailed` becomes `success` (`default.ts:926-928`); the item succeeds with the bail value (`workflow.ts:3116`) |
| A step pauses | the foreach exits | the child returns `undefined`: a hole |
| Cancel lands mid-item | the item keeps its outcome | the child's entry-end re-stamps it `canceled` (`handlers/entry.ts:815-817`), the parent reads `undefined`: a hole |
| Retries | `step.retries ?? retryConfig.attempts` (`handlers/step.ts:314`) | stages under the child's `{attempts: 0}` (`workflow.ts:1797`); the parent's `retryConfig` re-runs the **whole item** (a `Workflow` has no `retries`; `adapt.ts:769-782`) |
| `getInitData()` / `getStepResult()` in a stage | the run's | the item's own child run |
| State | live | a snapshot at item start (`workflow.ts:3006`), `Object.assign`-merged back when the item returns (`:3055`, `default.ts:709-713`) |
| Events | per step | the child's go to `nested-watch` under its own run id; the parent stream sees the foreach's start, one progress per item, the aggregate |

Three designs were weighed:

| | 1. user-built body | 2. minted stages, net-first | 3. minted stages, item-scoped |
|---|---|---|---|
| Surface | `pipeline(bodyWorkflow, { stages: {id: c} })`, W independent | `pipeline([a, b, c], { concurrency: [c…] })`, W = Σc | as 2 plus `stageConcurrency`, W independent |
| Lane path | `[i, j, l]` — fails suspension coverage (`structure.ts:196-199`) | `[i, L]`, L the flattened lane index | `[i, j, l]` |
| Cancel | hand-off gated only: a last-stage collect after the cancel writes the frame, where the twin leaves a hole | every frame-writing transition gated, a `drop` per lane exit: the twin | hand-off gated only |
| `exit` flag | kept | dropped (bail and pause never reach the foreach) | kept |
| Stage records | item-scoped | parent scope, last writer wins: a stage's `getStepResult(prev)` can read **another item's** record | item-scoped, state at twin parity |
| Suspend | refused by name, no site | refused by name, no site, coverage exemption plus a structure rule | a `ForeachSite.pipeline` flag — and a foreach site always emits `re-enter` (`foreach.ts:1068`), so a resume segment to prove |

## Decision

**Design 2's surface and net, design 3's item scope. `init()` returns `pipeline(stages, options)`,
which mints a petri nested workflow `stages[0] -> … -> stages[s-1]` and marks the `.foreach()` it is
spread into with a stage vector under a module-private symbol. On the petri engine the stages are
compiled into the parent net, c_j lanes per stage, and an item is handed lane to lane, so stage
j+1 of one item runs while stage j of another does. On `DefaultExecutionEngine` the mark is ignored
and the entry runs as `.foreach(nestedWorkflow, { concurrency: Σc_j })`, the twin.**

- **Surface.**
  ```ts
  const { createWorkflow, createStep, pipeline, limit } = init();
  const gpu = limit(1, { id: 'gpu' });
  const fetchDoc = createStep({ id: 'fetch', inputSchema: Url,  outputSchema: Html, execute });
  const embed    = createStep({ id: 'embed', inputSchema: Html, outputSchema: Vec,  execute, uses: [gpu] });
  const store    = createStep({ id: 'store', inputSchema: Vec,  outputSchema: Ref,  execute });

  createWorkflow({ id: 'ingest', inputSchema: z.array(Url), outputSchema: z.array(Ref) })
    .foreach(...pipeline([fetchDoc, embed, store], { id: 'per-doc', concurrency: [2, 1, 1] }))
    .then(report)
    .commit();
  ```
  `pipeline` is typed `<const S extends readonly [PetriStep, ...PetriStep[]]>(stages: S &
  Chained<S>, options: { id: string; concurrency?: number | { [K in keyof S]: number };
  description?; metadata? }) => [body, PipelineEntryOptions]`. `Chained<S>` is a type error unless
  stage j's output is assignable to stage j+1's input; a default-engine step is a type error, as
  for `race`. `id` is required: it is the minted body's id, the key Mastra's foreach records under
  (`getSingleStepEntryId(entry.step)`), and what `getStepOutput` and `restart-codec.ts:143` read.
  The returned options carry **no** `id`, so the entry has one id. `concurrency` — Mastra's word —
  is per stage, one number for every stage, default 1.
- **What the factory returns** (`mastra/pipeline.ts`, bound to `init()`'s `createWorkflow`).
  `body = createWorkflow({ id, inputSchema: S[0].inputSchema, outputSchema: last.outputSchema })
  .then(S[0])…then(S[s-1]).commit()`, no `retryConfig`. `options = { description?, concurrency:
  Σc_j, metadata: { ...user, [FOREACH_PIPELINE]: Pipeline { body, stages (frozen, by identity),
  bounds (frozen) } } }`. `concurrency` is always written, so Mastra keeps `opts` by reference
  (`workflow.ts:2630-2636`), and Σc_j is the twin's own Layer 1 bound. `Pipeline` has a private mint
  key, as `Decision` has. JSON drops the symbol, so the serialized graph stays a plain
  `{type:'foreach', opts:{concurrency}}`.
- **Refusals** (thrown at mint, repeated by the adapter against a forged or altered entry; added to
  `BLUEPRINT_REFUSALS`):

  | Refusal | When |
  |---|---|
  | `pipeline-empty` | no stages |
  | `pipeline-value` | a bound not a whole number ≥ 1; a bound vector whose length is not s; Σc_j above `MAX_FOREACH_LANES` (256); the entry's `opts.concurrency` not equal to Σc_j (a hand-altered entry, or a resolver function) |
  | `blueprint-arms` | a stage listed twice, two stages sharing an id, a stage that is a nested workflow (M8 compiles those); the entry's `step` not `{type:'step', step}` with `step === pipeline.body`; `body.stepGraph` not exactly s single-step entries matching the minted stages by kind (`blockDecision`'s matcher, factored into `matchMinted`: a step by identity, an agent or tool by id, ref and options identity) |
  | `blueprint-position` | the marker on any entry but `.foreach()`, or any blueprint marker on a stage's own metadata |
  | `blueprint-reused` | one `Pipeline` on two `.foreach()` entries |

  `refuseMisplacedDecision` becomes `refuseMisplacedBlueprints` over a table `{ BLOCK_DECISION:
  'parallel', FOREACH_PIPELINE: 'foreach' }`. `innerSteps` returns the stages of a marked foreach,
  so `checkpoint-position`, `concurrency-position` and `uses-position` see them ("a pipeline
  stage"). A user `metadata.concurrency` stays `concurrency-foreach`; `metadata.checkpoint` passes.
- **Adapter and IR.** In `case 'foreach'`, `pipelineOf(metadataOfEntry(entry))` drives the checks,
  then each stage goes through `adaptSingleStep` with the **parent's** options (decision 2), so
  `STEP_RESOURCES` quotas, `timeout` and `effectiveRetries` apply unchanged and a quota shared with a
  parent step is one quota. The foreach description gains `pipeline?: { stages: readonly
  StepDescription[]; bounds: readonly number[] }`; `body` stays the nested workflow's description
  (`source: 'workflow'`). `structuralHash` appends `{ pipeline: { stages, bounds } }` only when
  present. `foreachGadget` delegates to `pipelineGadget` (`compiler/blueprints/pipeline.ts`,
  host-free, an M10 candidate) as `parallelGadget` does to `firstKGadget`.
- **Net, per pipeline.** Stage j in [0, s), lane l in [0, c_j), flattened lane L = Σ_{i<j} c_i + l.
  Names through `names.entryPlace` / `entryTransition(path, id, role)` with roles
  `stage{j}.lane{l}.*`; each lane body is `ctx.emitNested(stages[j], [...path, L], done, out, {
  viewPath, item: true })`, viewed at the foreach's path, so the runner and suspension coverage keep
  the `[i, lane]` shape. Frame, cursor, complement flags, settle and finisher factories,
  `itemRecordOf` and `assemble` move out of `foreach.ts` into `compiler/gadgets/foreach-frame.ts`;
  the foreach net stays byte-identical (pinned by `structuralHash`, a name-and-arc snapshot and
  `foreach.test.ts`'s class counts).
  ```text
  places:  frame, queue.open (cursor {items, next}), queue.closed, no-fault/fault, no-susp/susp;
           per lane: stage{j}.lane{l}.permit, .slot {item, k, startedAt, scope}, .done,
           .failed, .bailed, .suspended, .paused, .canceled (unreachable, as foreach.ts:378-383).
           No exit pair, no resume place, no window pool.

  cancel                    ?cancel                         in -> exits.canceled            (sweep, as foreach)
  split                     ¬cancel   in -> xor(open(queue.open) | open(queue.closed) [no items] | exits.failed [not an array])
                                      open(q) = frame + q + no-fault + no-susp + every permit of every stage
  stage0.lane{l}.start      ¬cancel   queue.open + permit_{0,l}
                                      -> xor(body_{0,l}{item, k} + slot_{0,l} + queue.open | … + queue.closed)
  stage0.lane{l}.refuse     ?cancel   queue.open + permit_{0,l} -> queue.closed + permit_{0,l}
  stage{j}.lane{l}.to{m}    ¬cancel   done_{j,l} + slot_{j,l} + permit_{j+1,m}                    (j < s-1)
                                      -> body_{j+1,m}{done.data, k} + slot_{j+1,m} + permit_{j,l}
  stage{s-1}.lane{l}.collect ¬cancel  done + slot + frame -> frame(results[k] = output) + permit
  stage{j}.lane{l}.bail     ¬cancel   bailed + slot + frame -> frame(results[k] = bail output) + permit
  stage{j}.lane{l}.pause    ¬cancel   paused + slot + frame -> frame(hole) + permit
  stage{j}.lane{l}.{fail|suspend}[.queue-closed][.again]  ¬cancel, priority 1
                                      exit + slot + frame + queue.{open|closed} + {no-K|K}
                                      -> frame + permit + queue.closed + K       (4 variants, foreach.ts:595-663)
  stage{j}.lane{l}.drop.{done,failed,bailed,suspended,paused}  ?cancel   exit + slot -> permit
  join                      ¬cancel   queue.closed + frame + every permit + no-fault + no-susp -> next
  fail.{clean,s}            ¬cancel   queue.closed + frame + every permit + fault + {no-}susp   -> exits.failed
  suspend                   ¬cancel   queue.closed + frame + every permit + no-fault + susp     -> exits.suspended
  canceled.{clean,f,s,fs}   ?cancel   queue.closed + frame + every permit + both flags          -> exits.canceled
  ```
  Arcs on `cancel` exist only when a signal is given. Every place is 1-bounded. No pipeline place
  carries an inhibitor, reset, `all()`, drain or `atLeast()`: the only non-monotone place stays
  `wf.cancel`, so under [VER-004] the only split is `t.cancel.arrive`, the [ADR 0014] baseline. The
  item index is colour and the cursor's more/last `xor` is value-blind, so one proof covers every
  item count. The hand-off holds stage j's lane until a stage-(j+1) lane frees — hold-and-wait, but
  stage order is acyclic and the last stage collects, settles or drops unconditionally, and a
  waiting lane holds no run permit and no quota (the leaf returns both per attempt), so no circular
  wait; `deadlockFree` confirms it. A one-stage pipeline with c_0 = W compiles to the foreach net
  minus the exit pair: the differential fixture.
- **Item scope** (decision 3). `NestedOptions.item` makes the leaf read through an item store:
  `viewOf` overrides `initData` with the slot's item and `getStepResult` with
  `RunScope.itemRecords(path, k)`, and records there instead of `recordStepResult`. The store is
  forgotten at the item's collect, bail, pause, settle or drop. The runner's `#resolveStep` resolves
  a pipeline lane `[i, L]` to `body.stepGraph[stageOf(L)]`; a stage call is a child-run step — no
  `foreachIdx` lookup of the input (the input is the call's data), no fresh `nestedRunId`, no
  step-start or result events — and stage 0 validates against `body.inputSchema` before its own, as
  the twin's foreach validates the nested step. State follows decision 3.
- **Output.** `results[k] = output` when defined: input order with holes, as the foreach
  (`control-flow.ts:1189-1191`). The aggregate is written under the body id. Each item's
  `foreachOutput` entry is the twin's nested-step record, synthesized from the slot (item,
  `startedAt`) and the outcome token, without `metadata.nestedRunId` (row 35).
- **Order.** Stage 0 admits in input order through the cursor (fluid, as fastq). Later stages
  admit unordered: whichever ready lane and free permit pair fires. The twin's children are
  independent, so there is no order to reproduce; FIFO would cost a token per boundary and
  head-of-line blocking.
- **Failure.** A stage failure (tripwire included, forwarded whole) settles at priority 1: it takes
  the queue, puts back `queue.closed` and `fault`. Nothing new starts; items already admitted run
  every remaining stage, because hand-offs read no flag — as the twin's children never see
  `killQueue()`. Precedence after the drain is the foreach's minus exits: canceled, first failure in
  time (its own record is the aggregate), lowest suspended index.
- **Bail and pause.** A stage bail ends the item as a success carrying the bail output, later stages
  skipped, the queue untouched. A pause leaves a hole (unreachable in wave 1: `perStep` is refused,
  row 54, and nested-workflow stages are refused).
- **Cancel** ([ADR 0004]). `split`, `start`, every hand-off and every frame-writing collect and
  settle are inhibited; `refuse` closes the queue (the worker's check, `control-flow.ts:1157-1172`);
  each lane exit has a `drop` that returns the permit and writes nothing — the child's per-entry
  check (`default.ts:815`) and entry-end re-stamp (`handlers/entry.ts:815-817`) make every
  unsettled item a hole. A running stage is never interrupted; it sees the run signal as any step
  does. `canceled.*` reports the partial array.
- **Suspend** (decision 4). A stage suspension sets `susp` and closes the queue; the pipeline ends
  `suspended` at the lowest index with the foreach aggregate shape
  (`__workflow_meta.{foreachIndex, foreachOutput}`). No resume site is registered. `Run.resume` is
  refused by name at seed time: `compiler/resume.ts` gains `ResumeRefusal.reason 'pipeline'`,
  resolved from `CompiledWorkflow.pipelines`, and `engine.ts` its message beside `foreach-nested`.
  Lane attempts are exempt from `suspensionCoverageViolations` through `pipelineLaneAttempts`,
  documented as `decidingArmAttempts` is, and in exchange the structure check holds each suspended
  exit to its own settle or drop.
- **Restart** ([ADR 0010]). `metadata.checkpoint` on the pipeline entry is allowed; a restart re-runs
  the whole pipeline, items fresh (the twin's restart fails every item, row 96). A mark on a stage
  is `checkpoint-position`. A changed bound vector between crash and restart is accepted (row 97
  ignores metadata); the net is recompiled from current code.
- **Composition.** A stage's `uses` and `timeout` apply at the parent's run scope ([ADR 0012],
  [ADR 0013]): `limit(1)` on a stage with c_j = 2 is one attempt at a time across every item, with
  no special case. The run budget ([ADR 0006]) is taken per attempt after the lane permit, never
  while a lane waits at a hand-off. A race on a stage is `blueprint-position`; a pipeline inside a
  race arm or a loop body is `blueprint-position` (a foreach is top-level only).
- **Defaults** (stated, not open): c_j = 1; the item window is derived, W = Σc_j — no separate
  window option and no pool in wave 1, since a stage `limit` already narrows it; stages are steps,
  agents or tools; unordered later-stage admission; the hand-off is a rendezvous, no buffer
  (`queue(depth)` composes one later with `exactly(d, room)` count arcs, never an inhibitor).
- **Claims.**
  - *Proven* in every default segment (`closed` = `restart@0`, `cancel`, `restart@p` when
    checkpointed; no resume segment), by enumeration while every stage is immediate, each reported
    with property, initial marking, environment mode and route: `deadlockFree`,
    `exactlyOneTerminal`, never canceled unasked; `placeBound(·, 1)` on every pipeline place;
    `mutualExclusion(permit_{j,l}, slot_{j,l})` per lane — with both 1-bounded and one always
    marked, at most c_j items at stage j; `mutualExclusion(queue.open, fault)` (fail-fast),
    `(queue.open, susp)`, `(queue.open, queue.closed)` and each complement pair; the quota claims of
    any `limit` a stage uses (`placeBound(quota, n)`, conservation) — the composition acceptance.
  - *Proven reachable* — the overlap: `mutualExclusion(stage{j}.lane0.slot, stage{j+1}.lane0.slot)`
    asserted **`Violated`** with a counterexample, for each adjacent pair, on immediate fixtures
    with at least two items reachable. A verdict that is not a definitive `Violated` fails the test,
    so `Unknown` cannot pass. The two slots are different items because each item holds one slot
    (structure rule 3). Not claimed on timed fixtures (untimed abstraction).
  - *Witnessed* ([ADR 0009]): every stage attempt is already a `LivenessTarget` through
    `compiled.steps`; stage j+1's body has no producer but hand-offs, so a live stage-(j+1) attempt
    witnesses a hand-off. No new target kind.
  - *Checked from the arcs* (`verify/pipeline.ts`, `pipelineStructureViolations`, under "pipeline
    structure" in `properties.ts`, one mutant each): (1) each hand-off takes exactly `done_{j,l}`,
    `slot_{j,l}`, `permit_{j+1,m}`, inhibited by `wf.cancel`, and gives exactly `body_{j+1,m}`,
    `slot_{j+1,m}`, `permit_{j,l}`; (2) stage j+1's body has no producer but stage-j hand-offs,
    stage 0's none but `start`, and only `start` / `refuse` / settles take `queue.open`; (3) every
    transition consuming a slot produces at most one slot; (4) every lane exit has exactly one
    `¬cancel` consumer and one `drop` reading `cancel`; (5) every finisher takes every permit of
    every stage plus `queue.closed` and `frame`; (6) no pipeline place carries an inhibitor, reset
    or drain; (7) a suspended lane exit reaches only its own settle or drop. Mutants: a hand-off
    without the next permit; an inhibitor on `fault` added to a hand-off; a finisher missing a
    stage-1 permit; a collect without its drop.
  - *Tested, not proven*: output order and holes (value data); unordered later-stage admission;
    overlap under real timing (ManualClock); item-scoped `getStepResult` / `getInitData` / state;
    bail, failure-drain and cancel holes against the twin; the `limit(1)` peak across items.
    `retryCeilingViolations` unchanged (stages are ordinary leaves).

## Maintainer decisions

Taken 2026-10-05: 1 A, 2 A, 3 A, 4 A.

1. **Which reason makes `pipeline` Layer 3?** On success the twin gives the same array.
   - A. The stages run in the parent's run, not as child runs: they must be petri steps compiled at
     parent scope (the brand's job), and the visible consequences — retries per stage, quotas
     binding across items, resume refused, no child runs — follow (rows 112-117).
   - B. The outcome changes alone (rows 113, 116, 117).
   - C. Layer 2: a string `metadata.stages` on a foreach over a nested workflow, no brand.

   **Recommended: A.** It holds on every path, success included; B's differences are real but are
   consequences; C fails because the stage-scope differences are not just an unenforced bound.
   Pinned by a twin test with a forced `cloneWorkflow`, as `race-next.test.ts`.
2. **Retries under a workflow `retryConfig.attempts`.** The twin re-runs the whole item from stage 0;
   stages themselves get the child's 0.
   - A. Per stage, inheriting: `stage.retries ?? parent retryConfig.attempts` (the existing
     `effectiveRetries` with the parent's options) — a transient stage failure recovers without
     re-running earlier stages' side effects.
   - B. Per stage, child view: `stage.retries ?? 0` — literal to the child; a run the twin recovers
     fails here.
   - C. Whole-item re-run — a back-arc into stage 0 under hold-and-wait; refused for cost.

   **Recommended: A** (row 113). Attempt counts differ from the twin either way.
3. **Item scope: where stage records, init data and state live.**
   - A. Twin parity: records and `getInitData()` per item (a `RunScope` item store read through the
     stage's view, forgotten at settle); state snapshotted at stage-0 start and `Object.assign`-merged
     into the run's state when the item settles without failing, as `workflow.ts:3055` /
     `default.ts:709-713` (lost updates across concurrent items, as on the default engine).
   - B. Parent scope: stage records under stage ids, last writer wins (row 86's analogue), stage ids
     colliding with parent ids refused (`pipeline-ids`); `setState` applied per stage attempt.

   **Recommended: A.** Under B a stage's `getStepResult('fetch')` reads whichever item wrote last, and
   `getInitData()` returns the run's input instead of the item — wrong values where the twin is
   right — and the persisted step map gains keys resume and restart must ignore. Cost: leaf, scope
   and runner plumbing (per-item `#state`); the W0 contract pins whether the failed-item case merges.
4. **A stage suspends, in wave 1.**
   - A. The pipeline ends `suspended` at the lowest index; resume refused by name (`pipeline`); no
     site; lane attempts exempt from coverage, guarded by structure rule 7.
   - B. A suspension fails the item (`PipelineSuspendedError`): no unresumable suspended run, no
     exemption — but an outcome change against the twin.
   - C. Resumable at (item, stage) now: `ForeachResume` with a stage index, a resume segment in
     every proof.

   **Recommended: A** — the twin's status, row 77's precedent, no resume segment. C is wave 2.

## Consequences

- Proof cost is Σc_j leaf copies plus Σ_j c_j·c_{j+1} hand-offs plus five drops per lane in the
  cancel segment; the item count is not a factor. Baseline (libpetri 8.0.0, [ADR 0009] amended):
  three foreach lanes enumerate, five pass 50k classes and go to SMT at 5-7 s per query. Claimed
  fixtures stay at Σc_j ≤ 4. Wider pipelines compile (up to 256 lanes) but are unclaimed, as wide
  foreach is. A query over 30 s redesigns the net — a depth-1 relay per boundary (linear, not the
  c_j·c_{j+1} product), or ν-named lanes so Route B quotients lane permutations (a Track U ask
  shared with the foreach); over 60 s asks the libpetri sessions. Never a larger budget.
- A timed stage (retry delay, `rateLimit`) moves its segment to SMT, as in M7 and [ADR 0014].
- The `frame` token serializes collects and settles, as in the foreach; hand-offs never take it, so
  items at different stages do not serialize.
- Hold-and-wait throttles throughput: a slow stage j+1 holds stage j's finished lanes. Stated, with
  `queue(depth)` as the buffer to compose later.
- The twin's body is a petri workflow, so on `DefaultExecutionEngine` its children run on the petri
  engine; the twin test also mints a default-engine body through a test helper for a pure-Mastra
  oracle.
- M8 compiles nested workflows in general; the stage adapter is written so M8 reuses it.
- Divergence rows 111-118, `planned (M7b)`.

## Evidence

Planned:

- `tests/mastra/pipeline-surface.test.ts` — the factory; the brand and `Chained<S>` as
  `@ts-expect-error` under `npm run check`; spread inference into `.foreach` pinned before W1.
- `tests/mastra/adapt-pipeline.test.ts` — every refusal; agent and tool stages matched by ref and
  options identity; an altered `opts.concurrency`; a marker on a stage.
- `tests/compiler/pipeline.test.ts` — shape and names; `[i, L]` lane paths; s = 1 against the foreach
  net; the hash moving with the bounds and unchanged without a pipeline; `foreach-frame.ts` leaving
  the foreach byte-identical.
- `tests/verify/pipeline.test.ts` — the seven structure rules, one mutant each; the claims; overlap
  as a definitive `Violated`.
- `tests/engine/pipeline.test.ts` — overlap under a ManualClock; failure drains in-flight items
  through every stage; bail as item success; cancel holes; suspend and the `pipeline` refusal;
  item-scoped `getStepResult` / `getInitData` / state; `limit(1)` peak across items; run budget 1.
- `tests/engine/pipeline-next.test.ts` — `.then(next)` against a default-engine oracle; a forced
  `cloneWorkflow` on `DefaultExecutionEngine` running as `.foreach(nestedWorkflow)`; the twin
  differential on success, mid-pipeline failure, cancel at and between boundaries.
- `tests/verify/pipeline-blueprints.test.ts` — the matrix through `init()`, every family in every
  default segment; libpetri 8.0.0 from npm, not linked.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0004]: 0004-structural-cancellation.md
[ADR 0006]: 0006-run-step-budget.md
[ADR 0009]: 0009-verification-claims.md
[ADR 0010]: 0010-restart-from-marked-checkpoints.md
[ADR 0012]: 0012-limiter-blueprints.md
[ADR 0013]: 0013-step-timeout.md
[ADR 0014]: 0014-race-and-quorum.md
