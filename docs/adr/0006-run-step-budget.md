# ADR 0006 — "k" is a run's step budget: a place of permits, proven, never a scheduler

Status: accepted (2026-09-24)

## Context

M3 was planned as "k > 1 under the structural budget", a phrase inherited from n8n-libpetri, where
n8n runs nodes one at a time and the net at k > 1 runs independent nodes concurrently. That premise
does not carry over. Mastra's IR is a barrier model: `.then` is a data dependency, and every
concurrency the IR can express — `.parallel`, `.branch`, `.foreach` — Mastra already runs
concurrently. **A Layer 1 workflow has no concurrency for the net to add.** Adding it is Layer 3
(`pipeline()`, M7b).

What Mastra has no word for is the opposite: a bound. A run fanning out into a `.parallel()` of
twenty arms calls twenty things at once, and nothing in Mastra says "at most k".

## Decision

**k is a run-level budget of step attempts in flight**, an engine option
(`new PetriExecutionEngine({ concurrency: k })`), compiled as a place `wf.permits` holding `k`
tokens in the run's initial marking:

- every step attempt's run transition consumes one permit when it fires, and **every** outcome
  branch hands it back in the same firing — an `Xor` of `And`s, so each structural branch is exactly
  a runtime outcome and the verifier sees the permit returned on every one;
- only steps take permits: sleeps, conditions and joins do not, so no permit is held across a wait,
  a join or a retry delay, and the budget cannot deadlock the net;
- `k` lives in the **initial marking**, not the net, so budgets of 2 and 4 compile to one net; the
  seed is never an action's multi-token deposit ([IO-016]);
- budgets are per run — a nested workflow on its own engine has its own.

Two properties join the proven set whenever a budget is compiled in, in both segments:
`permitsBounded` (`placeBound(permits, k)` — no transition mints a permit) and `permitsReturned`
(`quiescentCount([permits], k, k)` — every permit is back at rest). With the executor consuming a
permit at fire, steps in flight never exceed `k`.

It is Layer 2: an engine option, not workflow config, and a workflow means the same under
`DefaultExecutionEngine`, merely unbounded. The differential therefore runs the corpus at
k ∈ {1, 2, 4, ∞} against Mastra's unbounded oracle: results must be identical at every k **unless
overlapping steps read-modify-write shared workflow state** — where Mastra's own result depends on
the interleaving and a budget selects a serialised one (row 71) — and ordering may only
**strengthen**, serialising what Mastra overlaps, never contradict Mastra's.

*Amended M3:* the first version said results must be identical at every k, unconditionally. The
differential's `workflow-state` fixture refuted it at k = 1. Mastra's arms share one live state
object merged in place as each completes (`handlers/control-flow.ts:249`, `default.ts:709-713`), so
overlapping read-modify-writes lose all but the last write, and a serialised run loses none. The
budget changes only the interleaving; the race is the workflow's. Snapshotting state at the fork
would hide it at k = 1 and diverge from Mastra wherever an arm reads after a sibling has finished.

## Consequences

- The M2 label "k = 1" meant an unbounded run whose fixtures happened to be sequential; M3's k is
  this budget.
- **A budget is not data-neutral** for racy workflow state (row 71), for which `.foreach()` items
  run before a failure stops dispatch (row 70), or for a budget-delayed step that starts after the
  abort — it runs, and sees its signal already aborted (row 73).
- A step that forgets to return its permit is caught by `permitsReturned`; one that mints a permit,
  by `permitsBounded`; one compiled with no permit at all, by `budgetStructureViolations`, which
  `verifyWorkflow` runs before any proof — a mutant of exactly that kind passed all eleven proofs
  before the check knew every step attempt. At runtime, any permit count other than `k` at rest is
  reported as residue.
- Row 5's `.parallel({ concurrency })` annotation (M7) is a per-block budget of the same shape; this
  is its run-level cousin.

## Evidence

A smoke test before any agent built on it: peak in flight equals min(k, 4) for a four-arm parallel
at k = 1, 2, 3 and unbounded, data unchanged; all eleven properties proven at k = 1 and 2; a step
that keeps its permit on failure makes `permitsReturned` violated; a real Mastra `.parallel()` on
`PetriExecutionEngine({ concurrency: 1 })` returns the same result with one step in flight.
`tests/verify/budget.test.ts`, `tests/engine/budget.test.ts`, the differential at each k.
