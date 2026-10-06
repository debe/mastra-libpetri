# ADR 0017 — `compensate` is a step option: a run that fails undoes its completed top-level steps, newest first, before it settles

Status: proposed (2026-10-06, M7b second wave). Maintainer decisions taken (below): 1 A, 2 A,
3 A, 4 A; 5 A and 6 A follow from 1 A. Spikes in scratch only; libpetri 8.0.0 from npm, not linked
(`scripts/link-libpetri.sh --check`: "not linked"), z3 4.13.0. Mastra `@mastra/core` 1.67.0
(`scripts/mastra-pin`); Mastra paths are under `.mastra/src-extracted/src/workflows/`. Repo
citations are at `729d0cd`.

## Context

README's blueprint table names `compensate()` — "saga rollback; why the IR can't: no rollback
story; failure propagates" — and [ADR 0002] files it in Layer 3. `tasks/todo.md` puts it in the
M7b second wave after `pipeline()`, and M10 proposes consolidating "a compensation step" with
temporal-libpetri and adk-libpetri upstream.

**Mastra 1.67.0 has no compensation, undo or saga anywhere in `workflows/`.** The only rollbacks
in the package are internal (`agent/thread-stream-runtime.ts:1961-2046`,
`storage/domains/memory/base.ts:264-346`). What it does on failure, traced in its sources:

| Behaviour | Mastra |
|---|---|
| A later step fails | the loop stops at the first non-success entry (`default.ts:925-929`); no step runs after it |
| Completed steps | keep their `success` records and their effects |
| `.parallel()` / `.branch()` | every arm finishes (`Promise.all`, `handlers/control-flow.ts:220,540`); the lowest-index failure is reported (`:267-276`) |
| `.foreach()` | `killQueue()` on the first failure; in-flight items finish (`control-flow.ts:1100-1127`) |
| State | not rolled back: `setState` writes up to the failure persist |
| The failed result | `{status:'failed'\|'tripwire', steps, error \| tripwire, stepExecutionPath}` (`default.ts:558-628`) |
| A failed run | final: `restart` short-circuits a stored `failed` (`workflow.ts:4887-4936`); `resume` needs `suspended` (`utils.ts:795-830`) |
| Cancel | `Run.cancel()` aborts, ends the whole span tree at once and writes `canceled` (`workflow.ts:3595-3621`, `endTree` at `:3602`); checked before each entry (`default.ts:815`); the result re-stamped `canceled` (`handlers/entry.ts:815-817`); nothing is compensated |
| `onError` | `failed`/`tripwire` only (`execution-engine.ts:190-205`), after the terminal persist (`default.ts:953-967` then `:985-1000`); a throw in it is logged, not propagated |

**No catch exists in Mastra's IR.** A `.branch()` never sees a failed step, because the run has
already stopped; a nested workflow rethrows its child's error in the parent step
(`workflow.ts:3092-3101`). The only expressible plain-Mastra sagas are:

- **(a) failure as data** — a wrapper catches, `.branch` routes to undos, a final step rethrows.
  It rewrites the forward record from `failed` to `success` and hides the throw from Mastra's
  retry loop (`handlers/step.ts:314,319-478`). It is not a twin;
- **(b) the whole saga inside one step's `execute`** — invisible to everything;
- **(c) undo work in `onError`** — called **T1** below and documented as the recipe and oracle.
  The undo runs outside the run (its own run id, no records in the failed run), is lost if the
  process dies between the terminal persist and the callback (`default.ts:953-1000`), has its
  failure swallowed (`execution-engine.ts:167-204`) and never runs on a cancel (`:191`).
  **Never put T1 on a petri workflow:** this engine also invokes `onError`
  (`typescript/src/mastra/engine.ts:543-557`), so the run would compensate in the net and again in
  the callback.

Unlike [ADR 0016], nothing is missing from the host: this engine owns `execute()`, Mastra's
storage takes any step map, and a failure is already a token ([ADR 0003]; `FailureToken`,
`compiler/types.ts:622-632`). Deferral is not the honest answer; narrowing is.

How others do it: Temporal's `Saga` runs compensations in reverse, one at a time, stopping at the
first compensation error unless `continueWithError` (`Saga.java:115-125`), and cleanup after a
cancel needs a detached scope (`Workflow.java:385-410`). BPMN arms a compensation handler only once
its activity completes and runs handlers in reverse completion order. temporal-libpetri's
`CompensationStep` fans obligations out in parallel and settles each as resolved or unresolved —
"a cleanup failure is never reported as success" (BPT-005). libpetri's own rule is EXEC-031 (no
rollback): a compensating transition is something the net says, not something the executor does.

Three designs were spiked:

| | 1. scoped block | 2. per-step, flags | 3. per-step, ladder (chosen) |
|---|---|---|---|
| Surface | `compensate([[f, u], …])`, a minted petri nested workflow | `createStep({ compensate })` | `createStep({ compensate })` |
| Scope | the block's child run | the whole run | the whole run |
| Obligations | `armed_j` discharged inside the gadget | `armed_j`, resting beside terminals | one ladder token, `level.0..m` |
| Kernel change | none | resting set and sinks widened | none (after the W0 rework below) |
| Coverage proof | yes | yes | yes (C1 `quiescentCount`) |
| Classes, closed / cancel | ~13n+5 / 39n+16 | +~10 per compensator | +~16 / +48 per compensator |
| Restart after a crash mid-rollback | re-runs the body | unsound unless a new row is written | closed by refusal (decision 4) |
| Twin | by construction (nested run) | key ignored | key ignored |

The block has the best twin parity and the cleanest net, but its scope ends at the block: a failure
in a later parent step (`sendConfirmation`) compensates nothing, and every saga costs a child run.
Design 2's resting obligations widen what `deadlockFree` accepts for every compensable net and what
the kernel calls residue (`engine/kernel.ts:577-581`). Design 3 measured both rejected alternatives
inside its own spike: **A0**, a per-entry routing table, is cheaper but cannot prove coverage — a
mutant routing entry `d` past `ub` on `[a*,b*,c,d]` passes every family; **A1**, one armed flag per
step, proves coverage but its releases interleave about 2^a ways (m=8: 1,128 / 3,640 classes).

## Decision

### Surface: a Layer 3 step option

```ts
const { createWorkflow, createStep } = init();
const release = createStep({ id: 'release-seat', inputSchema: Seat, outputSchema: z.void(), execute });
const reserve = createStep({ id: 'reserve-seat', inputSchema: Req, outputSchema: Seat, execute, compensate: release });
const refund  = createStep({ id: 'refund', inputSchema: Charge, outputSchema: z.void(), execute, retries: 3 });
const charge  = createStep({ id: 'charge', inputSchema: Seat, outputSchema: Charge, execute, compensate: refund });
createWorkflow({ ... }).then(reserve).then(charge).then(ship).commit();
```

- **The carrier.** `compensate` is stripped by the petri `createStep` before Mastra's sees it and
  attached under `STEP_RESOURCES` (`mastra/resources.ts:14,103-112`) beside `uses` and `timeout`
  ([ADR 0012], [ADR 0013]); `cloneStep` and `__agentOptions`/`__toolOptions` keep it. It cannot be
  an entry option, because `.then(step)` takes none (`workflow.ts:1941`), and it cannot ride on
  Mastra's `createStep`, which copies named fields only (`workflow.ts:510-530`, row 102).
- **Typing (`Undoable`).** `compensate?: PetriStep<string, any, Out, any>` where `Out` is the
  forward step's output: the compensator's `inputSchema` must accept the forward `outputSchema`,
  and a default-engine compensator is a type error, as for race and pipeline.
- **Why Layer 3, not Layer 2 metadata.** ADR 0002's test fails three ways. (1) On
  `DefaultExecutionEngine` a failing run ends with the seat still reserved and the card charged —
  the outcome the option exists to prevent; an unenforced `concurrency` changes only a schedule.
  (2) Mastra has no word for it, and Layer 2 is "a word Mastra has but does not enforce".
  (3) The mechanics fail too: `step.metadata` is copied into `serializedStepGraph`
  (`workflow.ts:634`), which is persisted with every snapshot, so `metadata: { compensate: step }`
  serializes the compensator's schemas into the graph (checked in scratch against 1.67.0: no
  throw, the reference lost on a round trip), and changing the compensator would trip
  `workflow-changed` (row 97). `StepMetadata` is `Record<string, any>`, so nothing could be typed.
  The `PetriEngineType` brand on every `init()` step already marks the workflow; the option key is
  the visible decision, as `uses` is.

**Semantics.** When a top-level entry ends `failed` or `tripwire`, each earlier compensated
top-level `.then()` step that completed has its compensator run **once, one at a time, newest
first**, before the run settles, before the terminal row, and before `onError`/`onFinish`.

- The compensator's `inputData` is the forward step's output, carried in the obligation token
  (below) and rebuilt from the stored record on resume. `getStepResult(forward)` and
  `getInitData()` resolve as for any step.
- Its retries are `compensator.retries ?? retryConfig.attempts` (`handlers/step.ts:314`); `uses`,
  `timeout` and the run budget apply as on any step.
- A step that failed is not compensated, even if its effect applied (BPMN's rule: only completed
  activities are armed). Make it atomic or idempotent.
- Bail, suspend, pause and a cancel with no failure trigger nothing.
- The compensator's attempt gets a signal not linked to the run's abort, only to its own timeout
  (Temporal's detached cancellation scope); otherwise a step that honours `abortSignal` would skip
  its undo after a cancel.
- Its events carry `executionPath` `[k]`, the entry it compensates, so a watcher that resolves the
  path lands on a real entry; the step id tells them apart.
- Compensators and compensated steps must tolerate running twice ([ADR 0010]); idempotency is the
  author's obligation, as in Temporal, and is never claimed.

### Twin on `DefaultExecutionEngine`

**T0 — what Mastra itself does, pinned.** A forced `cloneWorkflow` onto the default engine cannot
see the side-table key: on success the results are identical; on failure the status, the `error`
(with decision 2 A), the tripwire and the forward records match, no compensator record exists and
the effects remain. This is the Layer 3 statement, pinned as `race-next.test.ts` and
`pipeline-next.test.ts` pin theirs.

**T1 — the recipe and oracle.** The same workflow on the default engine with an `onError` that
starts an undo workflow over the completed records. The differential pins that the compensators
see the same inputs, in the same order, and states T1's four differences (outside the run, lost
on a crash, failure swallowed, never on cancel) as recipe text.

### The net: a ladder

Given top-level entries `0..n-1` and compensated entries `k_1 < … < k_m`. Names live under
`wf.comp.*`, outside every `s.<i>.` interior, so the barrier family is unchanged. **Unannotated
workflows compile to today's net and hash**; `structuralHash` carries `compensations` only when
present. Every place is 1-bounded.

```text
places:  wf.comp.level.{0..m}      one token while the run is live; carries the stack of outputs
                                   [out(k_1) … out(k_j)]
         wf.comp.{j}.arming        entry k_j's success (its gadget's `next`)
         wf.comp.failure           exits.failed of every top-level entry (m >= 1)
         wf.comp.fault             the held original FailureToken
         wf.comp.pending           a rollback is under way
         wf.comp.exit.{done,bailed,suspended,paused}   the non-failed top-level exits, intercepted
         u_j leaf places; u_j exits {done, failed, bailed, suspended, paused, canceled}

t.comp.{j}.arm                     arming_j + level.{j-1}      -> successor(k_j) + level.j   (push out(k_j))
t.comp.raise                       failure                     -> fault + pending
t.comp.{j}.start                   pending + level.j           -> u_j.in {data: top of stack}
t.comp.{j}.settle.{kind}           u_j.<kind>                  -> level.{j-1} (pop) + pending  (6 kinds)
t.comp.finish                      pending + level.0 + fault   -> wf.settle.failed  (original token)
t.comp.{j}.discharge.{kind}        exit.<kind> + level.j       -> wf.settle.<kind>  (kind ≠ failed; done -> settleDone)
t.comp.{j}.release.canceled        level.j, read wf.canceled   -> ∅
```

- **Order and coverage are structural.** Only `start_j` consumes `level.j`, and its settles return
  `level.{j-1}`; the top-level spine is sequential, so ladder order is completion order, and
  `finish` cannot fire until the token is back at `level.0`.
- **One routing rule replaces a per-entry table.** Every top-level failure is raised into
  `wf.comp.failure`; the ladder's position picks the compensator.
- **Terminals are untouched (W0 rework of the spike).** The measured spike released the level
  token with `level.j + T -> T` on every terminal. That consumes and reproduces terminal places,
  which needs kernel care before the residue judgement (row 66) and VER-004 care around a
  transiently empty terminal. This design instead **discharges the token before the settle stage**:
  the non-failed top-level exits land in `wf.comp.exit.*`, and a pure move takes the level token
  with them into the existing `wf.settle.*` places (`compile.ts:172-213`). Only `canceled` cannot be
  intercepted — sweeps and checkpoints produce `wf.canceled` directly (`compile.ts:209`, the
  checkpoint gadget) — so its release **reads** `wf.canceled` and never consumes it. That is sound
  only if `wf.canceled` is the spine's last token; W0 proves `exclusive(wf.canceled,
  wf.comp.failure)` and `exclusive(wf.canceled, wf.comp.pending)` in every segment. If either does
  not close, the fallback is the spike's measured terminal release, recorded as an amendment.
- **Cancel ([ADR 0004]).** No `wf.comp` transition has an arc on `wf.cancel` (the read on
  `wf.canceled` is on the terminal, not the signal); compensators are emitted without the signal,
  as pipeline lane bodies are. A cancel never preempts a rollback; the decision happens only at the
  existing `wf.settle.failed` pair, so a run canceled mid-rollback ends `canceled` after rolling
  back, matching `classify` (`engine/kernel.ts:634-646`) and Mastra's re-stamp. `wf.cancel` stays
  the only inhibited place; VER-004 splits only `t.cancel.arrive` (and the reads of `wf.canceled`,
  which W0 confirms are not split).
- **Seeds.** One function, shared by `segmentInitialMarking` (`verify/properties.ts:132`) and the
  kernel's fresh, resume and restart seeds, adds `level.a` with
  `a = |{j : k_j < top-level index of the seed}|`, its stack rebuilt from the stored records
  (`engine/scope.ts:77-108`). With decision 4 A a restart always seeds `level.0`.
- **Host machinery.** A host-free emitter `compiler/blueprints/compensate.ts` (an M10 candidate);
  `StepCall.detached` for the compensator signal; the runner's `#resolveStep` for compensator
  paths; a record rewrite for a compensator that suspends dynamically (as `forgetSuspension`, row
  107). Persistence and result formatting are unchanged: the error comes from the held token
  (`mastra/result.ts:162-175`).

### Claims ([ADR 0009])

**Proven** in every default segment — `closed`, `cancel`, `resume@s` ± cancel, `restart@p` ±
cancel — from that segment's marking plus `level.a`, closed net with the arrival modelled by
`t.cancel.arrive`, under VER-004 in-flight firing; enumeration while every step is immediate, SMT
when one is timed:

- **C1 `rolledBack`** = `quiescentCount({wf.comp.level.1..m}, 0, 0)`: no completed compensated
  step is left armed at rest.
- **C2** = `exclusive(wf.comp.level.j, wf.settle.failed)` for j ≥ 1: no failed outcome, and no
  cancel decided over a failure, settles while a completed compensated step is uncompensated.
  With C1: *every completed compensated step has its compensator begun and settled before the
  failed terminal.* "Begun and settled" is proven; "succeeded" is not.
- **C3 (fail-fast)** = `exclusive(wf.comp.fault, p)` for p in every top-level entry input, every
  `wf.settle.*` and every terminal: nothing forward starts and nothing settles during a rollback.
- **C4 (canceled is last)** = `exclusive(wf.canceled, wf.comp.failure)`,
  `exclusive(wf.canceled, wf.comp.pending)`: the read-arc release cannot strand a later failure.
- **Existing families** on the new places: `deadlockFree`, `terminatesAtSink`,
  `exactlyOneTerminal`, `neverCanceled` in `closed`; `placeBound(·, 1)` on every `wf.comp` place;
  `live` for every compensator attempt, retries included (ordinary `LivenessTarget`s).

**Checked from the arcs** (`verify/compensate.ts`, `compensateStructureViolations`, one mutant per
rule). Model checking cannot see two things: *at most once* — a mutant whose last compensator
settles back to its own level and repeats (MUT5) passes every behavioural claim — and *reverse
order* beyond adjacent levels. Order is claimed from the arcs on adjacent levels only (O(m), not
O(m²)); transitivity gives the rest.

- **S1.** `arm_j` takes exactly {arming_j, level.{j-1}} and gives exactly {successor(k_j),
  level.j}; arming_j's only producer is entry k_j's `next`; `level.j` (j ≥ 1) has no producers but
  `arm_j` and `settle_{j+1}.*`.
- **S2.** Every top-level `exits.failed` is `wf.comp.failure`; `raise` is its only consumer.
- **S3.** `start_j` takes exactly {pending, level.j} and is the only producer of `u_j.in`; each
  `u_j` exit has exactly one consumer, `settle_j.<kind>`, giving exactly {level.{j-1}, pending};
  the rollback subgraph strictly descends and is acyclic (catches MUT5).
- **S4.** `finish` takes exactly {pending, level.0, fault} and is the only producer of
  `wf.settle.failed`.
- **S5.** No `wf.comp` transition has an arc on `wf.cancel`; no swept transition consumes a
  `wf.comp` place; compensator leaves carry no signal.
- **S6.** Each `discharge` moves exactly one `exit.<kind>` to its own `wf.settle.<kind>`; each
  `release.canceled` reads `wf.canceled` and consumes only `level.j`; nothing in `wf.comp` produces
  or consumes a terminal.
- **S7.** Compensator attempts are exempt from suspension coverage (`compensatorAttempts`, as
  `pipelineLaneAttempts`), guarded by S3.

**Tested, not proven:** the compensator's input equals the forward output, including after
rehydration; the order of records, events and `stepExecutionPath`; the detached signal; `error`
and tripwire identity against T0; `onError`/`onFinish` see compensator records; the terminal row
holds them; a dynamic suspend in a compensator rewritten `failed`; a cancel mid-rollback still
finishes it; a petri child workflow that rolls back inside itself and then fails its parent step,
including the parent's rewrap (`workflow.ts:3093-3099` throws a new `MastraNonRetryableError`
whenever any failed record is `nonRetryable`) and the child's state merge, which happens before the
throw (`workflow.ts:3054`). Idempotency is not tested at all.

### Behaviour

| Situation | Behaviour | T0 (default engine) |
|---|---|---|
| Entry j fails | compensators of completed `k_i < j`, newest first; then `failed`/`tripwire` with the original error | fails, nothing undone |
| A compensator fails, suspends or pauses | unresolved; the rollback continues; the run's `error` stays the original (decision 2) | n/a |
| Bail, suspend, pause | the level token discharges with the exit; nothing compensates | same |
| Cancel with no failure | `canceled`; nothing compensates | same |
| A failure under cancel, or a cancel mid-rollback | the rollback completes, then the run is re-stamped `canceled` | canceled, nothing undone |
| `Run.cancel()` mid-rollback | `endTree` closes the span tree at once (`workflow.ts:3602`); compensator spans land under an ended tree | n/a |
| Resume after a suspend, then a failure | compensates steps completed before the suspension, inputs rebuilt from records | nothing undone |
| Crash mid-rollback | not durable: the row is `running` from the start or a checkpoint before `k_1` (row 55); restart re-runs forward work | n/a |
| Stranded run, host precondition failure | rejects before any terminal, no rollback (rows 66, 84) | n/a |
| State | not rolled back (as Mastra); a compensator's `setState` applies | not rolled back |

### Refusals

Thrown at `createStep` where the problem is visible, repeated by the adapter; the codes join the
step-option refusals beside `uses-position`.

| Refusal | When |
|---|---|
| `compensate-position` | the key on anything but a top-level `.then()` step — a parallel, branch, race or quorum arm, a loop or foreach body, a pipeline stage, a declarative `.agent`/`.tool` that never passed through the petri `createStep` — or on the last top-level entry (dead, would fail liveness) |
| `compensate-value` | a compensator that is not a petri params-form step: a workflow (M8), an agent or tool, a default-engine step, the forward step itself, or one carrying its own `compensate` |
| `compensate-ids` | a compensator id colliding with a graph id or another compensator, or one compensated step used twice (records are latest-per-id) |
| `compensate-suspend` | a compensator declaring `suspendSchema` or `resumeSchema` |
| `compensate-checkpoint` | `metadata.checkpoint` on an entry at or after `k_1` (decision 4) |

## Maintainer decisions

Taken 2026-10-06: 1 A, 2 A, 3 A, 4 A. 5 A (the forward step's output) and 6 A (the README row)
follow from 1 A and were not put separately.

1. **Surface and scope.**
   - **A. `createStep({ compensate })`, run-wide ladder (recommended).** Covers a failure anywhere
     after the step; smallest kernel delta; coverage proven.
   - B. A `compensate([[f, u], …])` block minted as a petri nested workflow (design 1). Twin parity
     by construction and state rollback through a copying `stateSchema`, but the scope ends at the
     block and every saga is a child run.
   - C. A now, B in wave 2 as sugar over the same ladder inside a minted body.

   **Recommended: A**, and the README row is renamed from `compensate()` to the `compensate` step
   option (decision 6).
2. **What a compensator failure reports.**
   - **A. Continue; the run keeps the original `error`; the compensator's failed record is the
     trace (recommended).** Error and tripwire parity with T0.
   - B. Continue, and the error becomes `CompensationIncompleteError extends
     MastraNonRetryableError { cause, unresolved }` (BPT-005). A data-only change to `settle` and
     `finish`, no net or proof change. Breaks error parity, and in a nested petri child the
     parent's rewrap (`workflow.ts:3093-3099`) can bury it under `cause`; whether a persisted error
     keeps custom fields is untested.
   - C. Stop at the first failure (Temporal's default). Leaves obligations armed; C1 fails.
3. **Cancel.**
   - **A. Only a failure compensates; a started rollback always finishes (recommended).** Matches
     Mastra, and canceling a suspended run executes nothing anyway (`workflow.ts:3595-3621`).
   - B. A cancel also compensates (BPMN, temporal-libpetri `cancelPaid`): the sweeps route into
     `raise`. Never covers a suspended run.
   - C. A cancel preempts the rollback, as T0 does. C1 fails in the `cancel` segment.
4. **Checkpoints after a compensated entry.**
   - **A. Refuse `compensate-checkpoint` (recommended for wave 1).** Restart always seeds
     `level.0`, so `restart@p` proofs mean what they say.
   - B. Durable rollback: one awaited `running` row at `raise` (and optionally after each settle),
     with `unwind@j` restart sites on the ladder (m+1 segments, each linear). Adds a write on the
     failure path, against the explicit-checkpoint rule's spirit.
   - C. Allow and document: a crash after `release` ran, then a restart from a later checkpoint,
     can end `success` without a reservation.
5. **The compensator's input.**
   - **A. The forward step's output (recommended).** Typed by `Undoable`; the forward input stays
     in the record's `payload`.
   - B. `{ input, output }`, for steps that return nothing (an email sent). Wider surface.
6. **The README row.**
   - **A. "`compensate` (step option) — undo completed steps, newest first, when the run fails"
     (recommended).**
   - B. Keep `compensate()` and add the block (1 B or 1 C).

## Consequences

- Proof cost is additive: about +16 closed and +48 cancel classes per compensator (spike, before
  the W0 rework); m=12 verified in 0.78 s; one token is in the rollback and the forward part is
  dead while it runs. A query over 30 s redesigns the net; over 60 s asks the libpetri sessions.
  Never a larger budget.
- Wave 1 compensates top-level `.then()` steps only. Parallel and branch arms, foreach and pipeline
  items need per-arm or counted obligations — temporal-libpetri's `CompensationStep` shape — and
  are a later M7b wave, tracked in `tasks/todo.md`. Parallel compensation is deferred: the spine is sequential.
- Rollback progress is not durable (decision 4). Restart from a checkpoint before `k_1` re-runs
  forward work; compensators must tolerate it.
- The engine runs steps after a failure for the first time; every consumer of `steps`,
  `stepExecutionPath` and step events on a failed run sees compensator records.
- The emitter is host-free and the claims are generic over a ladder, so M10's consolidation with
  temporal-libpetri and adk-libpetri starts from code, not prose.

## Evidence planned

libpetri 8.0.0 from npm, not linked; every figure quoted with its provenance.

Spike so far (scratch, 2026-10-06, the ladder with terminal releases, before the W0 rework;
`cancelStructureViolations` ran unchanged and passed; the full repo structure suite has not run
on it, which W0 does):

| Fixture | Places / transitions | Claims | Classes closed / cancel | Wall |
|---|---|---|---|---|
| no compensation `[a,b,c]` | 16/17 | 556 | 13 / 40 | 0.01 s |
| m=1 `[a*,b]` | 28/36 | 588 | 33 / 102 | 0.11 s |
| m=2 `[a*,b*,c]` | 38/52 | 1,076 | 49 / 151 | 0.03 s |
| m=5 | 68/100 | 3,404 | 97 / 298 | 0.11 s |
| m=12 | 138/212 | 13,876 | 209 / 641 | 0.78 s |
| m=2, retries 2 × 5 ms (timed) | 48/62 | 1,389 | SMT | 4.0 s, slowest 354 ms |
| m=2, run budget 1 | 39/52 | 1,104 | 49 / 151 | 0.03 s |
| `[a*, parallel(3), c*, d]`, checkpoint at 0 | 59/78 | 5,409 | 602 / 1,810 (565 / 1,696 bare) | 0.43 s |

Every claim held; mutants MUT6 (arm skips the lower level), MUT7 (finish without `level.0`), MUT8
(failure bypasses `raise`) caught behaviourally, MUT5 only by S3, A0's coverage mutant passes
every family (the reason A0 is rejected).

Planned tests:

- `tests/compiler/compensate-contract.test.ts` — unannotated workflows keep their nets and hashes;
  the hash carries compensations only when present.
- `tests/compiler/compensate.test.ts` — the exact transition list; 1-bounded from the arcs;
  `wf.cancel` the only inhibited place; VER-004 splits only `t.cancel.arrive`.
- `tests/verify/compensate.test.ts` — S1–S7, a mutant per rule (MUT5 also run against the
  behavioural claims with the result recorded); C1–C4; the coverage exemption, not vacuous.
- `tests/mastra/compensate-surface.test.ts`, `tests/mastra/adapt-compensate.test.ts` — the key, the
  `Undoable` and brand type errors as `@ts-expect-error`, every refusal, agent/tool carriers.
- `tests/mastra/runner-compensate.test.ts` — the detached signal; the dynamic-suspend rewrite;
  compensator inputs from the token and from rehydrated records.
- `tests/engine/compensate.test.ts` — end to end on Mastra's `Run` under a ManualClock: failure at
  each position, a failing compensator, tripwire, bail, suspend then resume then fail, cancel before,
  during and after a failure, `Run.cancel()` mid-rollback (span tree), `limit(1)` and run budget 1,
  a petri child workflow rolling back then failing its parent (rewrap and `workflow.ts:3054`
  state merge).
- `tests/engine/compensate-next.test.ts` — petri, forced `cloneWorkflow` (T0) and the `onError`
  recipe (T1): status, error and tripwire identity, forward records, compensator inputs and order.
- `tests/verify/compensate-blueprints.test.ts` — shapes through `init()`: m = 1, 2, 5, 12; retries
  immediate and timed; run budget 1; beside `parallel(3)` and `foreach(2)`; checkpoint before
  `k_1`; every family in every default segment, slowest query recorded.

## Divergence rows planned

| # | Behaviour | Classification | Note |
|---|---|---|---|
| 119 | `compensate` | addition | No Mastra word. `init().createStep({ …, compensate })` (Layer 3): when the run fails, completed compensated top-level steps are undone newest first before it settles. The twin ignores the key; the failure propagates unchanged and the effects remain |
| 120 | Steps run after a failure | addition | Compensator records in `steps`, `stepExecutionPath`, step events (`executionPath` the compensated entry's), the terminal row and the callbacks' `steps`. Mastra stops at the first non-success (`default.ts:925-929`) |
| 121 | A failed step is not compensated | addition | Only completed steps are armed; a step that failed or timed out ([ADR 0013]) after applying its effect is not undone |
| 122 | A compensator that fails | addition | Per decision 2: the rollback continues and the run's `error` stays the original; the failure is in the compensator's record |
| 123 | Cancel and rollback | addition | A failure under cancel still compensates, a rollback is never preempted, compensators get a detached signal, the run ends `canceled`. A cancel with no failure, or of a suspended run, compensates nothing, as Mastra |
| 124 | `Run.cancel()` mid-rollback | addition | Mastra ends the whole span tree at once (`workflow.ts:3602`); compensators keep running and their spans land under an ended tree |
| 125 | A compensator that suspends | refused (M7b) | `compensate-suspend` for a declared schema; a dynamic `suspend()` is unresolved, its record rewritten `failed` and its labels forgotten (row 107 precedent) |
| 126 | Crash mid-rollback | replaced | Not durable (row 55): restart re-runs from the start or a checkpoint before `k_1`; compensated steps and compensators must be idempotent |
| 127 | No rollback on a stranded run or host precondition failure | addition | Rows 66 and 84 reject before any terminal |
| 128 | State | — | Not rolled back, as Mastra; a compensator's `setState` applies. A petri child's state merges into its parent before the parent step throws (`workflow.ts:3054`) |
| 129 | Compensate shapes refused | refused (M7b) | `compensate-position`, `compensate-value`, `compensate-ids`, `compensate-suspend`, `compensate-checkpoint`, as listed in Decision |

## Plan (mirrors ADR 0015's waves)

- **W0 spike (scratch only), before any `src/` change.** The ladder through the real compile path
  with **structure checks on**, reworked as above: non-failed exits discharged before the settle
  stage, `canceled` released by a read arc, the output stack in the level token. Prove C4; if it
  does not close, fall back to the measured terminal release and amend. Add `foreach(2)` beside
  compensated steps and the adjacent-level order rule. Report classes closed / cancel, route and
  slowest query per fixture; rerun MUT5–MUT8 and a mutant per S rule. Pin on Mastra: T0's error
  and tripwire identity; T1's callback order; the rewrap at `workflow.ts:3093-3099` and the merge
  at `:3054` for a petri child; that a compensator's spans after `Run.cancel()` do not throw. A
  query over 30 s: the named redesign is to drop the stack from the token and read inputs from
  records (value-blind), recorded as an amendment.
- **W0 contract (lead).** `CompensationSite` and `CompiledWorkflow.compensations`; the ladder seed
  signature; `StepCall.detached`; `StepResources.compensate`; the five refusal codes;
  `compensateStructureViolations`, `compensatorAttempts`; rows 119–129 `planned (M7b)`. Stubs
  throw `not implemented (M7b W<n>)`. Lead keeps: `src/compiler/types.ts`,
  `src/compiler/gadgets/types.ts`, `src/compiler/compile.ts`, `src/compiler/index.ts`,
  `src/mastra/index.ts`, `src/verify/index.ts`, ADR 0017, `tasks/todo.md`,
  `docs/divergences.md`, `README.md`.
- **W1, agents on disjoint files**, each adversarially reviewed with mutants in scratch copies:
  - net: `src/compiler/blueprints/compensate.ts`, `tests/compiler/compensate.test.ts`,
    `tests/compiler/compensate-contract.test.ts`;
  - claims: `src/verify/compensate.ts`, `src/verify/properties.ts` (seed, C1–C4),
    `tests/verify/compensate.test.ts`;
  - host: `src/engine/kernel.ts` (seed), `src/compiler/resume.ts`, `src/compiler/restart.ts`,
    `src/mastra/runner.ts`, `src/mastra/attempt-gate.ts`, `tests/mastra/runner-compensate.test.ts`;
  - surface: `src/mastra/init.ts`, `src/mastra/resources.ts`, `src/mastra/adapt.ts`,
    `tests/mastra/compensate-surface.test.ts`, `tests/mastra/adapt-compensate.test.ts`.
- **W2 integration, agents on disjoint files:** `tests/engine/compensate.test.ts`,
  `tests/engine/compensate-next.test.ts`, `tests/verify/compensate-blueprints.test.ts`.
- **W3 (lead):** ADR 0017 accepted with Evidence; rows 119–129 `fixed (M7b)`; README row per
  decision 6; the T1 recipe in the docs; todo M10 entry updated; CI green.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0003]: 0003-outcomes-exits-run-scope.md
[ADR 0004]: 0004-structural-cancellation.md
[ADR 0009]: 0009-verification-claims.md
[ADR 0010]: 0010-restart-from-marked-checkpoints.md
[ADR 0012]: 0012-limiter-blueprints.md
[ADR 0013]: 0013-step-timeout.md
[ADR 0015]: 0015-pipeline.md
[ADR 0016]: 0016-supersede.md
