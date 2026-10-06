# ADR 0016 — `supersede()` is deferred: one Mastra run has no new input to supersede; a speculative latest-wins block is designed, measured and kept on file

Status: deferred to M8 (2026-10-06, M7b second wave). Maintainer decision taken: 1 A, defer;
7 A, the README row reads "deferred to M8". The README row is rewritten, and design D1 is
specified to contract level so it can be built later without redoing the work. Decisions 2–6
apply only to a build and stay open. Spikes in scratch only; libpetri
8.0.0 from npm, not linked (`scripts/link-libpetri.sh --check`: "not linked"). Mastra
`@mastra/core` 1.67.0 (`scripts/mastra-pin`); Mastra paths are under
`.mastra/src-extracted/src/workflows/`.

## Context

README's blueprint table promises `supersede()`: "new input invalidates in-flight work", because
"a cancelled flag read inside an action is the classic stall". Every other blueprint in the table
names a gap in Mastra's IR. This one names a gap that needs an *input*, and the question this ADR
answers first is where that input comes from.

**No channel delivers data into a running Mastra run.** Traced in the pinned sources:

| Channel | What it does | Can newer input meet in-flight work? |
|---|---|---|
| `run.cancel()` | aborts the run's controller, writes `canceled` (`workflow.ts:3595-3621`) | the only outside event that reaches a live run; it carries no data. Already `wf.cancel`, the kernel's only environment place (`engine/kernel.ts:219`, `:254`) |
| Resume | waits up to 2 s for a `suspended` snapshot (`utils.ts:795-830`), else throws `'This workflow run was not suspended'` (`workflow.ts:4600-4607`); a block is stored suspended only after `Promise.all` over its arms (`handlers/control-flow.ts:220`, `:540`) | no: nothing is in flight when a resume can arrive |
| `waitForEvent` / `sendEvent` | removed: throws `WORKFLOW_WAIT_FOR_EVENT_REMOVED`, "use suspend & resume" (`workflow.ts:2178-2193`); `sendEvent` absent, `evented/` included | n/a |
| `.foreach` | the array is fixed when the entry starts (`control-flow.ts:1050`), queued in order (`:1272`) under `fastq(worker, concurrency)` (`:1225`), the abort checked only before dispatch (`:1157-1172`) | only "newer" items produced by the run itself, every one known at entry start |
| `.dowhile` / `.dountil` | sequential (`executeLoop`, `control-flow.ts:679`), abort checked between iterations (`:740-742`) | iterations never overlap |
| `stream` / `watch` | output only; `inputData` taken once (`workflow.ts:4039`) | no |
| `restart`, `timeTravel` | `restart` continues a dead run with no new input (`:4449`, `:4859`); `timeTravel` throws on a running run (`_timeTravel`, `:4993`) and is refused here (rows 40, 54) | no |
| A new run, same `resourceId` | `createRun` neither dedupes, cancels nor looks up by it (`workflow.ts:2704-2760`); the scheduler has no overlap policy | **the only place newer input logically meets older work**, across runs; Mastra does nothing |
| Agent layer (not a workflow) | `sendSignal` with `ifActive`/`ifIdle`, declining a pending approval with `interrupted_by_user_message` (`agent-controller/session.ts:3470-3540`); `SessionMode.switch` uses a version counter (`:1690-1760`) | yes: Mastra's real latest-wins lives here, outside workflows (M8) |

So inside one run "new input" is either produced by the run itself, or arrives through an entry
point this engine would add and Mastra has no word for.

**What latest-wins means elsewhere.** RxJS `switchMap` tears the previous inner down and does not
wait; Kotlin `collectLatest` cancels **and joins** the previous block before starting the next;
Temporal runs each unit in a `CancellationScope` (`TRY_CANCEL` does not wait,
`WAIT_CANCELLATION_COMPLETED` does) and, across runs, `TERMINATE_EXISTING`. libpetri's design
skill (pattern §11) says: stamp at the fork, carry the stamp in the token, compare at commit, and
a stale skip still emits its completion marker. adk-libpetri's N1 sketches that pattern for
turns (illustrative, not proved); its G1 records that an abort clearing only what is at rest lets
a running action's late output land in the next turn. libpetri's research journal found that a
barge-in hub resetting every stage violates `MutualExclusion(SPOKEN, ABORTED)`, that a hub plus a
standing marker deadlocks, and that bugs appeared only at k ≥ the number of interacting events.

**This engine's pieces.** [ADR 0014]'s preemption: a host-owned verdict (`attemptGate.freeze()`,
first source to fire wins), the leaf's `preempted` xor branch, losers aborted and waited for, one
`AbortController` per block path per segment (`engine/scope.ts:210-239`), and
`StepPreemptedError.outcome: 'met' | 'short'`, a closed union (`compiler/preempt.ts:17-29`).
[ADR 0004]'s structural cancellation, and its amendment: an environment place sends every proof to
SMT (0 of 103 enumerated, slowest 411 s), while the same proofs with the arrival in the net and the
request seeded run by enumeration in 18–29 ms. [ADR 0015]'s frames, item scope
(`RunScope.itemRecords`) and twin.

Six shapes were weighed. Five were spiked:

| | S1: keyed on the item, over `.foreach` | S2: keyed on a stage's output, over `pipeline()` | D1: speculative latest-wins block | D2: in-run input channel | D3: across runs, by `resourceId` |
|---|---|---|---|---|---|
| Newer input comes from | a later array item | a later item whose stage-`a` output has the same key | a producer step looping inside the run | a new Layer 3 API, `latest.send(run, input)` | a newer run |
| Is it better than Layer 1? | **never**: every key is known at entry start (`control-flow.ts:1050`), so it is a "last per key" step before the `.foreach()`, which wastes no work and has no timing-dependent outcome | latency only: two `.foreach()`es with a dedupe step between them give the same survivor with no wasted work, behind a barrier | latency only, and only through `key` adoption: without it, the final value always restarts the consumer and the twin is as fast | yes: no Layer 1 or 2 equivalent | user code over `oldRun.cancel()` already does it |
| Measured proof cost | not spiked | ×1.4–2.0 over `pipeline` at the same bounds; (2,2) cancel at 44.5k of the 50k cap; Σc = 5 on SMT at 8.7–9.4 s per query | **fixed**: 77 / 262 classes, slowest 14 ms; timed render 1.7 s, timed witness 8.9–12.3 s (SMT) | seeded arrivals stay on enumeration: closed = 28 + 35k, cancel = 87 + 109k classes, linear in k; whole workflow ×(k+1) over the upstream net; `parallel(4)` k=3 at 38.7k | none: no net |
| Host machinery | per-item controllers, widened gate reason | per-item controllers, registry, widened gate reason | `RunScope.forgetPreemption`, a new error class, an adapter case | live-run registry by `runId`, generation-keyed controllers, injection API, ack resolution | a run registry |
| Verdict | **refused**: a Layer 1 dedupe | on file | **on file, the build option** | on file, M8 | recipe, not a blueprint |

## Decision

**Defer `supersede()` out of M7b. The pinned Mastra delivers no new input to a running run, so the
README's promise has no subject inside one run. What remains buildable inside one run is
speculation — start the consumer on an early value, abort it when a newer one arrives — whose only
gain over Layer 1 is latency, and whose only gain over its own twin comes through a `key`. The
real latest-wins demand (user interjection, barge-in) is the agent layer's, which is M8, where
Mastra already has `sendSignal`. D1 is specified below to contract level, with its spike, so
decision 1 B builds it without redoing the work.**

What lands in the deferral (decision 1 A):

- The README row is rewritten (decision 7):

  | `supersede()` | *deferred to M8* ([ADR 0016]): latest input wins over in-flight work | Mastra 1.67.0 delivers no input to a running run; the in-run form needs an input channel, which belongs with the agent layer's `sendSignal` |

- `tasks/todo.md` moves `supersede()` from the M7b second wave to M8, beside agents, naming D1, S2
  and D2 by this ADR's sections.
- No code, no divergence rows (nothing behaves differently), and no claims.
- The cross-run case is documented as a recipe (D3), not built.

### Refused: S1, supersession keyed on the item over `.foreach`

The array is fixed and every item's key is computable when the entry starts
(`control-flow.ts:1050`); items are queued in input order (`:1272`). Running item k and preempting
it when a same-key item k′ > k is admitted only adds wasted work and an outcome that depends on
`concurrency` and timing, against never starting k. At `concurrency: 1` it preempts nothing. A
Layer 1 step before the `.foreach()` that keeps the last item per key is strictly better, and runs
unchanged on `DefaultExecutionEngine`. This is why a future `supersede()` never takes a key off
the item.

### Recipe: D3, latest run wins by `resourceId`

`createRun` ignores `resourceId` (`workflow.ts:2704-2760`), so the decision lives outside every
net: keep the latest run per key in the caller and call `oldRun.cancel()` before starting the
next. Temporal's `TERMINATE_EXISTING` is the same shape. Documented in the README's
blueprint table; nothing to prove.

### On file: D1, the speculative latest-wins block (the build option)

**Surface (Layer 3, `PetriEngineType` brand).**

```ts
const { createWorkflow, createStep, supersede } = init();
wf.then(supersede(pollDoc, summarize, {
  id: 'latest-summary',                       // the minted body's id, the record key
  until: ({ inputData }) => inputData.stable,  // Mastra's LoopConditionFunction, over pollDoc's output
  key: (doc) => doc.version,                  // same key: keep the summary already running
  iterationBound: 50,                         // required, as for any loop (row 13)
}));
```

- `supersede` mints a petri nested workflow `createWorkflow({ id, inputSchema: poll.in,
  outputSchema: render.out, stateSchema: <copying>, validateInputs: true }).dountil(poll,
  until).then(render).commit()`, re-branded `PetriStep` and marked under a module-private symbol;
  the copying state schema and `validateInputs` are ADR 0015's W0 twin facts. Both steps must be
  `PetriStep`, so a default-engine step is a type error.
- `.then(step)` takes no options (`workflow.ts:1941-1956`), so the mark rides the minted body and
  the adapter matches the `.then` entry's step by identity (agent and tool steps by ref and
  options identity, ADR 0014's `matchMinted`).
- Vocabulary: `id`, `until`, `key`, `iterationBound` — Mastra's loop words plus one. No Petri words.

**Why Layer 3.** As ADR 0015 decision 1A: poll and render run in the parent's run, not a child
run; superseded render attempts run, are aborted and waited for, and are recorded `canceled`;
with `key`, the committed result may come from an earlier value with the same key.

**Twin.** A forced `cloneWorkflow` on `DefaultExecutionEngine` ignores the mark and runs
`.then(body)` as a child run: poll until `until` holds, then render once on the final value v_f.
**Twin relation (tested, deterministic steps, no failure or cancel):** the petri output equals
the twin's, except when a render on an earlier value v_j with `key(v_j) === key(v_f)` was adopted,
in which case it equals `render(v_j)`. Only attempts and their side effects differ otherwise.
Pinned by a twin test with a forced `cloneWorkflow`, as `race-next.test.ts`.

**Net** (gadget `compiler/blueprints/supersede.ts`; 15 gadget places, all 1-bounded; ¬ = inhibited
by `wf.cancel`, ? = reads it). Render is emitted through `ctx.emitNested(render, [...path, 1],
con.done, conExits, { preempt: { place: con.preempted, block: path, blockId } })` — ADR 0014's
`ArmPreemption` as it stands.

```text
fork            ¬cancel  in -> poll.in + idle + pending.empty + live
cancel          ?cancel  in -> exits.canceled
judge           ¬cancel  src.done + pending.empty -> xor(poll.in + pending.more, pending.last)   action: until(v)
judge.conflate  ¬cancel  src.done + pending.more  -> xor(poll.in + pending.more, pending.last)   (older datum dropped; no reset)
src.sweep       ?cancel  src.done -> src.gone
start.{more,last} ¬cancel idle + pending.{more,last} + read(live) -> render.in + busy.{more,last} + pending.empty
supersede.more  busy.more + pending.more -> xor(doomed + pending.more    [action: scope.preempt(path, StepSupersededError)],
                                                busy.more + pending.empty [same key: datum dropped])
supersede.last  busy.more + pending.last -> xor(doomed + pending.last    [preempt],
                                                busy.last + pending.empty [same key: adopt])
stale.{done,fault,preempted}  con.X + doomed -> idle             action: scope.forgetPreemption(path); discard the generation
commit.done     con.done + busy.last + pending.empty + live -> next
commit.{fault,preempted}      ... -> exits.failed                (preempted: unreachable at runtime; a terminal for soundness)
src.fail.idle.{empty,more}    src.fault + idle + pending.X + live -> exits.failed
src.fail.busy   src.fault + busy.more + live -> doomed + src.fault.held   [preempt]
src.fail.held.{empty,more}    src.fault.held + idle + pending.X -> exits.failed
cancel.busy     ?cancel  busy.more -> doomed                     (the run's signal reaches render; no preemption)
canceled.{empty,more}   ?cancel src.gone + idle + pending.X + live -> exits.canceled
canceled.last           ?cancel idle + pending.last + live -> exits.canceled
```

- **Latest-wins at commit is a token, not a flag.** `commit.done` needs `busy.last`, which only
  `start.last` and the adopt branch produce, and `pending.empty`. A stale generation holds
  `doomed`, whose only consumers are `stale.*`, and those produce `idle`, never `next`. libpetri
  §11's stamp is the lane state; the comparison is which place the lane token is in. No action
  reads a signal or a flag: the README row's stall is designed out.
- **Cancellation is structural ([ADR 0004]).** `fork`, `judge` (Mastra's between-iteration check,
  `control-flow.ts:740-742`) and `start.*` are inhibited; every state where work waits has a sweep
  or a finisher; commits are not gated, because the top-level settle re-stamps them.
- **Preemption is structural ([ADR 0014]).** The verdict stays the host's, frozen once per attempt;
  the leaf maps it onto `con.preempted`. The stale generation is aborted **and waited for** before
  `idle` returns (Kotlin's join, Temporal's `WAIT_CANCELLATION_COMPLETED`), so at most one render
  generation is in flight and one controller key per path suffices.
- **Monotone.** No gadget place carries an inhibitor, reset, drain or `atLeast`; `wf.cancel` stays
  the only non-monotone place and, under VER-004, the only split is still `t.cancel.arrive`
  (measured).
- **Growth is fixed:** one producer, one lane, the generation count as colour. One proof covers
  every iteration count.

**Host.**

- `RunScope.forgetPreemption(path)`, called in the `stale.*` firing, which also produces `idle`;
  the next `start.*` therefore always draws a fresh controller. The 1-bounded lane orders it; the
  map does not grow (decision 4).
- `StepSupersededError { kind: 'superseded', block, path, generation }`, a class of its own
  (decision 3): `StepPreemptedError`'s message, "decided (…) without this arm"
  (`compiler/preempt.ts:28`), is wrong for a superseded generation, and its closed `met | short`
  union and round-trip test stay as they are. `GateVerdict.preempted.reason` widens once to
  `StepPreemptedError | StepSupersededError`; own enumerable fields, so it survives a JSON round
  trip.
- Item scope per generation, reusing ADR 0015's `openItem` / `closeItem`: render's records and
  `setState` sit in a per-generation item snapshot, merged on commit, discarded on `stale.*`
  (decision 6).

**Claims D1 would ship with.**

- **Proven** by enumeration while every step is immediate, in `closed` (= `restart@0`), `cancel`
  and `restart@p` when checkpointed (no resume segment), each reported with property, initial
  marking, environment mode and route:
  - `deadlockFree`, `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled` (closed) — **no
    supersession at any interleaving strands the run**, the stall the README row names;
  - `placeBound(·, 1)` on all 15 places;
  - **one render generation in flight:** pairwise `mutualExclusion` over `{idle, busy.more,
    busy.last, doomed}`. Not D2's `quiescentCount(…, 1, 1)` complement: `commit.*` and the
    finishers consume the lane token, so at a terminal the count is 0, not 1;
  - **one pending datum:** pairwise `mutualExclusion` over `{pending.empty, pending.more,
    pending.last}`;
  - **nothing newer after the final value is adopted:** `mutualExclusion(busy.last, pending.more)`
    and `mutualExclusion(busy.last, pending.last)`;
  - **a failed poll leaves no live render:** `mutualExclusion(src.fault.held, busy.more)`;
  - pools and quotas, unchanged.
- **Proven reachable** (definitive, confirmed `Violated`; `Unknown` fails the test; immediate
  fixtures only): `reach(doomed)`, `reach(con.preempted ∧ doomed)`, `reach(busy.last ∧ con.done)`.
- **Checked from the arcs** (`verify/supersede.ts`, one mutant each):
  1. **The latest-wins rule:** only `commit.*` writes `next` or the block's exits, and every
     commit consumes `busy.last`. Its mutant is D2's `commit.stale` transplanted (`con.done +
     doomed -> next`): D2's spike showed a stale commit can pass every behavioural claim, so this
     guarantee rests on the arcs, whatever W0 finds the behavioural claims catch.
  2. `busy.last` comes only from `start.last` or the adopt branch.
  3. `doomed` comes only from `supersede.*`, `src.fail.busy` and `cancel.busy`; only `stale.*`
     consume it, and each produces `idle`.
  4. Every `start.*` reads `live`.
  5. No gadget place carries an inhibitor, reset or drain; `fork`, `judge*`, `start.*` are
     inhibited by `wf.cancel`.
  6. Each `con.*` exit has exactly one stale and one commit consumer.
- **Unclaimed:** liveness of `con.preempted` — the verifier can take that branch before any
  supersession, so a proof would be vacuous (ADR 0014's `collect-preempted-i`).
- **Tested, not proven:** the twin relation above; the committed value is the final generation's
  or the adopted key's; `preempt` is called on every doomed branch; losers stop promptly;
  `forgetPreemption` ordering; per-generation records and state; overlap under ManualClock.

**Suspend, resume, restart, cancel.** A poll or render suspension ends the block `suspended`, no
resume site is registered, and `Run.resume` naming the body, poll or render is refused at seed
time with `UnsupportedRunModeError` (reason `supersede`), before anything persists (rows 117, 77
precedent); attempts are exempt from coverage through a structure rule, as `pipelineLaneAttempts`.
`metadata.checkpoint` on the `.then(body)` entry is allowed and a restart re-runs the block from
poll. A run abort against a supersession follows ADR 0014's first-fired verdict unchanged.
`timeTravel` and `perStep` stay refused (rows 40, 54).

**Refusals** (thrown at mint, repeated by the adapter; `supersede-value` joins
`BLUEPRINT_REFUSALS`): `supersede-value` (missing `id` or `iterationBound`; `until` or `key` not a
function); `blueprint-arms` (poll and render the same step or sharing an id; a nested-workflow
step, M8; a body or `stepGraph` not the minted one); `blueprint-position` (the body on any entry
but `.then`, inside a race arm, foreach, loop or pipeline, or a blueprint marker on poll or
render); `blueprint-reused`; `checkpoint-position` on poll or render.

### On file: S2, supersession keyed on a stage's output inside `pipeline()`

`supersede([resolveDoc, embed, store], { id, key: (doc) => doc.docId, after: resolveDoc,
concurrency })` spread into `.foreach()`, reusing ADR 0015's minting, item scope, `Chained<S>`
typing and twin (`.foreach(body, { concurrency: Σc })`, every item runs). A single `registry` token
is the linearization point: the stamp after stage `a` takes and returns it and routes the item by
`xor(fresh | stale | failed)`; the last-stage collect and every bail after `a` take and return it
as the commit check; it is never tested, so VER-004 splits nothing new. Older items are aborted
without a join (`switchMap`, `TRY_CANCEL`); results already committed are never taken back.
Twin relation: `petri[k]` is `twin[k]` or a hole, and the highest-index item per key that reached
stage `a` is never a hole by supersession.

Measured over 50 cases (every claim held, no query over 30 s): see the comparison table. Known
weak points: the survivor per key is deterministic but holes depend on timing and concurrency;
the (2,2) cancel segment sits at 89% of the enumeration cap, so a sibling block tips it onto SMT;
the gain over two `.foreach()`es with a dedupe between them is pipelining latency only. If built:
controllers keyed per item, opened with `itemRecords(path, k).open` and dropped at `forget`, so a
late supersede is a no-op — the shape D1's `forgetPreemption(path)` cannot serve across lanes —
and an arc rule with a mutant that every last-stage collect and every bail after `a` consumes and
returns `registry`. Pre-named redesign if a fixture crosses 30 s: segments seeded at the block
boundary, never a larger budget.

### On file: D2, an in-run input channel (the M8 contract sketch)

`const latest = supersede(search)` marks a top-level `.then` step; `await latest.send(run,
input)` reaches the live petri run through `Run.executionEngine` (public, `workflow.ts:3489`). A
send while the step has not handed its result on preempts the attempt, joins it, and re-runs the
step on the newest accepted input; the hand-off is the linearization point. The window
`notyet | open{g} | pending{g, data} | shut` is a complement (`quiescentCount(…, 1, 1)`, proven),
and `commit` needs `open`, so `pending` blocks a stale commit.

Kept for M8, with three corrections to the brief that recommended deferring it:

- **Proof cost is not the obstacle.** ADR 0004's 0-of-103 / 411 s figure is an *unbounded*
  environment place; following its own amendment — arrival in the net, k requests seeded,
  injection into the very place the proof seeds — classes grow linearly in k (closed 28 + 35k,
  cancel 87 + 109k) and stay on enumeration up to `parallel(4)` upstream at k = 3 (38.7k classes,
  2.8 s). The real costs are elsewhere: proofs cover only k ≤ 2 seeded arrivals while runtime sends
  are unbounded (`placeBound(sup.request, 1)` cannot hold with k seeded); every unrelated upstream
  block pays ×(k+1); accepted inputs are never persisted, so restart and resume cannot reproduce
  the result; the live-run registry is in-process only.
- **The ack is a closed union, decided by a firing:** `{ accepted: true, generation } | {
  accepted: false, reason: 'not-started' | 'finished' | 'canceled' | 'not-running' | 'invalid' |
  'unsupported' }`. Every request is answered by a transition action and the host only observes;
  `invalid` is decided host-side against `inputSchema` before injection, so an invalid send never
  preempts a valid attempt. The twin answers `unsupported`, which is exactly the petri outcome of
  the schedule where every send arrives late.
- **Latest-wins at commit must be an arc rule:** D2's `commit.stale` mutant (`done + pending ->
  next`) passed every behavioural claim.

Pre-named redesign if a fixture crosses 30 s: site-local segments seeded at the site's boundary,
which removes the ×(k+1) upstream factor (it rests on `early` commuting with upstream, to be
proven, not assumed). M8 should weigh D2 against Mastra's own `sendSignal` semantics
(`ifActive`/`ifIdle`) before choosing an API.

## Maintainer decisions

Taken 2026-10-06: 1 A, 7 A. Decisions 2–6 stay open until a build is chosen.

1. **Build `supersede()` now, or defer?**
   - **A. Defer to M8 (recommended).** README row rewritten; D1, S2, D2 on file; D3 a recipe.
   - B. Build D1 in M7b wave 2 (the W0–W3 plan below).
   - C. Build S2 in M7b wave 2 (the pipeline-keyed form).
   - D. Build D2 now, ahead of the agent layer.

   **Recommended: A.** Mastra 1.67.0 cannot deliver input to a running run; D1 and S2 are latency
   speculation with a Layer 1 equivalent; D2 invents a run API with no Mastra word and an
   unpersisted input. ADR 0002: a blueprint without demand is not done work. If B or C, the
   README row names the narrower promise instead (decision 7).
2. **If built (1 B): is `key` required?**
   - **A. Required (recommended).** Without it the final value always restarts render, so the twin
     is as fast and only waste remains.
   - B. Optional, defaulting to "never equal".
3. **The reason a superseded attempt carries.**
   - **A. A new `StepSupersededError` (recommended).** Keeps ADR 0014's closed `met | short` union
     and its message; the gate's reason widens once.
   - B. Widen `StepPreemptedError.outcome` to `'met' | 'short' | 'superseded'`. One row writer, but
     a message that says "decided without this arm".
4. **Preemption per generation.**
   - **A. `RunScope.forgetPreemption(path)` in the `stale.*` firing (recommended).** The 1-bounded
     lane orders it; no map grows.
   - B. Controllers keyed by `(path, generation)`. Needed for S2 or D2, not for D1.
5. **A speculative render that fails.**
   - **A. Hold it until superseded or adopted (recommended).** Matches the twin, which never
     renders a non-final value; the net above does this.
   - B. Fail fast. An outcome the twin cannot produce.
6. **State written by a stale generation.**
   - **A. Discard, through a per-generation item snapshot (recommended).** ADR 0015's
     `openItem` / `closeItem`.
   - B. Apply it on an `own` verdict. A stale generation's writes leak into the run.
7. **The README row.**
   - **A. "Deferred to M8: needs an input channel" (recommended, with 1 A).**
   - B. Remove the row.
   - C. Narrow it to D1's promise, "a consumer started on early values, the latest kept" (with 1 B).

## Consequences

- With 1 A, nothing in `src/` changes; the README stops promising what the host cannot deliver,
  and the M8 agent work inherits three measured designs and a contract sketch.
- S1 is refused for good: a supersede never keys on the item, because a Layer 1 dedupe dominates
  it.
- If D1 is built: proof cost is fixed (77 / 262 classes, independent of iteration count and of the
  upstream net); a timed render moves its segment to SMT (1.7 s), and the reachability witness is
  claimed on immediate fixtures only, because the timed one took 8.9–12.3 s. A query over 30 s
  redesigns the net (named in W0); over 60 s asks the libpetri sessions. Never a larger budget.
- If D1 is built, losers are aborted and waited for, so a render that ignores its signal holds the
  block, its permits and its quotas, as an ADR 0014 loser does; rows 108–110 extend to render
  losers.
- Divergence rows 119–126, `planned (M7b)`, only with 1 B.

## Evidence planned

Only with 1 B. libpetri 8.0.0 from npm, not linked; every figure quoted with its provenance.

- `tests/compiler/supersede-contract.test.ts` — unannotated workflows compile to the nets and
  hashes they had before; the hash carries a supersede only when present.
- `tests/compiler/supersede.test.ts` — the exact transition list; 1-bounded from the arcs;
  `wf.cancel` the only inhibited place; VER-004 splits only `t.cancel.arrive`.
- `tests/verify/supersede.test.ts` — the six arc rules, a mutant per rule (rule 1's mutant is
  `commit.stale`, also run against the behavioural claims with the result recorded); the coverage
  exemption, not vacuous; the bounds, complements and exclusions; the three reachability witnesses
  as confirmed `Violated`.
- `tests/engine/preempt-scope.test.ts` (extended), `tests/mastra/runner-supersede.test.ts` —
  `forgetPreemption` gives the next generation a fresh controller; `StepSupersededError` round-trips
  through JSON; per-generation records and state merged on commit and discarded on stale.
- `tests/mastra/supersede-surface.test.ts`, `tests/mastra/adapt-supersede.test.ts` — the factory,
  the brand as `@ts-expect-error`, every refusal, agent and tool steps matched by ref and options
  identity.
- `tests/engine/supersede.test.ts` — end to end on Mastra's `Run` under a ManualClock and event
  gates, no timers: supersession, adoption by key, a failing speculative render held, poll failure
  with a live render, cancel during each lane state, restart from a checkpoint, every resume
  refused by name, `limit(1)` and run budget 1 peaks.
- `tests/engine/supersede-next.test.ts` — petri, a forced `cloneWorkflow` and a pure-Mastra twin:
  the twin relation, attempt counts, state.
- `tests/verify/supersede-blueprints.test.ts` — shapes through `init()` (bare, run budget 1,
  `limit(1)` on render shared with a parent step, retries, a timeout, a timed render), every family
  in every default segment, slowest query recorded.

## Divergence rows planned (only with 1 B)

| # | Behaviour | Classification | Note |
|---|---|---|---|
| 119 | `supersede()` | addition | No Mastra word for a consumer started on early values. `init().supersede(poll, render, { id, until, key, iterationBound })` (Layer 3) mints a petri nested workflow `dountil(poll, until) -> render`; on the petri engine render starts on each value poll produces and a newer value preempts it. The twin renders once on the final value |
| 120 | Superseded render attempts | addition | They run, are aborted and waited for, and are recorded `canceled` with `StepSupersededError`; never retried; watchers see several start/result pairs for render's id in one entry, where Mastra emits one |
| 121 | Adoption by `key` | addition | The result can come from an earlier value with the same key, where the twin renders the final value |
| 122 | No child run | replaced | As row 112: poll and render live in an item store, not a nested run |
| 123 | Retries per step | replaced | As row 113: the twin re-runs the whole body under the parent's `retryConfig` |
| 124 | State across generations | replaced | Each generation's `setState` sits in a per-generation snapshot, merged only on commit, discarded when stale |
| 125 | A suspended supersede is not resumable | refused (M7b) | The block ends `suspended`; `Run.resume` naming the body, poll or render throws `UnsupportedRunModeError` (reason `supersede`) before anything persists (rows 117, 77) |
| 126 | Supersede shapes refused | refused (M7b) | `supersede-value`, `blueprint-arms`, `blueprint-position`, `blueprint-reused`, `checkpoint-position` as listed in Decision |

Rows 108, 109 and 110 are amended to name render losers (a retry delay is finished, a rate token is
spent, a quota is drawn first).

## Plan (only with 1 B; mirrors ADR 0015's waves)

- **W0 spike (scratch only), before any `src/` change.** D1 through the real compile path
  (registered gadget, not a swapped `parallel` carrier), with the loop's iteration budget and one
  exit place per Mastra exit kind (done, failed, bailed, suspended, paused, preempted) instead of
  the spike's folded `con.fault`; shapes: bare × ± run budget 1, `limit(1)` on render, render
  retrying 2 × 5 ms (SMT), a sibling `parallel(3)` beside the block, and the `restart@p` segment.
  Report classes closed / cancel, route, slowest query; the three witnesses; every arc-rule mutant,
  and whether `commit.stale` is caught behaviourally. Any query over 30 s: the named redesign is to
  fold the non-done exits back into one place carrying the kind as colour (value-blind, the spike's
  shape), recorded as an ADR amendment. Also pin: `dountil`'s spread with a minted body under
  `npm run check`; whether the twin's child validates render's output schema at its end.
- **W0 contract (lead).** `SupersedeSite` and `CompiledWorkflow.supersedes`, `NestedOptions` reuse,
  `RunScope.forgetPreemption` signature, `StepSupersededError`, `ResumeRefusal.reason
  'supersede'`, the `SUPERSEDE` marker / `supersedeOf`, `PetriSupersede` on `init()`,
  `supersede-value` in `BLUEPRINT_REFUSALS`, `supersedeStructureViolations`,
  `supersedeAttempts`; `structuralHash` carries a supersede only when present; rows 119–126
  `planned (M7b)`. Stubs throw `not implemented (M7b W<n>)`. Lead keeps:
  `src/compiler/types.ts`, `src/compiler/gadgets/types.ts`, `src/compiler/compile.ts`,
  `src/compiler/index.ts`, `src/mastra/index.ts`, `src/verify/index.ts`, ADR 0016,
  `tasks/todo.md`, `docs/divergences.md`, `README.md`.
- **W1, agents on disjoint files**, each adversarially reviewed with mutants in scratch copies:
  - net: `src/compiler/blueprints/supersede.ts`, `tests/compiler/supersede.test.ts`;
  - claims: `src/verify/supersede.ts`, `tests/verify/supersede.test.ts`;
  - host: `src/engine/scope.ts`, `src/compiler/preempt.ts`, `src/mastra/attempt-gate.ts`,
    `src/mastra/runner.ts`, `tests/engine/preempt-scope.test.ts`,
    `tests/mastra/runner-supersede.test.ts`;
  - surface: `src/mastra/supersede.ts` (new), `src/mastra/adapt.ts`, `src/mastra/init.ts`,
    `tests/mastra/supersede-surface.test.ts`, `tests/mastra/adapt-supersede.test.ts`.
- **W2 integration, agents on disjoint files:** `tests/engine/supersede.test.ts`,
  `tests/engine/supersede-next.test.ts`, `tests/verify/supersede-blueprints.test.ts`.
- **W3 (lead):** ADR 0016 accepted with Evidence; rows 119–126 `fixed (M7b)`, rows 108–110
  amended; README row per decision 7 C; CI green.

With 1 A the plan is one lead commit: this ADR `accepted` as *deferred, design on file*, the README
row and the D3 recipe, and the todo entry moved to M8.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0004]: 0004-structural-cancellation.md
[ADR 0009]: 0009-verification-claims.md
[ADR 0014]: 0014-race-and-quorum.md
[ADR 0015]: 0015-pipeline.md
[ADR 0016]: 0016-supersede.md
