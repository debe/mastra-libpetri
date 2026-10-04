# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-net-native-model.md) | One net, net-native modelling | accepted |
| [0002](0002-three-layer-surface.md) | Three layers, so new capability never costs compatibility | accepted |
| [0003](0003-outcomes-exits-run-scope.md) | Outcomes route to exits the context chooses; a run carries its own scope | accepted |
| [0004](0004-structural-cancellation.md) | Cancellation is an environment place the net inhibits on, checked where Mastra checks | accepted |
| [0005](0005-mastra-runtime-boundary.md) | The engine is Mastra's class; steps run on Mastra's executor; the net schedules | accepted |
| [0006](0006-run-step-budget.md) | "k" is a run's step budget: a place of permits, proven, never a scheduler | accepted |
| [0007](0007-resume-is-a-seeded-segment.md) | A resume is a seeded, gated, separately proven segment of the same net | accepted |
| [0008](0008-step-events-observe-the-net.md) | Step events observe the net: a lifecycle hook at Mastra's emission points, and a tee for the debug UI | accepted |
| [0009](0009-verification-claims.md) | Every compiled workflow carries four families of claims, derived, proven, and gated over the corpus | accepted |
| [0010](0010-restart-from-marked-checkpoints.md) | Restart continues from the latest author-marked checkpoint, a proven boundary of the same net | accepted |
| [0011](0011-block-concurrency.md) | A block's `concurrency` is a seeded pool of slots, admitted in arm order, proven | proposed |
| [0012](0012-limiter-blueprints.md) | `limit` and `rateLimit` are blueprints over fused quota places, one quota per run | proposed |
| [0013](0013-step-timeout.md) | A step timeout is a timed-out output branch, raced inside the attempt on the run's clock | proposed |

Each ADR has Context / Decision / Consequences / Evidence; Evidence names the test that pins the
behaviour it rests on. Amendments are recorded in the existing ADR, tagged with the milestone
(`amended M6:`), rather than as a superseding record.
