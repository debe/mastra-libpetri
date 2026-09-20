# Mastra patches

**Mastra needs no patch to run this engine.** `createWorkflow({ executionEngine })` is a public
extension point, and `EventedExecutionEngine` already proves a genuinely different scheduling
model plugs into it. Nothing here is required to use mastra-libpetri.

This directory holds **behaviour-neutral upstream proposals** — each a small change that would
make a third-party engine a better citizen, each shipping with a proof that it changes nothing
when unused:

1. **Export the handler param types.** `ExecuteStepParams` / `ExecuteParallelParams` /
   `ExecuteEntryParams` exist in the published types but no `./workflows/handlers` subpath is
   declared, so they cannot be imported.
2. **Replace `engineType === 'default'` with a capability predicate.**
   `restartAllActiveWorkflowRuns()` and `listActiveWorkflowRuns()` hard-check the string, so any
   third-party engine's runs are invisible to boot-time crash recovery.

Later, and only once measured here, two IR extension proposals: a `concurrency` option on
`.parallel()` and a `{type:'race'}` entry. Those are proposed with worked semantics, a reference
implementation and a proof — not as an ask.
