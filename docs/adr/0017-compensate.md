# ADR 0017 — `compensate` is a step option: a run that fails undoes its completed top-level steps, newest first, before it settles

Status: accepted (2026-10-06, M7b second wave). Maintainer decisions taken (below): 1 A, 2 A,
3 A, 4 A; 5 A and 6 A follow from 1 A. Spikes in scratch only; libpetri 8.0.0 from npm, not linked
(`scripts/link-libpetri.sh --check`: "not linked"), z3 4.13.0. Mastra `@mastra/core` 1.67.0
(`scripts/mastra-pin`); Mastra paths are under `.mastra/src-extracted/src/workflows/`. Repo
citations are at `729d0cd`, those in the Amendment at `467c0a9`. W0 spike done (2026-10-06): the
body below is amended in place where the Amendment found it wrong.

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
| State | not rolled back: writes by completed steps persist; the failing step's own `setState` is dropped (`handlers/step.ts:574-577`) |
| The failed result | `{status:'failed'\|'tripwire', steps, error \| tripwire, stepExecutionPath}` (`default.ts:558-628`) |
| A failed run | final: `restart` short-circuits a stored `failed` (`workflow.ts:4887-4936`); `resume` needs `suspended` (`utils.ts:795-830`) |
| Cancel | `Run.cancel()` aborts, ends the whole span tree at once and writes `canceled` (`workflow.ts:3595-3621`, `endTree` at `:3602`); checked before each entry (`default.ts:815`); the result re-stamped `canceled` (`handlers/entry.ts:815-817`); nothing is compensated |
| `onError` | `failed`/`tripwire` only (`execution-engine.ts:190-205`); order pinned: terminal persist (`default.ts:953-967`), then `onFinish` (`execution-engine.ts:172-187`), then `onError`, then `start()` resolves (`default.ts:985-1000`); a throw in it is swallowed (`execution-engine.ts:200-202`) |

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
| Classes, closed / cancel | ~13n+5 / 39n+16 | +~10 per compensator | first +17 / +53, each later +13 / +40 (W0) |
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

- **The carrier.** Mastra's `createStep` builds the step from a fixed field list and drops
  `compensate` (`workflow.ts:510-530`, row 102), and `serializedStepGraph` emits only `id,
  description, metadata, component, serializedStepFlow, canSuspend` (`workflow.ts:629-640`), so the
  key never reaches the step or the persisted graph. The petri `createStep` passes a params object
  through unchanged and strips nothing from it (only agent and tool options lose `uses`/`timeout`,
  `typescript/src/mastra/init.ts:365-391`), so W1 must attach `compensate` there under
  `STEP_RESOURCES` (`mastra/resources.ts:14,103-112`) beside `uses` and `timeout` ([ADR 0012],
  [ADR 0013]); `cloneStep` keeps it, and for an agent or tool source it is stripped from the options copy
  with `uses`/`timeout`, as `__agentOptions`/`__toolOptions` are. *W1:* the petri
  `cloneStep(step, { id, compensate })` replaces the compensator, judged against the new id, so a
  compensated step used twice is `cloneStep(step, { id, compensate: cloneStep(undo, { id }) })`;
  a plain clone keeps the compensator and a second use is refused (`compensate-ids`). On an agent
  or tool forward step the compensator rides the declarative entry's options, and the runner
  resolves it from there. A forced `cloneWorkflow` copies
  `stepGraph` by reference (`create.ts:105-135`), so the symbol survives into the clone, where
  `DefaultExecutionEngine` ignores it (T0). It cannot be an entry option, because `.then(step)`
  takes none (`workflow.ts:1941`).
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
first**, before the run settles, before the terminal row, and before `onFinish` and `onError`.

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
**shape** (with decision 2 A), the tripwire and the forward records match, no compensator record
exists and the effects remain. Error *identity* is not a property either engine has: the run's
`error` is a plain `Object` built by `formatResultError` (`default.ts:613-628`), never the thrown
instance, so the twin compares equal shape (`name`, `message`, custom fields). This is the Layer 3
statement, pinned as `race-next.test.ts` and `pipeline-next.test.ts` pin theirs.

**T1 — the recipe and oracle.** The same workflow on the default engine with an `onError` that
starts an undo workflow over the completed records. The differential pins that the compensators
see the same inputs, in the same order, and states T1's four differences (outside the run, lost
on a crash, failure swallowed, never on cancel) as recipe text. The callback order, pinned on both
engines: terminal persist, then `onFinish`, then `onError`, then `start()` resolves
(`execution-engine.ts:172-187` then `:190-205`; `default.ts:953-1000`; petri
`typescript/src/mastra/engine.ts:543-557`). `start()` waits for `onError`, undo run included; a
throw in it is swallowed (`execution-engine.ts:200-202`). On a cancel `onError` is never called and
`onFinish` gets `canceled`. The default engine's terminal persist writes twice — `failed` then
`failed` for a failed run, `failed` then `tripwire` for a tripwire run, so for a moment the stored
row of a tripwire run says `failed` — and the petri engine writes once.

### The net: a ladder

Given top-level entries `0..n-1` and compensated entries `k_1 < … < k_m`. Ladder places and
transitions live under `wf.comp.*` and `t.comp.*`. The compensator leaves do not: the vocabulary
names by path, so compensator `u_j` is emitted as `s.<n+j-1>.<id>.*` and `t.<n+j-1>.<id>.*`
(W0). Both lie outside every top-level entry's `s.<i>.` interior (i < n), so the barrier family is
unchanged; a vocabulary prefix for compensators is optional, not needed. **Unannotated workflows
compile to today's net and hash** (W0: two unannotated nets compiled to exactly today's places,
transitions and `structuralHash`); `structuralHash` carries a step's `compensate` only when present.
Every place is 1-bounded.

```text
places:  wf.comp.level.{0..m}      one token while the run is live; carries the stack of outputs
                                   [out(k_1) … out(k_j)]
         wf.comp.{j}.arming        entry k_j's success (its gadget's `next`)
         wf.comp.{j}.undoing       the rest of the stack while u_j runs
         wf.comp.failure           exits.failed of every top-level entry (m >= 1)
         wf.comp.fault             the held original FailureToken
         wf.comp.pending           a rollback is under way
         wf.comp.exit.{done,bailed,suspended,paused,canceled}   the non-failed top-level exits and
                                   every sweep's canceled, intercepted
         u_j leaf places; u_j exits {done, failed, bailed, suspended, paused}   (five: no signal, so
                                   no canceled)

t.comp.{j}.arm                     arming_j + level.{j-1}      -> successor(k_j) + level.j   (push out(k_j))
t.comp.raise                       failure                     -> fault + pending
t.comp.{j}.start                   pending + level.j           -> u_j.in {data: top} + undoing_j {stack minus top}
t.comp.{j}.settle.{kind}           u_j.<kind> + undoing_j      -> level.{j-1} + pending  (5 kinds)
t.comp.finish                      pending + level.0 + fault   -> wf.settle.failed  (original token)
t.comp.{j}.discharge.{kind}        exit.<kind> + level.j       -> wf.settle.<kind>  (kind ∈ done, bailed,
                                                                  suspended, paused; done -> settleDone)
t.comp.{j}.discharge.canceled      exit.canceled + level.j     -> wf.canceled
```

`undoing_j` is needed because a leaf's exits mint new tokens: the stack cannot pass through
`start_j -> u_j.in -> u_j.<kind>`, so the rest of it waits beside the leaf (W0, amendment 2).
`discharge_j.*`, `discharge_j.canceled` included, is emitted for every level j = 0..m.

- **Order and coverage are structural.** Only `start_j` consumes `level.j` during a rollback (a
  discharge needs a non-failed top-level exit, and by C3 no top-level entry starts during one), and
  its settles return `level.{j-1}`; the top-level spine is sequential, so ladder order is completion
  order, and `finish` cannot fire until the token is back at `level.0`.
- **One routing rule replaces a per-entry table.** Every top-level failure is raised into
  `wf.comp.failure`; the ladder's position picks the compensator.
- **Terminals are untouched (intercept mode, W0 amendment 1).** The design-round spike released
  the level token with `level.j + T -> T` on every terminal. That consumes and reproduces terminal
  places, which needs kernel care before the residue judgement (row 66) and VER-004 care around a
  transiently empty terminal. This design instead **discharges the token before the settle stage**:
  every non-failed top-level exit lands in `wf.comp.exit.*`, and a pure move takes the level token
  with it into the existing `wf.settle.*` places (`compile.ts:172-213`). `canceled` is intercepted
  like the rest: sweeps emit into `ctx.exits.canceled` (`compile.ts:212`) and `checkpointGadget`
  takes the canceled place as a parameter (`compile.ts:308`), so with compensation both are handed
  `wf.comp.exit.canceled`, and `discharge_j.canceled` moves it with `level.j` into `wf.canceled`.
  W0's first draft, `t.comp.{j}.release.canceled: level.j, read wf.canceled -> ∅`, is deleted: an
  empty output cannot be an `Out` spec (libpetri's `and()` throws "AND requires at least 1
  child"), so it forced `outputSpec: null`, against the hard rule, and the executor skips output
  validation for a null spec (libpetri 8.0.0 `dist/index.js:2429`, `:4244`). The read on a
  terminal was also what the solver struggled with (timed `deadlockFree`@cancel about 2.5 s; under
  0.3 s intercepted).
  `resumeGateViolations` rule 6 (`verify/structure.ts:107`) and `checkpointStructureViolations`
  rule 3 (`:326`) accept `compensations.exits.canceled` as the sweep target.
- **Cancel ([ADR 0004]).** No `wf.comp` transition has an arc on `wf.cancel`; compensators are
  emitted without the signal, as pipeline lane bodies are. A cancel never preempts a rollback; the
  decision happens only at the existing `wf.settle.failed` pair, so a run canceled mid-rollback
  ends `canceled` after rolling back, matching `classify` (`engine/kernel.ts:634-646`) and
  Mastra's re-stamp. No ladder transition carries an inhibitor or any arc on `wf.cancel`; the
  ladder adds no inhibited place (the entry gates still inhibit `wf.cancel`, and `parallel` keeps
  its own `err-seen`/`susp-seen`); VER-004 splits only
  `t.cancel.arrive` (W0: `inFlightTransitions`, both modes).
- **Seeds.** One shared function, `ladderLevel`, is called through the kernel's `initialCounts` —
  which `segmentInitialMarking` (`verify/properties.ts:132`) also uses — for fresh, resume and
  restart seeds; it adds
  `level.a` with `a = |{j : k_j < top-level index of the seed}|`, its stack rebuilt from the stored
  records through the run scope's existing record API (`engine/scope.ts:77-108`, read, not edited). `verify` proves `restart@p` at every boundary seeded this
  way. A restart from a marked checkpoint seeds `level.0`, because decision 4 A refuses every
  checkpoint at or after `k_1`; it is the formula, not a constant, that the kernel must share.
- **Host machinery.** A host-free emitter `compiler/blueprints/compensate.ts` (an M10 candidate);
  `StepCall.detached` for the compensator signal; the runner's `#resolveStep` for compensator
  paths; a record rewrite for a compensator that suspends dynamically (as `forgetSuspension`, row
  107). Persistence and result formatting are unchanged: the error comes from the held token
  (`mastra/result.ts:162-175`). `quotaRefsOf` (`compile.ts:543`) walks compensators since the W0
  contract, pinned by `compensate-contract.test.ts`, for the up-front checks (a duplicate quota
  id, the "where" text). A quota used only by a compensator is registered either way, lazily on
  first use (`quotaMember`), so no run observes the difference (W2).

### Claims ([ADR 0009])

**Proven** in every default segment — `closed`, `cancel`, `resume@s` ± cancel, `restart@p` ±
cancel — from that segment's marking plus `level.a`, closed net with the arrival modelled by
`t.cancel.arrive`, under VER-004 in-flight firing; enumeration while every step is immediate, SMT
when one is timed:

- **C1 `rolledBack`** = `quiescentCount({wf.comp.level.1..m}, 0, 0)`: no completed compensated
  step is left armed at rest. It ranges over quiescent markings only, so it cannot see a rollback
  that never comes to rest: C1 does **not** prove that the rollback terminates.
- **C2** = `exclusive(wf.comp.level.j, wf.settle.failed)` for j ≥ 1: no failed outcome, and no
  cancel decided over a failure, settles while a completed compensated step is uncompensated.
  With C1: *every completed compensated step has its compensator begun and settled before the
  failed terminal.* "Begun and settled" is proven; "succeeded" is not.
- **C3 (fail-fast)** = `exclusive(wf.comp.fault, p)` for p in every top-level entry input, every
  `wf.settle.*` and every terminal: nothing forward starts and nothing settles during a rollback.
- **C4 (canceled is last)** = `exclusive(wf.canceled, wf.comp.failure)`,
  `exclusive(wf.canceled, wf.comp.pending)`: a cancel never decides over a running rollback. An
  ordinary proven exclusion; in intercept mode it is no longer a premise of soundness.
- **Existing families** on the new places: `deadlockFree`, `terminatesAtSink`,
  `exactlyOneTerminal`, `neverCanceled` in `closed`; `placeBound(·, 1)` on every `wf.comp` place;
  `live` for every compensator attempt, retries included (ordinary `LivenessTarget`s). Witness
  provenance (W0): on untimed nets only the first compensator is witnessed by an executor run;
  every later one is witnessed by the verifier's enumeration, a confirmed model run with no host
  run behind it; on timed nets every witness comes from SMT.

**Checked from the arcs** (`verify/compensate.ts`, `compensateStructureViolations`, one mutant per
rule). Model checking cannot see four things, and W0 has a mutant for each that passes every
behavioural claim: *termination and at most once* — the last compensator settles back to its own
level and repeats (MUT5) — rest on S1 and S3; *cancel-free compensators* — a compensator emitted
with the signal — rest on S5; *outcome routing* — `discharge.bailed` landing in
`wf.settle.done`, or a release that consumes and reproduces a terminal — rests on S6; and *reverse
order* beyond adjacent levels. Order is claimed from the arcs on adjacent levels only (O(m), not
O(m²)); transitivity gives the rest.

- **S1.** `arm_j` takes exactly {arming_j, level.{j-1}} and gives exactly {successor(k_j),
  level.j}; arming_j's only producer is entry k_j's `next`; `level.j` (j ≥ 1) has no producers but
  `arm_j` and `settle_{j+1}.*`; successor(k_j)'s only producer is `arm_j`, so no transition of
  entry k_j (a retry's success, say) gets past the rung unarmed (W1 review: that bypass passes
  every behavioural claim).
- **S2.** Every top-level `exits.failed` is `wf.comp.failure`; `raise` is its only consumer. A
  top-level entry's outputs stay in its interior, its `next`, its arming, the ladder's exits, or
  pools.
- **S3.** `start_j` takes exactly {pending, level.j}, gives exactly {u_j.in, undoing_j}, and is the
  only producer of `u_j.in` and of `undoing_j`; each of the five `u_j` exits has exactly one
  consumer, `settle_j.<kind>`, which takes exactly {u_j.<kind>, undoing_j} and gives exactly
  {level.{j-1}, pending}; `undoing_j` has no other consumer; the rollback subgraph strictly
  descends and is acyclic (catches MUT5, with S1).
- **S4.** `finish` takes exactly {pending, level.0, fault} and is the only producer of
  `wf.settle.failed`.
- **S5.** No `wf.comp` transition has an arc on `wf.cancel`; no swept transition consumes a
  `wf.comp` place; compensator leaves carry no signal.
- **S6.** Each `discharge_j.<kind>` moves exactly one `exit.<kind>` and `level.j` to its own
  `wf.settle.<kind>` (`done` to `settleDone`); only `discharge_j.canceled` produces a terminal
  (`wf.canceled`); nothing in the ladder consumes, resets, inhibits or reads a terminal;
  `wf.settle.<kind>` for the four non-canceled kinds has no producer but its m+1 discharges.
- **S7.** Compensator attempts are exempt from suspension coverage (`compensatorAttempts`, as
  `pipelineLaneAttempts`): the exempt attempts are exactly the compensators' chains, which leave
  only by their own exits.
- **S8.** No ladder place lacks a producer and no ladder transition is dead from the arcs. W0's
  six-kind ladder had a dead `settle_j.canceled` (a compensator leaf without the signal never
  produces `canceled`) and `verify()` reported nothing, because liveness targets are step attempts
  only; this rule is what keeps a dead ladder transition from passing silently. Its mutant is that
  sixth kind.

**Tested, not proven:** the compensator's input equals the forward output, including after
rehydration; the order of records and events, and `stepExecutionPath` equal to the twin's; the detached signal; equal
`error` and tripwire shape against T0 (never identity: `formatResultError` builds a plain `Object`,
`default.ts:613-628`); `onError`/`onFinish` see compensator records; the terminal row holds them; a
dynamic suspend in a compensator rewritten `failed`; a cancel mid-rollback still finishes it; a
petri child workflow that rolls back inside itself and then fails its parent step, including the
parent's rewrap — a plain failure keeps the child's fields (`code`) on a new error; a non-retryable
child is rethrown as a new `MastraNonRetryableError` whose `cause` holds the original
(`workflow.ts:3093-3099`); a tripwire as a new `TripWire` keeping `reason`, `retry`, `metadata` and
`processorId` (`:3102-3110`) — and the child's state, which is **not** merged: the
`setState(res.state)` at `workflow.ts:3054` runs, but the parent step then throws and the write is
discarded with it (`handlers/step.ts:574-577`), writes by the child's completed steps included.
Idempotency is not tested at all.

### Behaviour

| Situation | Behaviour | T0 (default engine) |
|---|---|---|
| Entry j fails | compensators of completed `k_i < j`, newest first; then `failed`/`tripwire` with the original error | fails, nothing undone |
| A compensator fails, suspends or pauses | unresolved; the rollback continues; the run's `error` stays the original (decision 2) | n/a |
| Bail, suspend, pause | the level token discharges with the exit; nothing compensates | same |
| Cancel with no failure | `canceled`; nothing compensates | same |
| A failure under cancel, or a cancel mid-rollback | the rollback completes, then the run is re-stamped `canceled` | canceled, nothing undone |
| `Run.cancel()` mid-rollback | `endTree` closes the span tree at once (`workflow.ts:3602`); compensator spans land under an ended tree, are created, ended and exported without a throw (pinned with `@mastra/observability` 1.18.3) | n/a |
| Resume after a suspend, then a failure | compensates steps completed before the suspension, inputs rebuilt from records | nothing undone |
| Crash mid-rollback | not durable: the row is `running` from the start or a checkpoint before `k_1` (row 55); restart re-runs forward work | n/a |
| Stranded run, host precondition failure | rejects before any terminal, no rollback (rows 66, 84) | n/a |
| State | not rolled back (as Mastra): completed steps' writes persist, the failing step's own `setState` is dropped (`handlers/step.ts:574-577`); a compensator's `setState` applies; a failed petri child merges nothing into its parent | the same, nothing undone |

### Refusals

Thrown at `createStep` where the problem is visible, repeated by the adapter; the codes join the
step-option refusals beside `uses-position`. W1 builds all five; the W0 emitter had only
`compensate-position` (the last-entry case), `compensate-value` (a nested `compensate`) and
`compensate-checkpoint`.

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
   - **A. Refuse `compensate-checkpoint` (recommended for wave 1).** A restart from a marked
     checkpoint then always seeds `level.0`, so `restart@p` proofs mean what they say.
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

## Amendment (W0 spike, 2026-10-06)

Measured on a scratch copy at repo `467c0a9`: the ladder emitted by a scratch
`compiler/blueprints/compensate.ts` from `compile()`, `StepDescription.compensate` carrying the
compensator, `verify(compiled)` with defaults — structure checks on (`compensateStructureViolations`
added), all four families, every default segment, 30 s a query. Seeds are `level.a` as in Decision.
C1 is `rolledBack` in the completion set; C2–C4 are exclusions. libpetri 8.0.0 from npm, not linked
(`scripts/link-libpetri.sh --check`: "error: not linked"); z3 4.13.0. Every figure was measured with
`wf.comp.{j}.undoing` (amendment 2) already in place. An independent agent re-ran every fixture in
both modes and the mutants MUT5, MUT6, S2, S7 and S6t on a second copy, at the same provenance:
places, transitions, segments, claims, classes, routes and C1–C4 counts matched exactly; only the
segment named slowest on untimed fixtures moved (1–4 ms ties). It checked non-vacuity separately
(`placeBound(p, 0)` and `mutualExclusion` over all 18 m2 and 22 m2-with-checkpoint segments): every
`wf.comp` place, both `undoing_j`, `wf.settle.failed`, `wf.failed` and `wf.done` are reachable in
every segment; `level.2` with `failure` and `level.1` with `fault` can be marked together; in every
`+cancel` segment `wf.canceled` is reachable and `wf.cancel` can be marked beside `wf.comp.pending`
and `wf.comp.failure`, so C4 is tested against a cancel that really arrives mid-rollback. Claims
count only on `proven` or on a confirmed counterexample, never on `Unknown`.

Fixtures, intercept mode (`*` marks a compensated step; "C1–C4" counts proven claims). Measured with
six compensator exits, before amendment 3: the W1 net has one place and one transition fewer per
compensator (m1 34 / 37, m2 44 / 52, m3 55 / 69; retries 64 / 72, foreach 70 / 110, budget
45 / 52, timeouts 46 / 54, timed 48 / 56, checkpoint 46 / 56; `[a*,parallel(3),c*,d]` 63 / 74) and
one claim fewer per compensator per segment (m1 1,075, m2 1,725, m3 3,220), the same classes and
C1–C4 counts:

| Fixture | Places / transitions | Segments / claims | Classes closed / cancel | Slowest query | C1–C4 |
|---|---|---|---|---|---|
| m1 `[a*,x,z]` | 35 / 38 | 14 / 1,089 | 31 / 96 | 3 ms, `deadlockFree`@closed | 14 + 14 + 196 + 28 |
| m2 `[a*,x,b*,z]` | 46 / 54 | 18 / 1,761 | 44 / 136 | 2 ms, `deadlockFree`@cancel | 18 + 36 + 270 + 36 |
| m3 `[a*,x,b*,y,c*,z]` | 58 / 72 | 26 / 3,298 | 58 / 179 | 2 ms | 26 + 78 + 442 + 52 |
| m2, retries 2 (immediate) | 66 / 74 | 18 / 3,643 | 64 / 196 | 3 ms | all |
| m2 beside `foreach(2)` `[a*,each(2),b*,z]` | 72 / 112 | 18 / 5,650 | 184 / 556 | 34 ms, `deadlockFree`@resume@1+cancel | all |
| m2, run budget 1 | 47 / 54 | 18 / 1,797 | 44 / 136 | 2 ms | all |
| m2, `timeoutMs` 50 on `b` and on `undo-a` | 48 / 56 | 18 / 1,925 | 46 / 142 | 1 ms | all |
| m2, timed (retry delay 5 ms on `x` and `undo-b`) | 50 / 58 | 18 / 2,087 | SMT (80 smt, 2,007 structural) | 254–304 ms, `deadlockFree`@closed | all; C4 structural, 24–38 ms |
| m2, checkpoint at 0 before `k_1` | 48 / 58 | 22 / 2,526 | 46 / 142 | 2 ms | all |

Routes on untimed fixtures: enumeration, structural, and execution for liveness witnesses.

Against the design-round spike (classes closed / cancel; same shapes):

| Fixture | Design round | W0 |
|---|---|---|
| none `[a,b,c]` | 13 / 40 | 13 / 40 |
| m1 | 33 / 102 | 30 / 93 |
| m2 | 49 / 151 | 43 / 133 |
| m5 | 97 / 298 | 82 / 253 |
| m12 | 209 / 641 (0.78 s) | 173 / 533 (0.85 s) |
| `[a*,parallel(3),c*,d]` | 602 / 1,810 (checkpoint at 0) | 595 / 1,789 (no checkpoint, now refused); slowest 69–75 ms, `deadlockFree`@cancel |

- **Cost.** The first compensator costs +17 closed / +53 cancel classes (13 / 40 to 30 / 93), each
  later one exactly +13 / +40 (43 / 133, 82 / 253, 173 / 533). The design round's "+16 / +48" and
  the spike report's "+13 / +40 each" were both wrong; Decision and Consequences now say this. No
  query came near 30 s, so the value-blind redesign was not needed.
- **Amendment 1, intercept mode.** The read-arc `release.canceled -> ∅` needed `outputSpec: null`:
  libpetri cannot express an empty `Out` (`and()` throws "AND requires at least 1 child") and the
  executor skips output validation for a null spec (libpetri `dist/index.js:2429`, `:4244`). The
  premise that only `canceled` cannot be intercepted was false: sweeps emit into
  `ctx.exits.canceled` (`compile.ts:212`) and `checkpointGadget` takes the canceled place as a
  parameter (`compile.ts:308`). Replaced by `wf.comp.exit.canceled` and `discharge_j.canceled`. In
  intercept mode `wf.canceled` is produced only by the `wf.settle.*.canceled` pair and
  `discharge_j.canceled`, and every top-level sweep, checkpoint sweep and foreach `canceled.*`
  transition feeds `wf.comp.exit.canceled`. Same classes as read mode, one place more; the timed
  `deadlockFree`@cancel drops from 2,537–2,568 ms (read) to under 300 ms. C4 still proves in every
  segment of both modes (enumeration untimed, structural timed), so the terminal-release fallback
  was not needed; it is no longer a premise.
- **Amendment 2, `undoing_j`.** A leaf's exits mint new tokens, so the stack cannot pass through
  `start_j -> u_j.in`; `undoing_j` holds the rest of it. Adds m places and no classes; S3 rewritten.
- **Amendment 3, five compensator exits.** A leaf without the signal never produces `canceled`:
  `wf.comp.{1,2}.canceled` had no producer and `settle_j.canceled` was dead, and `verify()`
  reported nothing, since liveness targets are step attempts only. Chosen: five kinds, plus S8 (no
  ladder place without a producer, no dead ladder transition), so the next dead transition cannot
  pass silently.
- **Amendment 4, seeds.** "A restart always seeds `level.0`" held only at marked checkpoints, which
  must sit before `k_1`; `verify` proves `restart@p` at every boundary seeded with `level.a`. The
  kernel's fresh, resume and restart seeds and `segmentInitialMarking` call one `ladderLevel`.
- **Amendment 5, naming.** Compensator leaves are `s.<n+j-1>.<id>.*` / `t.<n+j-1>.<id>.*`, outside
  every top-level interior; the barrier family is unchanged.
- **Liveness.** Every compensator attempt is live. On untimed nets only `u_1` is witnessed by an
  executor run; every later compensator (and, with the checkpoint, both) by the verifier's
  enumeration — a confirmed model run with no host run behind it. On the timed net, by SMT.
- **VER-004.** `inFlightTransitions` splits only `t.cancel.arrive`, in both modes. Beside
  `parallel(3)`, the gadget's own splits (`collect-err`, `collect-susp`, `replay-0..2`) and
  inhibitors (`err-seen`, `susp-seen`) are identical with and without compensation.

Mutants on m2, each run with structure checks on (does `verify()` refuse it?) and with
`structure: 'skip'` (do the behavioural claims catch it?):

| Mutant | Refused by | Behavioural claims |
|---|---|---|
| MUT5: the last settle returns to its own level | S1, S3 | all hold — structure is the only guard |
| MUT6: `arm` skips the lower level | S1 | `deadlockFree`, `rolledBack`, `bound(level.0/1 <= 1)`, C2 fail |
| MUT7: `finish` without `level.0` | S4 | `deadlockFree`, `rolledBack`, C2 fail |
| MUT8: a failure bypasses `raise` | S2, S4 | `deadlockFree`, `rolledBack`, C2 fail |
| S1: `k_1`'s success bypasses arming | S1 | `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal` fail; `z`, `undo-a`, `undo-b` dead |
| S2: the last entry's failure straight to `wf.settle.failed` | S2, S4 | `deadlockFree`, `rolledBack`, C2 fail; `undo-b` dead |
| S3 | = MUT5 | as MUT5 |
| S4 | = MUT7 | as MUT7 |
| S5: a compensator emitted with the signal | S5 | all hold |
| S6: `discharge.bailed` lands in `wf.settle.done` | S6 | all hold |
| S6t (read mode): the consume-and-reproduce terminal release | S6 | all hold |
| S7: a compensator's suspended branch escapes to `wf.comp.exit.suspended` | S7 | `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal` fail |

**Proven** (intercept mode, every default segment, routes above): C1–C4, `deadlockFree`,
`terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled`@closed, `placeBound(·, 1)` on every
`wf.comp` and compensator place, `live` for every compensator attempt. **Held by structure rules
alone** — four mutants pass every behavioural claim: rollback termination and at most once (S1,
S3; MUT5), cancel-free compensators (S5), outcome routing (S6, S6t), and reverse order beyond
adjacent levels. C1 is quiescent-only and cannot see a rollback that never rests. S8 has no W0
mutant run yet; its first mutant is the six-kind ladder.

Mastra facts, pinned in scratch on `@mastra/core` 1.67.0 and both engines (27 tests); Mastra paths
under `.mastra/src-extracted/src/workflows/`:

- **T0 holds.** A forced `cloneWorkflow` (`create.ts:105-135`) runs on `DefaultExecutionEngine`
  with `options` copied, so `onError`/`onFinish` ride along. With the key as a params key or as the
  planned non-enumerable symbol, success, failure and tripwire match the run without it: status,
  error, tripwire, step records and keys (`[input, reserve, charge]`), effects and the serialized
  graph. Nothing is undone. The error is a plain `Object` `{name, message}` from
  `formatResultError` (`default.ts:613-628`); the tripwire is `{reason, retry, metadata,
  processorId}` (`:613-626`).
- **The key never reaches Mastra.** `createStep` keeps a fixed field list (`workflow.ts:510-530`);
  `serializedStepGraph` emits `id, description, metadata, component, serializedStepFlow,
  canSuspend` (`:629-640`), so a hand-built step carrying `compensate` serializes without it. The
  `stepGraph` entry holds the step by reference, so a symbol on it survives a clone. The petri
  `createStep` passes a params object through unchanged (`typescript/src/mastra/init.ts:365-391`).
- **T1 order.** Terminal persist, then `onFinish`, then `onError`, then `start()` resolves, on both
  engines (`execution-engine.ts:172-187`, `:190-205`; `default.ts:953-967`, `:985-1000`; petri
  `typescript/src/mastra/engine.ts:543-557`). `onError` sees `steps` `[input, reserve, charge]`; the
  undo runs as its own run id and the failed run's row keeps only those three; `start()` waits for
  it; a throw in `onError` is swallowed (`execution-engine.ts:200-202`). The default engine persists
  twice (`failed`, `failed`; for a tripwire `failed`, `tripwire`), the petri engine once. On cancel
  `onError` is never called; `onFinish` gets `canceled`.
- **Nested petri child** (parent on both engines, same results). A plain failure keeps custom
  fields (`code: 'E1'`) on a plain `Object` error; a non-retryable failure comes back as a new
  `MastraNonRetryableError` with the original as `cause` and `nonRetryable: true`
  (`workflow.ts:3094-3097`); a tripwire as a new `TripWire` keeping `reason`, `retry`, `metadata`,
  `processorId` (`:3102-3110`), parent `tripwire`, no `error`. Identity is never kept.
- **State.** A step that calls `setState` and then throws leaves `{a:1}`: its write is dropped
  (`handlers/step.ts:574-577`), earlier completed steps' writes persist. A failed petri child's
  `setState(res.state)` (`workflow.ts:3054`) runs, the parent step throws, and the parent stays
  `{seen:['p0'], p0:true}` — the completed child step `c1`'s write is lost too. A successful child
  merges (`{seen:['p0','c1','c2-before-throw'], …}`). Context, Behaviour and row 128 corrected.
- **Spans after `Run.cancel()`** (`workflow.ts:3602`, `endTree`), with `@mastra/observability`
  1.18.3 installed in scratch only (not a repo dependency): `cancel()` ends the run span and the
  in-flight step span `canceled`; a step that ignores abort can still open, update, `error()` and
  end a child span, and open and end a new `workflow_step` span `release` under the ended run span.
  Nothing throws, no unhandled rejection, `getIncompleteSpans()` is 0, and the late spans are
  exported after the run span's `span_ended` (`DefaultSpan.end` returns early once ended). Row 124
  cites this.
- **Not built in W0.** The emitter refused only `compensate-position` (last entry),
  `compensate-value` (a nested `compensate`) and `compensate-checkpoint`; W1 builds all five.
  The spike's `quotaRefsOf` did not walk compensators, so a quota used only on a compensator went
  unregistered; the W0 contract fixed it in `compile.ts`.

## Consequences

- Proof cost is additive: the first compensator costs +17 closed and +53 cancel classes, each later
  one +13 / +40; m=12 is 173 / 533 classes, verified in 0.85 s (W0, intercept mode); one token is in
  the rollback and the forward part is dead while it runs. A query over 30 s redesigns the net; over
  60 s asks the libpetri sessions. Never a larger budget.
- Wave 1 compensates top-level `.then()` steps only. Parallel and branch arms, foreach and pipeline
  items need per-arm or counted obligations — temporal-libpetri's `CompensationStep` shape — and are
  a later M7b wave, tracked in `tasks/todo.md`. Parallel compensation is deferred: the spine is
  sequential.
- Rollback progress is not durable (decision 4). Restart from a checkpoint before `k_1` re-runs
  forward work; compensators must tolerate it.
- The engine runs steps after a failure for the first time; every consumer of `steps` and step
  events on a failed run sees compensator records. `stepExecutionPath` stays the forward path,
  equal to the twin's (W2 decision).
- The emitter is host-free and the claims are generic over a ladder, so M10's consolidation with
  temporal-libpetri and adk-libpetri starts from code, not prose.

## Evidence

Contract in W0 (`87747e3`, merged `57a1610`); built in W1 (`5f68beb`, merged `62ed4c9`) and
integrated in W2 (`10b8790`, merged `1c83ede`); CI green on `1c83ede` (run 37471707335: `typescript`, 4 `proofs` shards, 8 `corpus` shards). libpetri
8.0.0 from npm, not linked; z3 4.13.0.

- `tests/compiler/compensate-contract.test.ts` — ten unannotated shapes keep their nets and hashes;
  the hash carries a step's `compensate` only when present; a compensator-only quota is registered.
- `tests/compiler/compensate.test.ts` — the exact `t.comp.*` list and every ladder arc; the stack's
  push and pop; 1-bounded from the arcs; no ladder inhibitor, read or reset; VER-004 splits only
  `t.cancel.arrive`; sweeps feed `wf.comp.exit.canceled`; class counts against the Amendment; the
  refusals at every position, the same keyed object reused as an arm or body included.
- `tests/verify/compensate.test.ts` — S1–S8 with a mutant per clause (two clause deletions are
  equivalent and argued), the partial bypass of `arm_j` that every behavioural claim misses; C1–C4
  and every family on m1, m2, m3 and beside `foreach(2)`.
- `tests/mastra/runner-compensate.test.ts`, `tests/mastra/compensate-surface.test.ts`,
  `tests/mastra/adapt-compensate.test.ts` — the detached signal and the detached deadline, the
  dynamic-suspend rewrite, seeds at nested resume paths, agent and tool carriers; the key, the
  `Undoable` type errors, all five refusals, `cloneStep(step, { id, compensate })`.
- `tests/engine/compensate.test.ts` — 23 cases end to end on Mastra's `Run` under a ManualClock:
  newest-first rollback before the terminal row, `onFinish` then `onError`; inputs; error and
  tripwire shape against Mastra's own clone; a failed step not undone; a compensator that fails,
  bails, suspends or aborts; a saga that succeeds, bails, or suspends then resumes and fails; cancel
  with and without a failure; a compensator's deadline surviving the cancel and a forward step's
  disarmed by it; retries; tool and agent steps; reuse through `cloneStep`; restart from a
  checkpoint before `k_1`; a `limit(1)` shared with a compensator.
- `tests/engine/compensate-next.test.ts` — petri against a forced `cloneWorkflow` (T0: nothing
  undone, equal shape) and the `onError` recipe (T1: inputs, order, callback order, and the
  double rollback when T1 is put on a petri workflow); the row 128 state facts on both engines.
- `tests/verify/compensate-blueprints.test.ts` — 17 shapes through `init()`, m up to 12, the
  per-compensator cost (+17 / +53, then +13 / +40) proven, retries immediate, timed and inherited
  from `retryConfig`, run budget 1, a timeout, `limit(1)`, beside `parallel(3)` and `foreach(2)`,
  a checkpoint before `k_1`; every family in every default segment, about 10 s alone, slowest
  query 0.25–0.30 s (`deadlockFree`@cancel, smt, the timed shape).

Not covered, and recorded: `Run.cancel()` spans mid-rollback beyond the W0 pin (row 124,
`@mastra/observability` is no dependency); a petri child rolling back then failing its parent;
resume after a cancel of a suspended run.

### Design-round spike

libpetri 8.0.0 from npm, not linked; every figure quoted with its provenance.

Design-round spike (scratch, 2026-10-06, the ladder with terminal releases, before the W0 rework;
`cancelStructureViolations` ran unchanged and passed; the full repo structure suite did not run on
it). Superseded by the Amendment's figures; kept as the "Before" column there:

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
(failure bypasses `raise`) caught behaviourally, MUT5 by structure only (S1 and S3, per W0), A0's
coverage mutant passes every family (the reason A0 is rejected).

## Divergence rows

Rows 119–129 in `docs/divergences.md`, `fixed (M7b)`; their current text, amended through W2, is
there.

## Plan (mirrors ADR 0015's waves)

- **W0 spike (scratch only), before any `src/` change — done 2026-10-06, see the Amendment;
  intercept mode replaced the read arc and `undoing_j` carries the stack.** As planned (superseded
  in part by the Amendment): the ladder through the real compile path with **structure checks
  on**, non-failed exits discharged before the settle stage, `canceled` released by a read arc
  (replaced by intercept mode), the output stack in the level token (moved to `undoing_j`). Prove
  C4; if it does not close, fall back to the measured terminal release and amend. Add
  `foreach(2)` beside compensated steps and the adjacent-level order rule. Report classes closed /
  cancel, route and slowest query per fixture; rerun MUT5–MUT8 and a mutant per S rule. Pin on
  Mastra: T0's error and tripwire shape (identity is never kept); T1's callback order; the rewrap at
  `workflow.ts:3093-3099` and the merge at `:3054` for a petri child; that a compensator's spans
  after `Run.cancel()` do not throw. A query over 30 s: the named redesign is to drop the stack from
  the token and read inputs from records (value-blind), recorded as an amendment.
- **W0 contract (lead).** `CompensationSite` and `CompiledWorkflow.compensations`; the ladder seed
  signature (`ladderLevel`); `StepCall.detached`; `StepResources.compensate`; the five refusal
  codes; `compensateStructureViolations` (S1–S8), `compensatorAttempts`; `quotaRefsOf` walking
  compensators; rows 119–129 `planned (M7b)`. Stubs
  throw `not implemented (M7b W<n>)`. Lead keeps: `src/compiler/types.ts`,
  `src/compiler/gadgets/types.ts`, `src/compiler/compile.ts`, `src/compiler/index.ts`,
  `src/mastra/index.ts`, `src/verify/index.ts`, `src/compiler/gadgets/leaf.ts` (the `detached`
  pass-through) and `src/verify/structure.ts` (the sweep target and the coverage exemption), both
  edited by the contract, ADR 0017, `tasks/todo.md`,
  `docs/divergences.md`, `README.md`.
- **W1, agents on disjoint files**, each adversarially reviewed with mutants in scratch copies:
  - net: `src/compiler/blueprints/compensate.ts`, `tests/compiler/compensate.test.ts`,
    `tests/compiler/compensate-contract.test.ts`;
  - claims: `src/verify/compensate.ts`, `src/verify/properties.ts` (seed, C1–C4),
    `tests/verify/compensate.test.ts`;
  - host: `src/engine/kernel.ts` (seed), `src/compiler/resume.ts`, `src/compiler/restart.ts`,
    `src/mastra/runner.ts`, `src/mastra/attempt-gate.ts`, `tests/mastra/runner-compensate.test.ts`;
  - surface (all five refusal codes, the side-table attach on the params path):
    `src/mastra/init.ts`, `src/mastra/resources.ts`, `src/mastra/adapt.ts`,
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
