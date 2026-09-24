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

Each ADR has Context / Decision / Consequences / Evidence; Evidence names the test that pins the
behaviour it rests on. Amendments are recorded in the existing ADR, tagged with the milestone
(`amended M6:`), rather than as a superseding record.
