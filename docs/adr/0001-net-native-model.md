# ADR 0001 — One net, net-native modelling

Status: accepted (2026-09-20)

## Context

Mastra compiles a workflow's fluent chain into a flat `StepFlowEntry[]` IR and hands it to an
execution engine through `createWorkflow({ executionEngine })`. That extension point is public
and already carries a genuinely different scheduling model — `EventedExecutionEngine` is a
message-driven state machine rather than a loop — so an alternative engine needs no fork and no
behavioural patch.

Two earlier libpetri integrations in this family each rejected a draft for the same reason: one
put a `null` output spec plus `skipOutputValidation` on execution transitions and kept a separate
"verification net", the other put a host-side permit-gated dispatch queue in charge of firing
order. Both route around net semantics, and a model the verifier cannot trust is not a model.

## Decision

1. Every transition carries a real, validated `Out` spec. Never `null`, never
   `skipOutputValidation`.
2. One `PetriNet` per compiled workflow serves the executor, the exporter and the verifier.
   There is no separate verification net.
3. The engine extends `ExecutionEngine` and owns `execute()`. It does **not** extend
   `DefaultExecutionEngine` and override hooks, because that leaves Mastra's `for` loop as the
   scheduler and the net as decoration.
4. Ordering derives only from priority, declaration order, control places and inhibitors.
   Concurrency limits, retries, halts and mutexes are places and arcs, never executor options
   or action-internal loops.
5. Mastra behaviours that are implementation artifacts rather than semantics are abandoned
   deliberately and listed in `docs/divergences.md`.

## Consequences

- The verifier sees exactly what runs, so a property proven about the model is a property of the
  thing that executes.
- Some Mastra tests that assert a total execution order cannot pass by construction: the net
  produces a partial order, and the differential harness requires it to be a *weakening* of
  Mastra's total order rather than a reordering of it.
- Structural limits are provable. `limit(n)` carries `placeBound(permits, n)`; a runtime
  concurrency knob carries nothing.

## Evidence

`typescript/tests/spikes/` pins every derived fact about libpetri semantics against the
installed version rather than trusting a doc comment. That habit found a three-language
correctness bug during planning ([MOD-031] place-alias identity drop, fixed upstream in
`7dd51c8` and `54e4ce3`), which is the argument for keeping it.
