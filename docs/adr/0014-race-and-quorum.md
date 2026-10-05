# ADR 0014 — `race` and `quorum(k)` are a counted decision on a `.parallel()`, and every loser is aborted and waited for

Status: accepted (2026-10-05, M7b). Maintainer decisions taken; the net amended by the W0 spike
(2026-10-04, below) and by the W0 contract review (marked *amended M7b W0 review*); the precedence
rewritten in the W1 review to one host-owned verdict, the first source fired.

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
  entry but `.parallel`), `blueprint-reused` (one minted decision on two `.parallel()` entries of a
  workflow: `const r = race([a, b]); wf.parallel(...r).parallel(...r)` passes `blueprint-arms` twice,
  and no existing refusal catches two entries with one id). *Maintainer decision (2026-10-04):* this
  surface, not A's builder methods.
- **Matching arms** (*amended M7b W0 review*). Mastra's `.parallel()` maps each arm through
  `toSingleStepEntry` (`workflow.ts:579-592`): a plain step (or a nested workflow) stays
  `{type:'step', step}`, but `createStep(agent | tool, options)` becomes `{type:'agent'|'tool', id,
  agent|tool: __agentRef|__toolRef, options: __agentOptions|__toolOptions}`, and the Step object is
  not kept. So the adapter matches entry arm i to minted arm i by kind: `step === minted[i]`; for an
  agent or tool, the same `id` and, by identity, the same ref and the same options object (both may be
  `undefined`). The options object is the carrier [ADR 0012] already relies on (`STEP_RESOURCES` on
  `__agentOptions` / `__toolOptions`). Pinned by `tests/mastra/adapt-decision.test.ts`, "agent and
  tool arms match by ref and options identity".
- **What wins** (maintainer decision, 2026-10-04: first success, the name stays `race`). A `success`. A failed, bailed, paused or suspended arm is a miss (`Promise.any`).
  Winners are the first k successes in collect order (FIFO on `okSeen`, [IO-002]).
- **Net, per block** (*amended M7b W0, 2026-10-04*: no `arrived`, no resets; the surplus is absorbed
  after the decision — see the amendment below).
  ```text
  fork (inhibitor cancel):   in -> armIn_* (or q_0 under concurrency) + permit
  collect-i:                 armDone_i -> okSeen{i, data}
  collect-{err,bail,susp,pause}: arm{err|bail|susp|pause} -> miss{status, token}
  collect-preempted-i:       arm-i-preempted -> miss{preempted, i}       (one place per arm)
  met:                       permit + exactly(k, okSeen)     -> won     action: scope.preempt(path, reason)
  short:                     permit + exactly(n-k+1, miss)   -> short   action: scope.preempt(path, reason)
  absorb-{ok,miss}-won:      one(okSeen | miss) + read(won)   -> settled   (omitted when k = n)
  absorb-{ok,miss}-short:    one(okSeen | miss) + read(short) -> settled   (omitted when k = 1)
  join-met:                  won   + exactly(n-k, settled)  -> next          (no arc when n = k)
  join-short:                short + exactly(k-1, settled)  -> exits.failed  (no arc when k = 1)
  ```
  `okSeen + miss ≤ n`, so `met` and `short` cannot both be enabled, and both consume the one
  `permit`. With every arm arrived and `permit` still marked, the arrivals split into oks and misses
  summing to n, so one threshold holds: no deadlock even when the verifier takes `preempted` early.
  `met` takes k oks, and the other n−k arrivals can only be absorbed once `won` is marked, so
  `join-met` still waits for all n arms with no count of arrivals and no emptiness test; `short` the
  same with n−k+1 and k−1. B's `errSeen` / `suspSeen` markers are dropped: both no-winner outcomes
  take `exits.failed`, and which error is reported is data in the tokens `join-short` consumes —
  `short`'s misses and the k−1 `settled`. Every collect returns its slot (`admission.ts`,
  unchanged).

  *Dead absorbs (amended M7b W0 review).* A transition that can never fire is not emitted, as a count
  of 0 omits its arc: for k = n, `met` takes all n arrivals, so the `absorb-*-won` pair is omitted;
  for k = 1, `short` takes all n, so the `absorb-*-short` pair is omitted. `settled` is bounded by
  max(n−k, k−1), which is 0 only for n = 1: there every absorb is omitted, the place is not emitted
  and no bound is claimed (`DecisionSite.settled` is `undefined`). A block of one arm also gets no
  preemption — no other arm can decide first — so it has no `preempted` place, no
  `collect-preempted`, no `StepCall.preempt` and no `scope.preempt` call.
- **No winner.** The block fails with the lowest-index arm failure unchanged, tripwire included, as
  parallel's join does; with no failed arm, a `QuorumNotMetError { need, succeeded, statuses }`.
  `statuses` gives each arm's status **as it arrived**, from its collect's token, before the join's
  rewrite: `suspended` and `preempted` stay distinct, where both records end `canceled`.
- **Losers.** `RunScope.preempt(path, reason)` aborts one controller per block per segment
  (`.parallel` is top-level). `reason` is a `StepPreemptedError { kind: 'preempted', block, path,
  outcome }` (`compiler/preempt.ts`), an `Error` as `StepTimeoutError` is, built by the `met` /
  `short` action. `StepCall.preempt` sits beside `deadline`; `attemptGate` adds it as a source of
  the attempt's signal. **Whether an attempt was preempted is the host's verdict** (see
  *Precedence* under Cancel): the runner freezes it and reports it as `StepOutcome.verdict`, and the
  leaf takes its `preempted` xor branch — on arms of a deciding block only — exactly when the
  verdict is `preempted`, never by reading a signal (`tests/verify/source-guard.test.ts`, no
  allowance added). The record is `canceled` with `reason` set to that error (`StepRecord`'s
  canceled variant); `step-result.ts` writes it as the Mastra row's `error` and restores it on read.
  The leaf calls the runner for every attempt: a loser in a retry delay finishes that one delay, then
  its next attempt is handed the fired signal and the runner returns `preempted` without starting
  the step (`started: false`, so the record takes no start of its own). An arm admitted after the
  decision does the same once it enters — which under a `limit` / `rateLimit` or a block
  `concurrency` is only after it has drawn its quota and slot (row 110). An attempt whose verdict was
  frozen `own` before the decision keeps its outcome: a success is a surplus success and keeps its
  `success` record; a suspension is rewritten at the join, as follows. A suspended arm's record is rewritten `canceled` at
  the join, and `RunScope.forgetSuspension(stepId)` drops its resume labels from the runner in the
  same firing, so the finished run names no label for it. **Residual:** a loser that is a nested
  workflow leaves its child run's own snapshot `suspended` in storage; the parent no longer reaches
  it (row 107). Preempt on `short` too (recommended; taken unless the maintainer objects).
- **Output.** Parallel's rule, from step records: the next entry gets every declared arm, mapped to
  its record's `output` — exactly what `getStepOutput` rebuilds on a restart. A loser's key is
  present and `undefined`, so the next step's input schema must make every arm key optional: Mastra
  validates inputs by default (`validateInputs`). The workflow's last entry reports the arms that
  succeeded. The `won` token carries the winners for observability only.
  *Maintainer decision (2026-10-04):* this, not winners only.
- **Suspend.** A miss in wave 1; the block never suspends and emits no `blockReentry` sites.
  *Maintainer decision (2026-10-04):* this for wave 1; a resumable block is deferred.
- **Cancel** ([ADR 0004]): unchanged — `fork` is gated, arms see the run signal, the top-level
  settle re-stamps `canceled`. *Precedence (amended M7b W1 review; replaces "run abort > deadline >
  preempt, at settle"):* **one host-owned verdict per attempt, frozen once.** The runner
  (`attemptGate.freeze()`, host side, where reading a signal is allowed) decides the attempt at a
  single point — when the step settles, or before it starts — and nothing that fires afterwards
  changes it. **First fired wins** across the run's abort, the deadline and the preemption, as the
  gate's listeners record them (amended again after the W1 review: the earlier rule 2, "otherwise,
  the run is aborted → `own`", let a run abort that landed *after* a preemption re-decide the
  attempt):
  1. the run's abort fired first → `own`: the step's own outcome stands, as on Mastra's default
     engine;
  2. the deadline fired first → `timedOut` ([ADR 0013] unchanged: a run abort before expiry
     disarms the deadline);
  3. the preemption fired first → `preempted`, whatever fires after it — a run abort included;
  4. none fired → `own`.

  Sources that had all fired before the call, which no listener saw, are taken in the order run,
  deadline, preemption: an attempt called with both the run abort and the preemption already fired
  is `own`, and the runner **runs** it, its signal aborted, as `executeStepWithRetry` runs a retry
  after a cancel (`default.ts:455-460`).

  A preemption that fires after the freeze does not change the attempt: its own outcome stands, and
  a success is a surplus success. Once preempted, a loser never times out into a retry. The
  attempt's effects — `stateUpdate`, resume labels, scorers — are applied iff the verdict is `own`,
  after the freeze. A label named at `suspend` time behind a decisive gate stays pending and is
  committed only on `own`, so a discarded attempt never touches a label of the same name another
  step wrote (the W1 runner wrote it at once and deleted it on withdrawal, erasing the label it had
  overwritten). Of two steps naming one label, the later-settling one holds it, timed or not: Mastra
  writes a label at `suspend` and again when the attempt returns (`handlers/step.ts:399-411`, `:491`),
  and the runner does both on the plain path. Writer chunks, which cannot wait, are dropped while the provisional verdict is not `own`. The leaf maps
  the verdict to a branch; a runner that reports none (one unaware of M7b) never yields `preempted`,
  and its timeout is the leaf's own deadline race, as in [ADR 0013]. `abortSignal.reason`, which the
  step may read, is the first source's: an `AbortSignal` aborts once. This closes a late-decision
  window found in review: the runner checked the gate once after `executor.execute`, then applied
  state, kept labels and awaited scorers, while the leaf sampled the preemption later, at settle — so
  a decision in between gave a `canceled` record with committed effects, or an orphan resume label.
- **Restart** ([ADR 0010]): a checkpoint on the race entry is allowed; a restart re-runs the whole
  block and may pick other winners. A mark on an arm stays refused (`checkpoint-position`).
- **Claims.** Proven, by enumeration ([VER-017]) while every arm is immediate:
  `placeBound(permit|won|short, 1)`, `mutualExclusion(won, short)`, `placeBound(okSeen|miss, n)`,
  `placeBound(settled, max(n−k, k−1))` when n ≥ 2 (*amended*, was `blockClaims(arrived, n)`),
  `placeBound(arm-i-preempted, 1)`, completion and pools; liveness of `met` and of `short`
  (`LivenessTarget.kind` gains `'decision'`). **Unclaimed** (*amended M7b W0 review*): liveness of
  each arm's `collect-preempted-i` — the leaf's `preempted` xor branch is not conditioned on the
  decision, so the verifier can take it before any decision and the proof would be vacuous; that a
  loser is preempted after a decision is tested, not proven. Checked from the arcs
  (`verify/decision.ts`, `structure.ts` style): `met`'s only inputs are `permit` and
  `exactly(k, okSeen)`, only the success collects produce `okSeen`, exactly the live absorbs exist,
  and no decision place carries an inhibitor or a reset. `retryCeilingViolations` is unchanged, since
  `preempted` leaves the chain; mutants added. Untested-not-proven: losers stop promptly, FIFO order,
  every arm can win.

## Consequences

- An arm with a retry delay or a `rateLimit` moves the segment to SMT, as in M7; `timeout` keeps
  enumeration. Proof fixtures stay at 3–4 arms; 6-arm `parallel-wide` already takes 102 s.
- Proof fixtures: n = 3 (k = 1, 2, 3) and n = 4 (k = 1, 2), with and without a run budget of 1, and
  one with a retrying arm (retries 2, delay 5 ms), which moves the segment to SMT.
- Residual windows, as [ADR 0013]: effects the step causes directly; a nested child's rows until
  its cancel lands; a nested loser that had suspended keeps its child run's own `suspended`
  snapshot (row 107); a loser that ignores its signal holds the block and its permits, quotas,
  slots; a loser admitted after the decision still waits for its quota and slot (row 110).
- A forced `cloneWorkflow` past the type checker runs the race as a plain parallel, as M7's
  `timeout` would.
- `compiler/blueprints/first-k.ts` keeps the decision host-free, the M10 candidate.
- Divergence rows (planned 103–110): the addition itself; losers `canceled`, never retried;
  FIFO winners vs lowest-index failure; suspension is a miss, block not resumable; a suspended loser
  rewritten `canceled`; a loser in a retry delay finishes the delay; a preempted attempt still
  spends its rate token; a loser admitted after the decision waits for its quota first.

## Amendment (M7b W0, 2026-10-04): absorb the surplus instead of resetting it

The W0 spike compiled a real `.parallel()` with a leaf wrapper (a `preempted` branch on every
attempt, retries included, permit back under a budget) and a decision gadget around
`ctx.emitNested`, and asked the repo's queries (50k classes, 30 s per query, 30 s total budget,
semiflow invariants, siphon discharge first; completion in `closed` and `cancel`, bounds, exclusion
and liveness in `closed`). **libpetri 8.0.0 from npm, not linked** (`scripts/link-libpetri.sh
--check`: "not linked") for every figure below.

**The topology as first drafted is provable in budget, but costly.** All 448 queries (248 untimed,
200 timed) came back as expected and none took over 30 s. But the joins' `reset(okSeen, miss)` make
both places non-monotone, and every collect writes one of them, so VER-004 splits all 2n+4 collects
into start and completion (11 transitions at n = 3, 13 at n = 4):

| Config | Classes closed / cancel | Route | Slowest query |
|---|---|---|---|
| n=3, k=1/2/3, ± run budget 1 | 2206 / 6619 (k=2: 1975 / 5926) | enumeration | 243 ms |
| n=4, k=1, closed / cancel | 22316 / over 50k | enumeration / smt | 7.7 s (`deadlockFree`, budget 1) |
| n=4, k=2, closed / cancel | 19430 / over 50k | enumeration / smt | 10.5 s (`exactlyOneTerminal`, budget 1) |
| timed retry arm, n=3/4 × k=1/2 × ± budget | not enumerated | smt | 6.4 s |
| today's `parallelGadget`, unbudgeted, n=3 / n=4 | 558 / 1675; 3206 / 9619 | enumeration | 456 ms |

That is 4× the baseline at n = 3 and 7× at n = 4, and the cancel segment at n = 4 already falls off
enumeration onto the SMT fallback.

**Amended topology** (the net above): drop `arrived` and both resets; `absorb-{ok,miss}-{won,short}`
take the surplus after the decision into `settled`, and the joins count `settled`. Only `wf.cancel`
stays non-monotone, so the only split left is `t.cancel.arrive`, as in the baseline. All 448 queries
as expected:

| Config | Classes closed / cancel | Route | Slowest query |
|---|---|---|---|
| n=3, k=1/2/3 | 558 / 1675 (k=2: 471 / 1414) | enumeration | 67 ms |
| n=4, k=1 | 3573 / 10720 | enumeration, both segments | 600 ms |
| n=4, k=2 | 2851 / 8554 | enumeration, both segments | 467 ms |
| timed retry arm | not enumerated | smt | 3.4 s |

A one-token run budget did not change the class count (a step attempt fires atomically). One
deviation from the first draft is kept: each arm has its own `preempted` place and collect, so the
structural check can tie each place to its one arm. (The spike also queried each
`collect-preempted-i`'s liveness; the review dropped it as a claim, since the branch is reachable
before any decision and the proof is vacuous — see Claims.) Liveness on the timed nets is confirmed in the
untimed abstraction only (`counterexampleTiming: "untimed-abstraction"`).

**Not covered by the spike:** the repo's structural checks, resume and restart segments (no resume
sites; `restart@0` is the `closed` marking), execution witnesses, the sum `okSeen + miss ≤ n`
(bounded per place), and n ≥ 5. Spike scripts and logs:
`/private/tmp/claude-501/-Users-db-repositories-mastra-libpetri/scratch-m7b-spike/` (not in the repo).

## Evidence

Built in W1 (`3ab7ea6`, merged `7490364`) and integrated in W2 (`1fa69bd`, merged `3ebb1c8`); CI
green on `3ebb1c8` (run 37360992111: `typescript`, 4 `proofs` shards, 8 `corpus` shards). libpetri 8.0.0 from npm, not linked.

- `tests/mastra/race-surface.test.ts` — the factories; the brand gate as a `@ts-expect-error` under
  `npm run check`; the Layer test: a race on the default engine runs as its plain `.parallel()` twin.
- `tests/mastra/adapt-decision.test.ts` — the five refusals; agent and tool arms matched by ref and
  options identity.
- `tests/compiler/quorum.test.ts` — shape and names, an early-`preempted` firing, dead absorbs
  omitted at k = n and k = 1, n = 1 with no `settled` and no preemption, the hash moving with `k`.
- `tests/verify/decision.test.ts` — the seven structure rules, one mutant each; the decision claims;
  the compiled race in all four families, with mutants proving the exclusion and `bound(won<=1)`
  are not vacuous.
- `tests/mastra/runner-preempt.test.ts`, `tests/compiler/leaf-preempt.test.ts`,
  `tests/engine/preempt-scope.test.ts`, `tests/mastra/step-result-roundtrip.test.ts` — the verdict
  frozen at settle, effects iff `own`, the leaf mapping the verdict without reading a signal (source
  guard), `forgetSuspension`, the preempted row's round trip.
- `tests/engine/race.test.ts` — end to end on Mastra's `Run`: first success wins; the late-decision
  window; run abort and preemption before a retry, against the default engine; a preempted loser past
  its deadline; resume labels as Mastra writes them; all fail -> lowest index; `QuorumNotMetError`
  with `suspended` and `preempted` distinct; cancel mid-race (each arm keeps its own outcome, as on
  the default engine); a retrying loser finishing its delay (row 108); a loser ignoring its signal; a
  loser behind an exhausted `limit` (row 110); `concurrency: 2`; winners by arrival, not index; the
  next entry's input with arm keys optional and required (row 103).
- `tests/engine/race-next.test.ts` — `.then(next)` under `validateInputs` against a default-engine
  oracle; a forced `cloneWorkflow` running on `DefaultExecutionEngine` as a plain `.parallel()`.
- `tests/verify/race-blueprints.test.ts` — the composition matrix through `init()`: n = 3 (k = 1..3)
  and n = 4 (k = 1, 2) × run budget 1 × `limit(1)` in two arms, and an arm retrying on a timed net;
  every family in all eight default segments. 26 workflows in 61 s, slowest query 7.7 s
  (`deadlockFree @closed`, smt).

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0004]: 0004-structural-cancellation.md
[ADR 0010]: 0010-restart-from-marked-checkpoints.md
[ADR 0012]: 0012-limiter-blueprints.md
[ADR 0013]: 0013-step-timeout.md
