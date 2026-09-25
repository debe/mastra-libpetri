# ADR 0008 — Step events observe the net: a lifecycle hook at Mastra's emission points, and a tee for the debug UI

Status: accepted (2026-09-25)

## Context

Through M4 a run on this engine published `workflow-start`, writer output, `workflow-paused` and
`workflow-finish`, and nothing per step (`docs/divergences.md` row 57). `run.watch()` saw no step,
and a run in Mastra Studio showed no progress. M5 closes that, and adds the libpetri debug UI as a
second observer that shows the net's marking live.

Mastra's default engine publishes step events on the run's pubsub topic
`workflow.events.v2.${runId}` at fixed points:

- a step — top level, a `.parallel()` / `.branch()` arm, a loop iteration: `workflow-step-start`
  once, before its retry loop (`handlers/step.ts:207-216`, `default.ts:212-240`), then
  `workflow-step-result` + `workflow-step-finish`, or `workflow-step-suspended`, once, after the
  last attempt (`handlers/step.ts:531-545,661-690`);
- a sleep: `workflow-step-waiting` when it begins, `-result` + `-finish` when it ends
  (`handlers/entry.ts:586-802`);
- a `.foreach()`: `-start` for the foreach, `workflow-step-progress` per item, and one result for
  the aggregate — its items publish nothing of their own, `skipEmits: true`
  (`handlers/control-flow.ts:1015-1480`).

Two ways to find those points were on the table. The plan's: an `EventStore` adapter mapping net
events (`transition-started`, `transition-completed`) to step events through the `NetMap`. And a
lifecycle hook raised by the gadgets that write each record.

The adapter reads a step's life off transition names, which cannot tell a retried attempt from the
last one without re-deriving the leaf's retry policy, and `EventStore.append` is synchronous, so a
publish could not be awaited before the firing enables its successor, as Mastra's is. The payloads
are the records the actions write, which the event does not carry.

## Decision

**A step's lifecycle is raised by the firing that writes its record**, through an optional,
observation-only `StepRunner.observe(event: LifecycleEvent)`:

- `step-settled` — a leaf's final record, after every retry; with `foreachIndex`, one item's;
- `sleep-waiting` / `sleep-settled` — a sleep's `waiting` and `success` records;
- `foreach-entered` — at `split`, or `re-enter` on a resume, before any item;
- `foreach-settled` — the foreach's aggregate record, whatever its status.

A step's **start** is the runner's first call for it (`attempt === 0`), where Mastra publishes its
start, so it needs no event of its own.

The event is raised after the record is written and before the firing's outputs, and the action
awaits it — so what the observer publishes precedes whatever the firing enables, as Mastra awaits
its publish. **It is observation only**: no arc, guard or branch reads it; `RunScope.observe`
returns `undefined` when there is no observer and the action then awaits nothing, so a run without
one fires in exactly the microtasks it did before M5; and a throw or rejection is kept as the
report's `observerError` and logged by the engine, never turned into a failed firing, which would
strand the tokens it consumed ([EXEC-031]). The net and its proofs are the same with or without an
observer. **Its outcomes are not always**: an observer that awaits takes time, and an abort landing
inside that time is seen where it would otherwise have missed — the timing window of
`docs/divergences.md` row 52, which Mastra's own outcomes show too (they change with
`emitStepEvents`). What an observer never does is choose an outcome.

The Mastra side (`src/mastra/`) maps lifecycle events to Mastra's vocabulary and payloads, gated on
`emitStepEvents` as Mastra's `publishStepEvent` is.

**The debug UI is a tee on the kernel's event store.** `RunOptions.eventStore` is appended after the
kernel's own watcher on every net event; a throw from it is kept on the report the same way. The
engine option `debug` takes a libpetri `DebugSessionRegistry` and registers one session per run
segment (`<runId>`, `<runId>~resume-<n>`), completed when the segment ends. Serving the UI — a
WebSocket speaking libpetri's debug protocol — is the testbed's, not the package's.

## Consequences

- Events are data about the run, and the differential harness compares them like the result: per
  step id in order, happens-before across steps (the fixture's declared-independent pairs may only
  weaken), foreach progress and writer chunks inside their owner's span, clock keys by presence with
  their values masked, and `stepCallId` by its correlation rather than its value.
- Spans hang off the same two points: a step's span opens at the runner's first call and ends or
  errors at `step-settled`; foreach, parallel, conditional and loop spans come from the lifecycle
  events and the runner's condition calls (`docs/divergences.md` rows 30, 59, 60). They are built
  only when the run has a workflow span, so a run without tracing takes no extra microtask.
- An awaited publish delays a firing's outputs by the publish's latency — per step, independently,
  so parallel arms and foreach items pay it concurrently, as Mastra's do. A single publish queue for
  the run was tried first and serialised a `.parallel()` behind a slow pubsub (found by the M5
  verifier: 5 arms at 20ms latency started 21ms apart instead of together).
- A publish that rejects rejects Mastra's run (`default.ts:212-240`, `handlers/step.ts:672-690`).
  Here it is kept and logged, and the run goes on — observation only, recorded in
  `docs/divergences.md`. A step whose result publish rejected publishes no finish, as in Mastra.
- `startedAt` in a start event is the record's own stamp (`StepCall.startedAt`), not a second
  reading of the clock: Mastra's are one `startTime` (`handlers/step.ts:166,172`).
- `StepCall.iteration` carries a loop's iteration to the runner, for a start event's
  `metadata.iterationCount`.

## Evidence

The contract is typechecked and every pre-M5 test passes with the hook in place (1356 compiler,
engine and Mastra tests). `tests/engine/lifecycle.test.ts` pins which events fire, in which order,
and that a throwing or rejecting observer leaves outcome and records unchanged.
`tests/mastra/events.test.ts` and `tests/mastra/spans.test.ts` compare events and span trees with
the default engine's; the differential gates events on every fixture. Figures in `tasks/todo.md` M5.
