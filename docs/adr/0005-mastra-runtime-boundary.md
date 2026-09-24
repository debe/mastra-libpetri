# ADR 0005 — The engine is Mastra's class; steps run on Mastra's executor; the net schedules

Status: accepted (2026-09-24)

## Context

Two statements in CLAUDE.md could not both hold. Hard rule 3: the engine **extends
`ExecutionEngine`** and owns `execute()`. The source layout: the package **never imports Mastra at
runtime**. `ExecutionEngine` is a runtime class, and it is nominally typed — `MastraBase` carries a
`#private` marker and `ExecutionEngine` a `private` field — so no structural mirror is assignable to
`createWorkflow({ executionEngine })`. Satisfying the hard rule means importing `@mastra/core`.

The second question was who runs a step. `DefaultExecutionEngine.executeStep` retries internally,
persists, and emits; driving it from the net would retry twice and mix scheduling back in.
`@mastra/core/workflows/evented` exports **`StepExecutor`**, the single-step executor Mastra's own
evented engine uses: one attempt per call (`retryCount` is a parameter, never a loop), all five
outcomes plus `nonRetryable` and the tripwire shape, input validation, the step's span, the step
context (`suspend`, `bail`, `abort`, `abortSignal`, `setState`, `getStepResult`, the writer), and
**no scheduling and no persistence**. Its sibling methods map one-to-one onto the net's runner:
`evaluateCondition` (loop and branch conditions), `resolveSleep`, `resolveSleepUntil`.

A spike ran a real `createWorkflow(...).then(a).then(b)` through Mastra's own `Run` on both engines:
the result, every step output and the workflow state matched; only result *formatting* differed.

## Decision

- **`@mastra/core` is a runtime peer dependency, imported only under `src/mastra/`.** The compiler,
  the kernel and verification stay host-free, and a source guard test enforces the boundary.
- **`PetriExecutionEngine extends ExecutionEngine`** and owns `execute()` — hard rule 3, literally.
- **Every firing runs on Mastra's `StepExecutor`**, one attempt per call; the net's unrolled retries
  own retrying. Branch conditions are evaluated one by one with each rejection read as falsy — the
  default engine's semantics, not `StepExecutor.evaluateConditions`', which lets an async rejection
  reject the whole selection.
- **One store.** The runner keeps no step results: `StepExecutor` gets a view over the kernel's
  store that translates to Mastra's `StepResult` on access. Workflow state (`setState`) is held by
  the runner and applied after a step completes, as Mastra applies it — data, never consulted to
  decide what runs.
- **The executor's `mastra` is a view, the step's `mastra` is the real one.** `StepExecutor`
  dereferences `mastra.pubsub` unconditionally and publishes a step's writer chunks there, while
  `Run.watch` / `Run.stream` listen on the `pubsub` the run hands `execute()`. So the executor gets
  a per-run view whose `pubsub` is the run's (over the registered Mastra, or over nothing for an
  unregistered workflow), and step code, conditions and sleep functions are given the registered
  Mastra or `undefined`, as the default engine gives them. Agent, tool and mapping entries are
  resolved through Mastra's own `createStepFromAgent`, `createStepFromTool` and `createMappingStep`
  before the executor runs them. *Amended M2:* the first version gave step code the stand-in.
- `resume`, `restart`, `timeTravel` and `perStep` are refused by name until M4.

## Consequences

- A Mastra version bump can change `StepExecutor`; the pinned tarball and the differential harness
  are where that shows up.
- The engine's fidelity for *step execution* is Mastra's by construction; what remains ours to get
  right is scheduling (the net), the result shape, persistence, and events.

## Evidence

`tests/mastra/engine.test.ts`, `tests/conformance/differential.test.ts` (both engines, one process,
one fixture corpus), `tests/mastra/boundary.test.ts` (the import guard).
