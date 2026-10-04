# ADR 0010 — Restart continues from the latest author-marked checkpoint, a proven boundary of the same net

Status: proposed (2026-10-04, M4b)

## Context

Mastra restarts a run that was `running` or `waiting` when its process died. `Run.restart` →
`_restart` (`workflow.ts:4859-4990`) refuses every engine but `default` and `evented` by name
(`:4871-4875`, synchronously, before its first `await`), short-circuits a stored `success`,
`failed` or `tripwire` to the stored result (`:4887-4936`), builds `RestartExecutionParams` with
`createRestartExecutionParams` (`utils.ts:577-634`: `activePaths`, `activeStepsPath`, the stored
context as `stepResults`, `state`, `stepExecutionPath`), and calls `execute({restart})` with no
`input` (`:4968-4983`). It takes no run claim.

The default engine continues at `activePaths[0]` (`default.ts:797-811`) and rebuilds from the
records it wrote **at every step's start and end** (`handlers/step.ts:216-229`,
`handlers/entry.ts:610-829`). Per entry kind: a step re-runs whole on the previous entry's stored
output (`entry.ts:303-316`, `default.ts:1132-1159`); a parallel keeps arms with a non-`running`
record and re-runs the rest (`control-flow.ts:186-221`); a branch re-evaluates every condition and
re-runs every truthy arm, completed ones included (`:544-551`); a loop continues at the stored
`iterationCount` (`:726-735`); a foreach re-runs its items (`:1029-1041,1227-1270`); a sleep waits
its whole interval again (`entry.ts:586-660`). Boot recovery restarts active runs sequentially,
but only of `default` workflows (`workflow.ts:3147-3165`, `mastra/index.ts:3952-3995`).

This engine writes only at start and at the terminal (row 55), so a crashed petri run had nothing
to restart from but its input, and `Run.restart` refused it by name (row 62).

Snapshots are not free. Writing one at every step start and end — Mastra's choice — puts a storage
round trip on every step's latency; deferring writes behind the run (copy-on-write in spirit)
makes latency depend on how far the run has drifted from the last durable point. Neither is
predictable. The maintainer's decision: **checkpointing is explicit**. The author marks where a
checkpoint is worth its cost; everywhere else the run pays nothing.

## Decision

**A checkpoint is an author-marked top-level boundary. Reaching it freezes the run for one
awaited storage write; a restart continues from the latest checkpoint, as a seeded segment of the
same net, proven at every boundary.**

- **The mark is Mastra's own `metadata`.** `metadata: { checkpoint: true }` on a top-level entry —
  a `.then()` step's `createStep({ metadata })`, or the `opts.metadata` every control-flow builder
  already takes (`.parallel`, `.branch`, `.dowhile`/`.dountil`, `.foreach`, `.sleep`,
  `.sleepUntil`, `.map`; `workflow.ts:2087-2619`) — means *checkpoint once this entry succeeds*.
  `StepMetadata` is `Record<string, any>`; the default engine reads metadata only for span
  attributes, so a marked workflow runs unchanged on `DefaultExecutionEngine`, where the mark is
  merely redundant. It passes the Layer test. A `createWorkflow({ checkpoints })` key was rejected
  (Mastra's own `createWorkflow` refuses it); a no-op marker entry was rejected (it shifts indices).
- **Only at a top-level boundary.** Between entries *i* and *i+1* the barrier guarantees exactly
  one flow token, so a checkpoint is exactly a seed and needs no multi-arm re-run machinery. A mark
  on a `.parallel()`/`.branch()` arm, a loop body or a foreach body is refused when the workflow is
  adapted (`checkpoint-position`), naming the enclosing entry's options as the place for it. A mark
  on the last entry adds nothing: the terminal row covers it.
- **The net.** For each marked *i* < last: place `s.<i>.checkpoint` becomes entry *i*'s `next`;
  `t.<i>.checkpoint` (inhibited by `wf.cancel`) awaits the write and outputs `in_{i+1}`; a sweep
  `t.<i>.checkpoint.cancel` reads `wf.cancel` and moves the token on unwritten, so `in_{i+1}`'s own
  sweep reports the cancel as today. An unmarked workflow compiles to exactly today's net.
- **The write is a freeze, awaited in the firing.** The row is durable before any effect of entry
  *i+1*, and lands strictly before the terminal write — no queue. Its rows are `running` writes
  under the `#lastPersisted` guard, `shouldPersistSnapshot` and `pruneSnapshot`. A rejected write
  fails the firing and the run rejects with the storage error, as any persist failure does on the
  default engine: an explicitly requested durability point is never skipped silently.
- **The row** is a well-formed Mastra row: `status 'running'`, `activePaths [i+1]` (the boundary),
  `activeStepsPath {}`, the context so far, `value` the run's state, `stepExecutionPath` through
  entry *i*, empty `suspendedPaths`/`resumeLabels`/`waitingPaths`. Mastra's own restart of it starts
  at entry *i+1* from the records, so a petri checkpoint restarts the same way on either engine.
- **Restart is a seeded segment.** `p = activePaths[0]`; one `FlowToken` carrying
  `getStepOutput`'s value for `p` at boundary site `in_p` (`BoundarySite`, one per top-level entry,
  kept apart from `resumeSites`). Everything after `p` re-runs: a branch re-decides, a loop's start
  re-reads its body record, a foreach splits fresh, a sleep waits in full (restore timing:
  Mastra's). No checkpoint taken means `p = 0`, the start row, and the whole run re-runs on the
  stored input. A restart writes no start row, so a second crash restarts from the same checkpoint.
- **Rows from Mastra's engine** can name any position. `[i]` or `[i, j]` maps to `p = i`, and entry
  *i* re-runs whole — completed arms included (a divergence). A nested workflow step named in
  `activeStepsPath` gets Mastra's `restart: true` on its first attempt, as `handlers/step.ts:435-437`
  passes it.
- **Refusals,** before anything persists, as `UnsupportedRunModeError('restart')` with a reason:
  `no-position` (no `activePaths`, or `p` not a top-level index), `workflow-changed` (the stored
  `serializedStepGraph` differs from the compiled one — decision 2 of ADR 0007, extended to restart).
  `timeTravel` and `perStep` stay refused. Mastra's own refusals come first, unchanged.
- **Proofs at every boundary,** not only marked ones, since a row from Mastra may name any:
  `restart@p` and `restart@p+cancel` from `{in_p: 1}` plus the budget, all three safety families.
  Where the marking equals `resume@p`'s (a step or loop entry) the one proof is cited under both
  labels. Proofs are offline; they cost the run nothing. A query over 30 s means the net is
  redesigned ([ADR 0009]).
- **The `Run.restart` seam, without a fork.** `engineType` stays `'petri'`. `init()`'s
  `createWorkflow` overrides `createRun` on the workflow instance; each `Run` it returns gets an
  instance `_restart` that sets `workflowEngineType = 'default'` for the synchronous call into
  Mastra's own `_restart` and restores it in `finally`. The check is the first statement and
  nothing after the first `await` reads the field, so the flip is unobservable and the rest —
  short-circuit, params, requestContext merge, span, `cleanup` — is Mastra's verbatim.
  `restartAllActiveWorkflowRuns` is overridden without its engine gate, and
  `restartActiveRuns(mastra)` is exported for boot, beside Mastra's own hook, which skips petri
  workflows. M9 PR 2 (a capability predicate) retires both.

## Consequences

- Restart granularity is the author's: everything after the latest checkpoint re-runs, the whole
  run when none was taken. Steps after a checkpoint must tolerate running twice — as on Mastra,
  whose restart re-runs whatever was in flight.
- Per-step latency is unchanged unless a step's boundary is marked; then it carries one write.
- A petri run is never stored `waiting`, and storage polled mid-run shows the latest checkpoint,
  not the current step (row 55 stays `replaced`, now with checkpoints).
- The `_restart` flip relies on Mastra reading `workflowEngineType` only before its first `await`;
  `tests/upstream/restart-seam.test.ts` fails the build if that changes.
- A frequent-snapshot design inside blocks (many tokens in flight) would need a different
  snapshot concept — a copy-on-write marking capture in libpetri. Not needed here; noted as a
  possible upstream topic.

## Evidence

Untested until M4b lands. Planned: `tests/compiler/checkpoint.test.ts` (unmarked nets unchanged,
refusals per position), `tests/verify/restart-segments.test.ts` (`restart@p` at every boundary,
k = 1, 2, 4, unbounded, with timings and libpetri provenance), `tests/mastra/checkpoint-row.test.ts`,
`tests/upstream/restart-seam.test.ts`, `tests/conformance/restart*.test.ts` (crash at every
recorded row; petri>petri vs petri>default, default>default vs default>petri).

[ADR 0007]: 0007-resume-is-a-seeded-segment.md
[ADR 0009]: 0009-verification-claims.md
