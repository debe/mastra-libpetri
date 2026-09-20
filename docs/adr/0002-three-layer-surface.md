# ADR 0002 — Three layers, so new capability never costs compatibility

Status: accepted (2026-09-20)

## Context

The house rule is that no Mastra-facing surface names Petri concepts, and its test is: *a
workflow carrying this config must stay meaningful if Mastra's own `DefaultExecutionEngine`
runs it.* That test is correct for parity and impossible for new capability — a `race()`
combinator has no meaning under an engine that runs every truthy branch and joins them.

Refusing new capability to preserve the test would discard most of the reason to run a net at
all. Mastra's IR is a barrier model: it fans out only inside a `parallel` / `conditional` /
`loop` / `foreach` entry and always joins before the next index. Pipelining, racing, quorum
joins, shared cross-step resources, barge-in, correlated joins and compensation are all ruled
out by that one property.

## Decision

Three layers, each stating its own contract rather than one rule stretched over both cases.

| Layer | What it is | Runs on Mastra's engine? |
|---|---|---|
| 1 — parity | existing `StepFlowEntry[]`, compiled | yes, identically |
| 2 — annotations | options Mastra has a word for but does not enforce | yes — **degrades**; the limit is not enforced, the workflow still means the same thing |
| 3 — blueprints | capability the IR cannot express | **no**, and the type system says so |

Layer 3 is gated by the `PetriEngineType` phantom brand on the `init()` factory's re-branded
`createWorkflow` / `createStep` — the mechanism `@mastra/inngest` already uses to stop
default-engine steps being mixed in. Reaching for a blueprint is therefore a typed, visible
decision, never a silent incompatibility.

## Consequences

- Layer 2's contract is a test, not a claim: each annotation is verified *ignorable* by running
  the same workflow under `DefaultExecutionEngine` and asserting it still completes correctly,
  merely unbounded.
- Layer 3 blueprints each ship with a proven property. A blueprint without one is not done.
- Blueprints compose because they are subnets over shared places: `rateLimit` fused across three
  steps is one quota, `limit` inside `pipeline` is a bounded pipeline. If either needs
  special-casing, the blueprints are wrong.
- The upstream path is a consequence rather than an aspiration: a Layer 3 feature that sees real
  use, with worked semantics and a reference implementation, is a credible IR proposal to
  Mastra. An unused one is not, and is not proposed.

## Evidence

`typescript/tests/engine/layer2-ignorable.test.ts` runs each annotated workflow under both
engines. `typescript/tests/verify/blueprints.test.ts` asserts `Proven` per blueprint.
