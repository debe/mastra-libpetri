# Divergences from Mastra

Every Mastra behaviour this engine does not reproduce is listed here with its classification.
Nothing is skipped silently.

**Classifications.** `abandoned (cause removed)` — the behaviour existed to work around
something this model does not have. `abandoned (defect)` — reproducing it would propagate a
bug. `out of scope` — real behaviour, deliberately not covered by this engine. `replaced` — the
same intent, a different mechanism. `addition` — capability Mastra's engine does not have.

**Statuses.** `proposed` — reasoned from source only. `designed` — the mechanism is observed by
a harness. `fixed (M<n>)` — closed in that milestone.

| # | Mastra behaviour | Classification | Rationale | Status |
|---|---|---|---|---|
| 1 | `.sleep(ms)` resumes with its remaining interval after a suspend | replaced | [CORE-073] restores a marking with every clock fresh, so a restored `.sleep(ms)` re-waits in full. Sound because restores are occasional and `Delayed` is a lower bound; the compiler emits no hard timing on a path that can cross a restore. Unsound for a scheduler that parks and resumes routinely — revisit if Mastra gains one | proposed |
| 2 | Cron-scheduled workflows | out of scope | Declaring `schedule` forces Mastra's evented engine, so a scheduled workflow never reaches this engine | proposed |
| 3 | `.waitForEvent()` | out of scope | Removed upstream; throws `WORKFLOW_WAIT_FOR_EVENT_REMOVED`. Suspend/resume is the mechanism | proposed |
| 4 | Total execution order across independent steps | abandoned (cause removed) | The net produces a partial order. The differential harness requires it to be a *weakening* of Mastra's total order, never a reordering — an unattributed ordering difference is a finding | proposed |
| 5 | `.parallel()` fan-out is unbounded | addition | A `concurrency` annotation compiles to a permit place. Layer 2: a workflow carrying it still runs correctly under `DefaultExecutionEngine`, merely unbounded | proposed |
| 6 | Step timeouts are not virtualized under an injected clock | out of scope (upstream) | `Out.Timeout` still elapses on a real `setTimeout`; only its recovery tokens follow the epoch clock. Reported upstream. Keep timeout values small in timed tests | proposed |
