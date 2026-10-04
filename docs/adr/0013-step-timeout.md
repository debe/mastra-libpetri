# ADR 0013 — A step timeout is a timed-out output branch, raced inside the attempt on the run's clock

Status: proposed (2026-10-04, M7)

## Context

Mastra has no step timeout (row 6). A timeout changes an outcome — a step that would succeed fails —
so it cannot be a Layer 2 annotation the default engine ignores: it is Layer 3, behind the
`PetriEngineType` brand ([ADR 0002]).

A step attempt is a transition whose action is in flight between consuming its inputs and
depositing its outputs. Three ways to race it were weighed, with the libpetri session's answers
(TS 8.0.0, 2026-10-04):

| | Proof route | Permits and quotas | Clock | Running work |
|---|---|---|---|---|
| A. `Out.Timeout(after, recovery)` ([IO-013]) | enumeration kept (a virtual branch, [VER-001]/[VER-017]) | **dishonest**: the recovery returns the permit while the step still runs | bare `setTimeout`, not [TIME-015]; by design, no fix planned | keeps running; no abort hook exists or is planned; a retry would run one step id twice at once |
| B. split `call` / environment-place completion / timed `deadline` / `reap` | leaves enumeration twice: an environment place and a timed transition ([VER-017] conditions 2, 3) | honest | injected | aborted, discarded at `reap` |
| C. a timer inside the action, then an ordinary `timedOut` branch | enumeration kept: one more Xor branch, no timing | **honest** | the run's injected clock | aborted through a per-attempt signal, waited for, discarded |

## Decision

**C. `createStep({ ..., timeout: ms })` on the petri `createStep`. Each attempt's action races the
step against `scope.sleep(ms)` on the run's clock; on expiry it aborts a per-attempt signal, waits
until the step has actually returned or rejected, discards that result, and writes the attempt's
`timedOut` branch itself.**

- **Surface.** Carried with `uses` under `STEP_RESOURCES` ([ADR 0012]); `StepDescription.timeoutMs`.
  Refused: `timeout-value` (not a whole number of ms in [1, the wait ceiling]).
- **Net (leaf).** Every attempt's output is `xor(next, failed, bailed, suspended, paused, retry?,
  timedOut_j)`, each branch returning the permit and quotas. An immediate funnel `t.timeout-j:
  one(timedOut_j)` forwards to the next attempt's link on a non-final attempt and to the failure exit
  on the final one: a timeout is retried like a thrown error, through the existing `delayed` hop. The
  branch is written by the action — never signalled by a throw, which [IO-013] AC6 treats as an
  ordinary action failure ([EXEC-030]).
- **Precedence.** A run abort before expiry disarms the deadline: the step's own outcome stands. Once
  the deadline fires the outcome is the timeout, even if the step then returns success (maintainer
  decision). The record is `failed` with a `StepTimeoutError`.
- **Runner.** A per-attempt `AbortController` linked to the run's signal and to the deadline. The
  executor gets `{ signal: attempt.signal, abort: r => runController.abort(r) }`, so a step's own
  `abort()` still cancels the run (`evented/step-executor.ts:89-90, 248-253`;
  `handlers/step.ts:420-450`). `signal.reason` tells a step which it is. A nested workflow cancels its
  child run on that signal (`workflow.ts:2983, 3045`).
- **Gates, by attempt identity** `(stepId, path, foreachIndex, attempt)`: once the deadline has fired
  the runner applies no `stateUpdate`, runs no scorers, ignores `suspend`/`bail`/resume labels and
  drops writer chunks (the `ToolStream` is wrapped per attempt). The leaf records nothing late: the
  record is written after the race, from the timeout branch.
- **Never abandons.** The action ends only when the step settles, so permits, quotas and slots are
  held throughout and a retry never overlaps its predecessor. A step that ignores its signal holds the
  run until it returns.
- **Residual windows**, stated, not hidden: effects the step's own code causes directly (network,
  `mastra` storage or memory, objects mutated by reference); a nested child's own rows until its
  cancel takes effect.
- **Claims.** `retryCeilingViolations` learns the funnel (`StepChain.timeouts`): link j+1 is produced
  only by attempt j or funnel j, and `timedOut_j` only by attempt j. Liveness asks a witness that each
  `timedOut_j` is reachable. The pool check is unchanged: every branch returns its tokens.
- **Determinism.** A ManualClock advance fires the timer; nothing reads the machine clock.

## Consequences

- Upstream (Track U), each slotting into this ADR without changing the surface or the claims: an
  `AbortSignal` on `TransitionContext` aborted on `Out.Timeout`; `Out.Timeout` intervals on the
  [TIME-015] clock; a settle-before-deposit timeout, which would make C a plain `Out.Timeout`.
- Row 6 reopens as a Layer 3 addition.

## Evidence

Untested until M7 lands. Planned: `tests/compiler/leaf-timeout.test.ts`,
`tests/mastra/runner-timeout.test.ts`, `tests/engine/timeout-clock.test.ts`, the retry-ceiling
mutants with funnels.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0012]: 0012-limiter-blueprints.md
