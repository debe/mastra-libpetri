# ADR 0014 — `race` and `quorum(k)` are a counted decision on a `.parallel()`, and every loser is aborted and waited for

Status: proposed (2026-10-04, M7b). Draft: nothing here is implemented or measured.

## Context

Mastra has no word for "the first arm to succeed wins" or "k of n must succeed". Its `.parallel()`
waits for every arm, and a failing arm fails the block. A race changes an outcome, so under
[ADR 0002] it is Layer 3, behind the `PetriEngineType` brand. `race` is `quorum(1, n)`, so one
gadget serves both. Two designs were weighed:

| | A. builder methods, `undecided` verdict | B. `init()` blueprints, `permit` decision |
|---|---|---|
| Surface | `.race()` / `.quorum()` declaration-merged into Mastra's `Workflow`, gated on `TEngineType`: a global augmentation of `@mastra/core` | `init()` returns `race` / `quorum`, spread into Mastra's own `.parallel()`; the gate is the brand on the arms, as `limit` / `rateLimit` ([ADR 0012]) |
| Decision | one-token `undecided`, consumed by `met` (k successes) or `stall` (n−k+1 losses); exclusive by counting | the same shape, as `permit` / `met` / `short` |
| Preempted arm in the net | arrives without counting as a loss. The verifier may take that branch before any decision, which leaves n arrivals, `undecided` still marked and neither threshold met: **a deadlock the proof would report** | counted as a miss, so all-preempted leads to `short`: sound under the over-approximation |
| Suspended arm | a soft loss; the block can suspend and resume, with re-entry sites | a miss; the block never suspends; no re-entry sites |
| Next entry's input | built from step records, as `getStepOutput` (`restart-codec.ts:124`) rebuilds it on a restart | built from the `won` token. **Diverges from a restart**, which rebuilds it from records, wherever a surplus success kept its `success` record |
| Retry ceiling | new branch feeds the block, not a chain link: rules 3–4 hold unchanged | proposes extending rules 3–4 (not needed: the branch leaves the chain) |
| Quota waste | not stated | a preempted attempt still spends a rate token it already drew (stated) |

Both abort losers through a per-attempt signal, wait for them to settle and discard what they
return ([ADR 0013]'s rule), so permits, quotas and slots stay honest. Neither uses an inhibitor on
the decision, so adk-libpetri's double commit under the [VER-004] in-flight split cannot arise.

## Decision

**B's surface and net, A's output rule. `init()` returns `race(arms, options)` and
`quorum(k, arms, options)`; each marks a `.parallel()` entry with a decision `{k}`. The block
succeeds when k arms have succeeded and fails once n−k+1 have not. Once it is decided, every
unsettled arm is aborted, the block waits for all n, and each loser is recorded `canceled`.**

- **Surface.** `wf.parallel(...race([a, b, c], { id }))`. Both return `[arms, options]`. The
  options carry a fresh `metadata` object, user keys such as `concurrency` merged in, with a
  module-private symbol holding the minted decision. `toEntryOptionFields` keeps `metadata` by
  reference (`workflow.ts:647-653`), and JSON drops the symbol, so the serialized graph stays a plain
  `{type:'parallel'}` and M9 PR 4 stays open. Arms are typed `PetriStep[]`. Refusals:
  `quorum-value` (k not a whole number in [1, n]), `race-empty` (n = 0), `blueprint-arms` (entry
  arms not identical to the minted arms, or a duplicate id), `blueprint-position` (marker on any
  entry but `.parallel`). *Maintainer decision (2026-10-04):* this surface, not A's builder methods.
- **What wins** (maintainer decision, 2026-10-04: first success, the name stays `race`). A `success`. A failed, bailed, paused or suspended arm is a miss (`Promise.any`).
  Winners are the first k successes in collect order (FIFO on `okSeen`, [IO-002]).
- **Net, per block.**
  ```text
  fork (inhibitor cancel):   in -> armIn_* (or q_0 under concurrency) + permit
  collect-ok_i:              armDone_i -> arrived + okSeen{i}               (one firing, EXEC-001)
  collect-miss:              arm{err|bail|pause|susp|preempted} -> arrived{data} + miss
  met:                       permit + exactly(k, okSeen)     -> won     action: scope.preempt(path)
  short:                     permit + exactly(n-k+1, miss)   -> short   action: scope.preempt(path)
  join-met:   exactly(n, arrived) + won,   reset(okSeen, miss) -> next
  join-short: exactly(n, arrived) + short, reset(okSeen, miss) -> exits.failed
  ```
  `okSeen + miss ≤ n`, so `met` and `short` cannot both be enabled, and both consume the one
  `permit`. With n arrived and `permit` still marked, the arrivals split into oks and misses summing
  to n, so one threshold holds: no deadlock even when the verifier takes `preempted` early. The
  resets fire after all n arrived, with no producer in flight. B's `errSeen` / `suspSeen` markers
  are dropped: both no-winner outcomes take `exits.failed`, and which error is reported is data
  read from the `arrived` tokens. Every collect returns its slot (`admission.ts`, unchanged).
- **No winner.** The block fails with the lowest-index arm failure unchanged, tripwire included, as
  parallel's join does; with no failed arm, a `QuorumNotMetError { need, succeeded, statuses }`.
- **Losers.** `RunScope.preempt(path)` aborts one controller per block per segment (`.parallel` is
  top-level). `StepCall.preempt` sits beside `deadline`; `attemptGate` adds it as a source, so its
  late-effect gates apply unchanged. The leaf awaits the step, discards the result and leaves by a
  new `preempted` xor branch, only on arms of a decided block. The record is `canceled`, with the
  signal reason `{ kind: 'preempted', block }`. A loser in a retry delay finishes that one delay,
  then its next attempt sees the fired gate, does not run and leaves by `preempted`. An arm admitted
  after the decision does the same at once. A success that settled before its abort keeps its
  `success` record; a suspended arm's record is rewritten `canceled` at the join, so no finished run
  holds a resumable orphan. Preempt on `short` too (recommended; taken unless the
  maintainer objects).
- **Output.** Parallel's rule, from step records: the next entry gets every declared arm, mapped to
  its record's `output` — exactly what `getStepOutput` rebuilds on a restart. The workflow's last
  entry reports the arms that succeeded. The `won` token carries the winners for observability only.
  *Maintainer decision (2026-10-04):* this, not winners only.
- **Suspend.** A miss in wave 1; the block never suspends and emits no `blockReentry` sites.
  *Maintainer decision (2026-10-04):* this for wave 1; a resumable block is deferred.
- **Cancel** ([ADR 0004]): unchanged — `fork` is gated, arms see the run signal, the top-level
  settle re-stamps `canceled`. Run abort, then deadline, then preempt: whichever fires first.
- **Restart** ([ADR 0010]): a checkpoint on the race entry is allowed; a restart re-runs the whole
  block and may pick other winners. A mark on an arm stays refused (`checkpoint-position`).
- **Claims.** Proven, by enumeration ([VER-017]) while every arm is immediate:
  `placeBound(permit|won|short, 1)`, `mutualExclusion(won, short)`, `placeBound(okSeen|miss, n)`,
  `blockClaims(arrived, n)`, completion and pools; liveness of `met` and of `short`
  (`LivenessTarget.kind` gains `'decision'`). Checked from the arcs (`verify/structure.ts` style):
  `met`'s only inputs are `permit` and `exactly(k, okSeen)`, and only the success collects produce
  `okSeen`. `retryCeilingViolations` is unchanged, since `preempted` leaves the chain; mutants added.
  Untested-not-proven: losers stop promptly, FIFO order, every arm can win.

## Consequences

- An arm with a retry delay or a `rateLimit` moves the segment to SMT, as in M7; `timeout` keeps
  enumeration. Proof fixtures stay at 3–4 arms; 6-arm `parallel-wide` already takes 102 s.
- Residual windows, as [ADR 0013]: effects the step causes directly; a nested child's rows until
  its cancel lands; a loser that ignores its signal holds the block and its permits, quotas, slots.
- A forced `cloneWorkflow` past the type checker runs the race as a plain parallel, as M7's
  `timeout` would.
- `compiler/blueprints/first-k.ts` keeps the decision host-free, the M10 candidate.
- Divergence rows (proposed 103–109): the addition itself; losers `canceled`, never retried;
  FIFO winners vs lowest-index failure; suspension is a miss, block not resumable; a suspended loser
  rewritten `canceled`; a loser in a retry delay finishes the delay; a preempted attempt still
  spends its rate token.

## Evidence

Untested; nothing run or measured. Planned: W0 spike timing a 3-arm race and quorum(2,3) against
libpetri 8.0.0 from npm, unlinked, provenance quoted; `tests/types/blueprint-surface.test-d.ts`;
`tests/compiler/quorum.test.ts` with an early-`preempted` case and an `inhibitor(won)` mutant;
`tests/mastra/runner-preempt.test.ts`; `tests/engine/race.test.ts` (first success wins, all fail
reports lowest index, `QuorumNotMetError`, suspended loser, cancel mid-race, retrying loser, loser
ignoring its signal, concurrency 2); race and quorum cases in `tests/verify/blueprints.test.ts`,
with `limit` inside an arm. Over 30 s per query means redesign; over 60 s, ask the libpetri sessions.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0004]: 0004-structural-cancellation.md
[ADR 0010]: 0010-restart-from-marked-checkpoints.md
[ADR 0012]: 0012-limiter-blueprints.md
[ADR 0013]: 0013-step-timeout.md
