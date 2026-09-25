# mastra-libpetri — milestones

## M0 — Repository
- [x] Scaffold from n8n-libpetri conventions, TypeScript package skeleton, CI
- [x] `libpetri` from the registry at `^6.1.0`, published 2026-09-23 as the first release carrying
      everything the engine calls ([TIME-015], the [MOD-031] fix, [NU-011], [CORE-073]/[ENV-014]).
      Until then it was linked from the sibling checkout. Switched with every gate re-run
      against the release: 562 tests across 22 files, `npm run check` and `npm run build` clean.
      Linking remains, deliberately opt-in, for trying an unreleased fix
- [x] Gates that fail loudly rather than degrading quietly: `tests/z3-gate.test.ts` (a missing
      solver turns every proof into `unknown` and still reports green) and
      `tests/upstream/libpetri-surface-gate.test.ts` (a missing clock does not throw — the
      executor silently reads the machine clock and a deterministic run simply is not)
- [ ] `debe/mastra-libpetri` created and pushed
- [x] Final integration: `npm run check && npm test && npm run build` green (3 files, 4 tests);
      `scripts/link-libpetri.sh --check` clean against pin `f34ea8a`. Both gates verified live
      rather than assumed: the z3 gate passes on a resolved solver, and the surface gate passes
      against the linked tree, which carries `systemClock`, `seedToken`, `injectNoAwait`,
      `executor.snapshot` and `Marking.fromSnapshot`. The smoke test fires a transition through
      `PrecompiledNetExecutor` and asserts the token moved

## M1 — Compiler, Mastra bootstrap, seam confirmation
- [x] Track A, first slice: the orchestrator core. `src/compiler/{names,types,compile}.ts`
      emits a linear chain — entry *i* owns an input place, its transition produces into entry
      *i+1*'s place or into `wf.done`, and every run transition declares `xor(success, failure)`
      so a failing step deposits a token instead of unwinding. `.sleep` -> `delayed`,
      `.sleepUntil` -> `exact`; no hard timing on any path that can cross a restore. One naming
      vocabulary with a global-uniqueness assertion (`/` reserved for [MOD-013] prefixes, `.`
      for our segments), `NetMap`, structural hash over shape and names only.
      `src/engine/kernel.ts` seeds the entry place, runs to quiescence and classifies the
      terminal marking — no loop in the engine, ordering from [EXEC-002] alone. Measured:
      `deadlockFree` and `terminatesAtSink` both **proven via the SMT route** with Z3 on a
      4-entry chain (6 places, 7 transitions after xor expansion, 1 P-invariant, 54ms/23ms);
      a 60s `.sleep` elapses in virtual time with two executors in one process on independent
      clocks
- [x] Track A, composite gadgets: `.parallel`, `.branch`, `.dowhile`/`.dountil`, `.foreach`,
      each in `src/compiler/gadgets/` against a shared `Gadget` contract, each built and then
      **adversarially verified** by an independent agent. Measured: 162 tests across 15 files,
      `deadlockFree` and `terminatesAtSink` proven for every gadget across 30+ shapes; no
      stranded token found in ~80 hand-built executor scenarios that read the full residual
      marking rather than the classifier's verdict. Non-vacuity was established by mutation for
      parallel (removing the join inhibitor, the errSeen reset, or the arrival deposit each
      flips the verdict to `violated`)
- [x] Two defects found by verification and fixed: an arm id of `__proto__` silently replaced
      the parallel aggregate's prototype instead of becoming a key, losing that arm's output
      (`Object.fromEntries` defines it as an own key; regression test added); and `classify()`
      checked the terminals before scanning for strays, so a run that reached `wf.done` *and*
      stranded tokens reported a clean success — measured at six stranded tokens reported as
      success. The scan now runs first and always, and `residue` is present only when non-empty
      so every existing `toEqual` assertion became a leak detector without opting in
- [x] Track A, the IR pass the audits forced ([ADR 0003]). The lead wrote the contract and
      smoke-tested it end to end before anything was built on it; six agents then rebuilt every
      gadget, the leaf suite and the adapter with disjoint file ownership, each followed by an
      adversarial verifier that mutated **scratch copies** registered through the `gadgets`
      override — never `src/`, which the other agents were running against. What changed:
      five step outcomes (tripwire a field of `failed`, as in Mastra); every outcome routed to an
      exit the enclosing context chooses, which settles where `bail` belongs; five terminal
      places, each a declared sink, so `wf.done` no longer silently receives bailed runs; arms and
      bodies narrowed to a single step, as Mastra types them; a run-scoped step-result store
      reached through `executionContextProvider`, so a compiled net holds no runner and one net
      serves every run; retries **unrolled**, one transition per attempt, so the ceiling is
      structure; per-run waits; `.map()`, agent and tool entries compiled as steps with a
      `source`. Closed divergence rows 7, 8, 11, 12, 17, 18, 19, 20; rows 9, 10, 13, 14, 16 stay
      deliberate refusals. Measured: 562 tests across 22 files, `npm run check` clean, against
      `libpetri 808171c dist=9adfac496ed2`, certified clean and fresh by `--strict`
- [x] A third property, because the verifiers showed the first two blind to it:
      `exactlyOneTerminal` — `quiescentCount(terminals, 1, 1)`. A step writing to both `next`
      and `failed` leaves `deadlockFree` and `terminatesAtSink` **proven** and only this one
      **violated** (`tests/verify/linear-chain.test.ts`). Every proof in the suite now asserts
      all three. Measured proof cost for `.branch()` with k arms: 106ms at k=4, 1087ms at k=5,
      and at k=6 enumeration gives way to SMT at 3.9s — the curve the split threshold is chosen
      from. `.foreach()` proofs are the expensive ones: 3.9s at c=1, 14.8s at c=3, 20.9s with a
      retrying body
- [x] Defects the phase found in the lead's own contract, all fixed with tests: a literal
      `.sleepUntil` compiled to `exact(epochMs)`, which libpetri measures **from enablement**, so
      it waited about fifty-four years for a real date — carried untested since the M1 first
      slice, and found by an agent told to test the leaf against Mastra rather than against its
      author; a rejection carrying no reason read as success and skipped the wait; a top-level
      bail left its step result `bailed` where Mastra rewrites it to `success`; any non-undefined
      `tripwire` classified as a tripwire where Mastra requires an `Error` or a `reason`; a
      malformed carried-in step result stranded a run instead of being refused at the boundary;
      a Petri-vocabulary refusal message reaching Mastra users
- [x] A libpetri executor hang, found by a verifier and reproduced against raw libpetri with no
      code of ours: `PrecompiledNetExecutor` completes a 4097-place chain in ~120ms and spins
      **synchronously** on a 4098-place one, so `run(timeout, 'close')` cannot interrupt it;
      `BitmapNetExecutor` runs the same net in ~115ms. Reported upstream with the repro (U7).
      Stopgap: `compile()` refuses nets above `MAX_NET_PLACES` (4096) and the adapter refuses
      retries above 100 and `.foreach()` concurrency above 256, each by name — a hang no timeout
      reaches is the worst failure there is (row 24)
- [x] The loop bound's claim, corrected: the IR said `iterationBound` "makes termination
      provable". It does not — every verified property ranges over quiescent markings only
      ([VER-002]), and a loop cycling forever reaches none, so the loop verifier found that
      disabling the bound leaves every proof green. The bound stops the loop at runtime by
      construction, pinned by a structural test, and is now described that way in `types.ts`,
      `properties.ts` and row 13
- [x] Track A, contract completion ([ADR 0004]). Three workflows — build, integrate, migrate —
      each with an adversarial verifier per area, 39 agents in all. **Structural cancellation**
      exactly where Mastra checks its signal: before each top-level entry (an inhibitor plus a
      sweep), after each (the settle stage, Mastra's re-stamp), between loop iterations, before
      each foreach dispatch — and nowhere else, so a started block's arms and a step's retries run
      on, as in Mastra. **Failures carry their origin**, closing duplicate-id ranking. **Foreach
      items carry their index** at the foreach's view path. **Step records hold what Mastra's
      `StepResult` holds** — payload, first-attempt `startedAt`, `suspendedAt`, `iterationCount`,
      and a `canceled` variant only combinators write. Measured: 895 tests across 27 files plus 2
      opt-in slow proofs (foreach at three lanes, both **proven** in 72s), check and build clean,
      against the released libpetri 6.1.0
- [x] Proofs in two segments on one closed net, paired inside `verifyWorkflow` so neither can be
      dropped: no cancel ever (plus `neverCanceled`), and one cancel landing at **every** reachable
      point. Registering the cancel place as an environment place sent every proof to SMT — 0 of
      103 enumerated, slowest 411s, `unknown` on mutants a closed proof refutes in 7ms — so the
      arrival is a transition in the net and the proof seeds it. Parallel, branch and loop cancel
      proofs now run by enumeration in 18–29ms. At runtime the kernel injects into the signal
      directly: routing a real abort through the arrival cost one firing, and every verifier found
      a start slipping past its inhibitor in it
- [x] A **structural cancel check**, run before every proof, because a start that lost its
      inhibitor still drains to exactly one terminal and no property can see it. Rules: the signal
      is never consumed or reset; a transition whose inputs contain, or are contained in, a sweep's
      is inhibited by the signal. Stripping inhibitors produces exactly one named violation each.
      A source guard keeps any gadget from reading the signal at all
- [x] Found against the lead's own code and fixed, each pinned: a suspended record lost its
      suspension (two fields shared the key `payload`); an aborted sleep recorded success; a retried
      step took its last attempt's start; **an aborted sleep decided cancellation by reading the
      signal in its action** — `neverCanceled`, new that day, was violated by it, and the fix routes
      it through the same inhibitor/sweep pair; a pre-aborted run started its first step; an abort a
      microtask after a step let the next one start. A vacuous race test — its abort landed after
      the run in 120 of 120 runs — was replaced by a deterministic pin of Mastra's ordering
- [x] Help from the libpetri sessions, asked rather than reconstructed: drain-on-terminal is safe
      in 6.1.0 (wake-ups are latched); a soundness scare was our misuse (`environmentPlace` takes a
      name); a seeded arrival proves only runs the cancel reached, hence the pairing; the
      structural check stands in for a missing `neverEnabledWhile` property, which they passed on
      to the maintainer with enumeration for bounded environment places
- [ ] Track A, remaining after that: dot export, and the `.branch` split threshold, now chosen
      from the measured curve above
- [ ] Open question carried out of the audit, cheap and worth answering before renaming
      anything: Mastra's `loop.predicate` and `conditional.predicates` are declarative,
      serialisable guards present whenever the `.branch({predicate})` / `.dowhile({predicate})`
      overloads are used. If a bound is derivable from one, `maxIterations` may be a checkable
      bound for the declarative form rather than a permanent invention
- [ ] Known limits recorded, not closed. The `foreach` nested 2x2 `unknown` is gone — a foreach
      can no longer contain a foreach. The `loop` allowance is provable only when seeded at the
      post-`start` marking (`placeBound(budget, k)` proven, `k-1` violated): `start` writes `k`
      tokens into one place its `and` names once, which libpetri accepts but its analyses model
      as one token per named place ([IO-016]). That multiplicity is specified (U8); closing the
      limit means expressing the allowance in topology. No property establishes termination
      (see above)
- [ ] Track A: assert the instantiate -> fuse -> re-instantiate round-trip. Depth is
      unconstrained now that [MOD-031] is fixed, but it is the shape nested workflows take and
      a regression there is silent token loss rather than a build error
- [x] Track C, the half that grounds everything else: `scripts/bootstrap-mastra.sh` +
      `scripts/mastra-pin`. The plan assumed Mastra's semantics could only be read from a
      monorepo clone. They cannot *only* be read that way — `@mastra/core` publishes `.js.map`
      files carrying `sourcesContent`, so `--dist` recovers the workflow engine's **original
      TypeScript** from the tarball: 53 files, ~11.8k lines (`default.ts` 1238,
      `workflow.ts` 5284, `handlers/control-flow.ts` 1495, `execution-engine.ts` 251). Cheaper
      than a clone and more correct to compile against, being the tree a user actually runs.
      The tarball is verified against a pinned sha512 before extraction, and the recovery
      asserts the seven load-bearing files appear rather than silently degrading to `.d.ts`.
      `--repo` keeps the clone for the one thing the tarball cannot do: run Mastra's own tests
- [x] Track C: the compiler audited against that source by four parallel agents — **61
      blocker/major findings, 14 of them blockers**, each with a `file:line` citation. Three
      reshape the IR rather than a gadget: `.sleep`/`.sleepUntil` accept a **function**
      resolved per run, so neither can be a compile-time constant; a Mastra **loop has no
      iteration bound at all**, so our `maxIterations` is a Layer 2 addition and not parity;
      and `.parallel`/`.branch`/`loop`/`foreach` arms are typed `SingleStepEntry`, so our
      `EntryDescription` arms model nets Mastra cannot express. The costliest is quieter: after
      a `.branch`, Mastra hands the next entry a record keyed by **every declared arm** with
      `undefined` for the skipped ones, where we emit only the arms that ran — a plausible
      answer computed from the wrong object
- [x] Track C: `src/mastra/{host.ts,adapt.ts}` — Mastra's graph types mirrored structurally
      (so `@mastra/core` stays a type-only devDependency and nothing is imported at runtime)
      and `adaptStepFlow(entries)` mapping real `StepFlowEntry[]` onto the compiler's
      description, end to end through `compile()` and `runWorkflow`. Nine behaviours it would
      get wrong are **refused at build time with a named error** rather than mis-compiled
      (divergence rows 7–14, 16). The IR itself was left untouched: each required change is
      recorded rather than applied, so the fix lands in one deliberate pass instead of racing
      the gadgets
- [x] Track B: `tests/spikes` — four spikes, 56 tests, pinning deposit visibility and `Out`
      validation exactness, [EXEC-002] ready order and the fast-path seam, [TIME-010..012]
      clock restart under an injected clock, and compose collisions + the
      instantiate→fuse→re-instantiate round-trip + ν minting. Each was then **adversarially
      verified by an independent agent that mutated the code and measured whether the test
      flipped**. Reported honestly: three verdicts came back `partly-vacuous` and one
      `unsound`, with named inert assertions in each — the spikes are useful and are not yet
      the tripwire they claim to be
- [x] Track B found two [NU-011] defects by measurement — the default ν scope was a
      per-process counter rather than AC#5's 32-hex random token, and `'#'` was accepted in a
      host-supplied scope although it is the scope separator, making two unrelated origins mint
      one name. Both were pinned *as observed*, with assertions deliberately phrased to break
      under the spec-conforming implementation. Both then broke mid-session when libpetri
      implemented them (`randomExecutionScope`, `resolveExecutionScope`). The tests now pin the
      fixed behaviour and keep the collision's arithmetic visible
- [x] The pin gate was wrong, and the phase is what exposed it: `link-libpetri.sh --check`
      passed while the code that actually ran was an **uncommitted working-tree build** no
      revision names — the pin matched `HEAD`, the check passed, and every figure was
      attributable to a revision that never produced it. Identity is now content-addressed —
      `provenance: libpetri <rev>[+dirty] dist=<hash>` — with `--provenance` to quote beside a
      measurement and `--strict` to refuse certifying a dirty tree. A dirty sibling stays
      *expected* while [CORE-073] is unlanded; what changed is that it is no longer silent
- [ ] The IR pass's own inert tests: its six verifiers named **28** tests that pass for reasons
      other than the one they state (parallel 3, branch 6, loop 5, foreach 5, leaf 5, adapter 4),
      listed with the mutation that exposed each in the phase's verdicts. The recurring one: at
      runtime the joins' precedence is decided by declaration order, so the precedence tests stay
      green with an inhibitor removed — those inhibitors are pinned by proofs only. Not fixed in
      the phase; recorded so the suite is not read as more coverage than it is
- [ ] Track B: the named inert assertions from the four adversarial verdicts, chiefly
      `deposit-and-out`'s four `fastPathEligible` checks and `reset-clock`'s unreachable
      `transition-clock-restarted` half. A spike that passes for the wrong reason is worse than
      no spike, because it reads as coverage
- [ ] Track C: unpatched baseline run, conformance matrix scaffolding, the two upstream PRs
      drafted in `patches/mastra/` (`--repo` clone required)

## M2 — Engine (the kernel)
- [x] `PetriExecutionEngine extends ExecutionEngine` and owns `execute()` ([ADR 0005]):
      `@mastra/core` is a runtime peer dependency imported **only** under `src/mastra/` (a
      source guard enforces it), and every firing runs on Mastra's own single-step executor,
      `StepExecutor` from `@mastra/core/workflows/evented` — one attempt per call, so the net's
      unrolled retries own retrying, and Mastra keeps validation, spans, the step context,
      suspend, bail and abort. One store: the executor reads the kernel's records through a
      translating view; the runner holds only Mastra's workflow state, data that never decides
      flow. `init()` with the `PetriEngineType` brand, both directions proven by mutation.
      Result formatting ported from `fmtReturnValue`; start and terminal snapshots written to
      Mastra's storage; resume, restart, time travel and per-step runs refused by name (M4)
- [x] **The differential harness**: every fixture of a real-Mastra corpus run on both engines in
      one process. Data equivalence is the gate — status, result, error shape, every step's
      record, state — and happens-before too: an ordering the default engine establishes may
      only be weakened for pairs a fixture declares independent. An **engine-identity probe**
      proves each side ran on the engine it claims; before it, a mutant running the default
      engine on both sides passed everything, and afterwards it fails all 33 fixtures. At k = 1
      every fixture is `pass` or `divergent` with a register row (26, 35)
- [x] Contract closed on the way, from what the harness and verifiers found: a canceled token
      states `started` structurally — a fixed `.sleep` became `begin` -> `waiting` -> `wake`, so
      "never started" and "mid-wait" are different places — which gives Mastra's `waiting`
      record and the right persisted path; records carry the **validated** input; the
      precompiled net is cached, as this file always claimed; a run can have no timeout; a
      bailed success carries its origin and a tripwire its error; the executor refuses to run a
      program compiled from a different net than the one proven
- [x] Final integration: `npm run check` clean, `npm test` **1,257 passed** across 35 files plus
      2 opt-in slow proofs, `npm run build` clean — against libpetri 6.1.0 and @mastra/core 1.67.0
      from npm. Four workflows (build, close-out, final migration), 32 agents, every area
      adversarially verified; the last verifiers re-derived each of 60 migrated `started` values
      from the transition that fires and found none wrong and no assertion weakened. The register
      holds 69 rows with **none open for M2**; what remains is assigned: M3 (rows 48, 49), M4
      (resume, per-step snapshots, the codec), M5 (step events, spans, scorers), M8 (agents)
- M4 owns the `MarkingCodec` <-> `WorkflowRunState` round-trip: `src/codec/` is empty and
  `mastra/persist.ts` builds the snapshot one way, at start and terminal

## M3 — Concurrency + differential report
- [x] **k defined, and it is a bound** ([ADR 0006]). The plan inherited "k > 1" from n8n, where the
      host runs nodes one at a time; a Layer 1 Mastra workflow has no concurrency for the net to
      add, since `.parallel`, `.branch` and `.foreach` already run concurrently in Mastra. What
      Mastra lacks is a bound. `PetriExecutionEngine({ concurrency: k })` compiles a place of `k`
      permits every step attempt takes and returns in every outcome branch; `k` lives in the
      initial marking, so every budget shares one net. Proven in both segments as
      `permitsBounded` and `permitsReturned`; checked on the arcs by `budgetStructureViolations`,
      which `verifyWorkflow` runs before any proof — including the rule that every step attempt
      takes a permit, added after a mutant compiling a body with no permit passed all eleven
      proofs. A permit count other than `k` at rest is reported as residue
- [x] **The differential at k ∈ {1, 2, 4, ∞}**, the whole corpus (39 fixtures) against Mastra's
      unbounded oracle: 0 failures, 0 reversed and 0 inverted pairs at every k; every
      strengthening — an order the budget imposes that Mastra overlaps — listed in the M3
      report. Candidate peak in flight = min(k, width) in every cell where the budget binds
      (`parallel-wide` 6/1, 6/2, 6/4, 6/6). Wall time grows as the budget binds (`foreach-c5`
      123 / 60 / 30 / 24 ms at k = 1 / 2 / 4 / ∞), as a bound should
- [x] **Found and recorded, not hidden: a budget is not data-neutral for racy state.** At k = 1
      `workflow-state` differs from Mastra. Mastra's parallel arms share one live state object
      merged in place as each finishes, so overlapping read-modify-writes lose all but the last
      write; serialised, none is lost. The race is the workflow's and the budget selects an
      interleaving Mastra itself produces when timing differs (row 71). ADR 0006's "identical at
      every k" is narrowed to say so; snapshotting state at the fork would have hidden it and
      diverged from Mastra elsewhere. Rows 70, 73 and 74 record the other effects of a budget
- [x] Deterministic clocks: libpetri's sharpest clock test — a clock that resolves only on abort —
      applied to our nets: every untimed shape completes through the executor's own wake
      sources, and timed ones stay pending until aborted. Two executors on independent virtual
      clocks give identical records. `PetriExecutionEngine({ clock })` runs a 60-second Mastra
      sleep instantly. Nothing correlates on `executionId()` (asserted); runs correlate by
      `runId`. Mastra's own step code still reads the machine clock (row 72)
- [x] The "action timeout hole" does not exist: Mastra 1.67 steps have no timeout option and the
      compiler emits no `Out.Timeout` (row 6 withdrawn)
- [x] Rows 48 (record carry-over across uses of one step id) and 49 (foreach aggregate records)
      fixed; conformance `loop-then-loop` records `iterationCount` 5 on both engines at every k
- [x] Final integration: `npm run check` clean; `npm test` **1,533 passed** across 39 files; 4
      opt-in slow proofs proven (`SLOW_PROOFS=1`); `npm run build` clean — libpetri 6.1.0 and
      @mastra/core 1.67.0 from npm. 74 register rows, none open for M3 or earlier

## M4 — Suspend and resume ([ADR 0007])
- [x] Design: research, three independent designs, three judges, synthesis; the seeded-segment
      design chosen unanimously. Contract written and typechecked: resume sites, arm and foreach
      re-entry tokens, `FlowToken.resumed`, `pending` suspensions, foreach meta, stubs that throw
- [x] W1 compiler core — an `EntrySite` per top-level step and loop, `resumeSeed` mapping every
      stored status to an arm verdict, and named refusals: a changed workflow (`id-mismatch`,
      row 78), unsupported stored shapes (row 80), a nested-workflow foreach body (`nested`, row 77)
- [x] W2 blocks — `gadgets/reentry.ts`: per-arm `resume-j` gates, `re-enter-j` (inhibited by
      `wf.cancel`) and its sweep, `replay-i` through the block's own join so `decide` never re-runs;
      join-susp carries `pending`; a misfit seed fails the block by name (rows 34, 43, 79, 80)
- [x] W3 leaf and loop — the resumed attempt and its record, `suspendedAt` on every suspension,
      falsy resume data recorded as a fresh start via `resumedAt` (row 82); a resumed loop restarts
      its allowance (row 13)
- [x] W5 kernel — a run seeded at a registered site; per-place counts shared with the verifier
      (`initialCounts`), an entry seed's colour, and a failed firing ending the run as `stranded`
      instead of waiting forever under Mastra's signal (rows 66, 68)
- [x] W6 runner — resume data, suspend data, the nested-workflow overlay, labels, a foreach item's
      prior record (non-success siblings from the segment never read, row 87), and host
      preconditions rejecting the resume as on the default engine (`HostPreconditionError`, row 84)
- [x] W7 engine and snapshot — `decodeResume`, refusals before the first persist (Run's claim
      released), the `#lastPersisted` guard, the resume-start row, `suspendedPaths` from every
      suspension, tracing ids and `tracingContext: undefined` as Mastra writes it (row 63)
- [x] W8 verification — `resume@s` and `resume@s+cancel` for every site, by default; six structure
      checks (`resumeGateViolations` with sweep destinations, threshold, coverage, timing)
- [x] W4 foreach — cursor order, `parked`/`unpark`, re-entry, `__workflow_meta` (`foreachIndex`,
      `foreachOutput`, `resumeLabels`), resumed-aggregate host fields; **the refusal is lifted**:
      `resume-foreach-index`, `-no-index`, `-parked` pass on every route at every k with no
      attribution. A nested-workflow body stays refused (row 77)
- [x] W9 conformance — suspend-then-resume on routes default>default (oracle), petri>petri,
      default>petri and petri>default at k = 1, 2, 4 and unbounded; last-entry resumed blocks
      (`resume-parallel-last`, `resume-branch-last`); route-scoped attributions
- [x] Final integration (registry libpetri 6.1.0, not linked; z3 on PATH): `npm run check` exit 0;
      `npm run build` exit 0; `npm test` "Tests 26 failed | 2135 passed | 35 skipped (2196)" under
      load average 20-34, every failure a solver timeout or a killed z3 (`unknown`), none a wrong
      verdict; the nine files re-run unloaded: "Test Files 9 passed (9)", "Tests 361 passed | 7
      skipped (368)". `SLOW_PROOFS=1` resume lane (resume-segments, resume-proofs, foreach-resume):
      "Tests 205 passed (205)". Resume differential: 317 pass, 51 divergent-and-attributed, 0 fail;
      fresh-run differential 206/206
- [ ] Open after M4, none blocking: row 84's key residual (`tripwire: undefined`,
      `suspendPayload: {}` on a foreach thrown-result entry); row 86 (a rebuilt foreach entry — needs
      the item's full record on its tokens, a `stepRecord?` on the exit tokens); `StrandedRunError`
      naming the failed transition; `HostPreconditionError` from a `.parallel()` arm or loop body,
      untested; surviving mutants P6, P8, P13, P14; partial resume@ verdict maps in the budget, loop
      and foreach mutant tests; exact key lists in leaf-resume and anchored refusal messages in
      parallel-/branch-resume; ManualClock stamps for pending tokens; `foreachOutput.*` clock stamps
      in `EXCLUDED_PATHS`; the e2e falsy-resume loop for `''` and omitted data
- Dropped from the plan, with reasons in ADR 0007: capturing a marking with `executor.snapshot()`
  (a suspended marking is dead and rebuilt from records; `snapshot()` throws after drain), and
  driving drain and injection from inside `Clock.sleep` (a resume injects nothing)

## M4b — Restart and crash recovery
- [ ] `Run.restart` and boot-time recovery: per-step snapshot writes and `activeStepsPath`
      (row 55), `engineType` in Mastra's run registry (row 62), the restart halves of rows 40 and
      54. Reuses M4's sites and decoder. Restore timing is decided here, not for resume

## M5 — Streaming and watch
- [ ] `EventStore` adapter maps net events onto Mastra's step-event vocabulary and publishes to
      `workflow.events.v2.${runId}`, so existing `.watch()` / `.stream()` observers keep working
      unchanged; `DebugAwareEventStore` tee for the libpetri debug UI
- [ ] **The live testbed, and browser e2e.** The plan listed a live testbed — a real Mastra app with
      this engine registered, driven end to end — under verification but never gave it a
      milestone; nothing drives a browser today. It lands here, where it becomes worth recording:
      once step events flow (row 57), a run in Mastra Studio shows its steps progress, and the
      libpetri debug UI shows the net's marking live. Recorded browser runs of both, against a
      `.testbed/` app (gitignored), with its numbers kept apart from conformance numbers

## M6 — Verification
- [ ] `verify(workflow)`: deadlock freedom with the complete sink list, termination at declared
      sinks, dead steps, mutual exclusion, place bounds, retry ceiling. CI gate asserts `Proven`
      per compiled workflow across the corpus; `Unknown` fails, missing z3 fails

## M7 — Structural resources (Layer 2 — degrades gracefully)
- [ ] Mastra-vocabulary options (`concurrency`, `retries`, `retryConfig`, `timeout`) compile to
      permit places, budget places with inhibitor fallbacks, leaky-bucket refill transitions and
      mutexes; each carries its P-invariant as a proven `placeBound`
- [ ] Each Layer 2 option is verified *ignorable*: a workflow carrying it still runs correctly
      under `DefaultExecutionEngine`, merely unbounded. That is the layer's contract, and it is
      a test rather than a claim

## M7b — Blueprints (Layer 3 — new capability)
- [ ] The `PetriEngineType` phantom brand gates the extended builder, so reaching for a
      blueprint is a typed, visible decision and never a silent incompatibility
- [ ] First wave: `limit(n)`, `rateLimit(burst, per)` with a fusible permit place so separate
      steps share one provider quota, `race()`, `quorum(k, n)`
- [ ] Second wave: `pipeline()` — the one the IR structurally cannot express, since
      join-before-next-index is its defining property — plus `supersede()`, `compensate()`,
      `circuitBreaker()`, `queue(depth)`, `correlate(key)`
- [ ] Each blueprint ships with its property: `limit` with `placeBound`, `circuitBreaker` with
      reachability of the open state, `correlate` with `joinedOrDeadLettered`. A blueprint
      without a proven property is not done
- [ ] Composition is the acceptance test: `rateLimit` fused across three steps is one quota,
      `limit` inside `pipeline` is a bounded pipeline, and neither needs special-casing

## M8 — Agents, tools and networks
- [ ] `{type:'agent'}` / `{type:'tool'}` entries: tool-call dispatch is a round in the net
      (`dispatch / collect / resume` with a `rounds` budget place), not a host loop; multi-agent
      networks compose as subnets over shared places; audit `agent/durable/` and `harness/`
- [ ] Nested workflows — unblocked by the [MOD-031] fix, so in scope rather than deferred

## M9 — Upstream (Mastra)
- [ ] PR 1: export the handler param types (`ExecuteStepParams`, `ExecuteParallelParams`,
      `ExecuteEntryParams`) or add a `./workflows/handlers` subpath export
- [ ] PR 2: replace `engineType === 'default'` in `restartAllActiveWorkflowRuns` and
      `listActiveWorkflowRuns` with a capability predicate, so a third-party engine's runs are
      visible to boot-time recovery; each PR ships with its neutrality proof
- [ ] PR 3 (IR extension, only once M7/M7b has measured it): a `concurrency` option on
      `.parallel()`. `DefaultExecutionEngine` can implement it with the same `fastq` queue
      `.foreach()` already uses, so the proposal carries semantics, a reference implementation
      and a proof rather than an ask
- [ ] PR 4 (same bar): a `{type:'race'}` entry, proposed only if the blueprint sees real use

## M10 — Blueprints upstream to libpetri
- [ ] `adk-libpetri`, `temporal-libpetri` and this repo will each hold a rate limiter, a bounded
      operation and a compensation step; temporal already has
      `blueprint/{BoundedOperation, OperationCall, CorrelatedJoin, ApprovalGate, CompensationStep}`.
      Three independent variants of the same shapes is the argument for consolidating the
      host-agnostic ones upstream. Propose after M7b, with this repo's proofs attached

---

## Track U — upstream libpetri

Raised with the libpetri and temporal-libpetri sessions during planning rather than mitigated
here. Three of this plan's five gaps closed as a result, one of which was a correctness bug
nobody knew about.

**Delivered and committed** (`5462170` spec, `7dd51c8` TypeScript, `54e4ce3` Rust, `244c3f5`
Java; changelog staged as Java 6.1.0 / TypeScript 6.1.0 / Rust 7.0.0 / Python 5.1.0, version
bump not yet run):

- [x] U1 — [TIME-015] Injectable Clock (SHOULD, new). Per-executor `clock` supplying the
      monotonic firing clock, the epoch clock and the wait. Retires the clock gap
- [x] U6 — [MOD-031] place-alias identity drop. Found from a temporal-libpetri warning,
      confirmed by execution in TS and Rust, fixed in all languages. Retires the compiler's
      pass-depth constraint, which unblocks nested workflows
- [x] U4 — [NU-011] Resume-Safe Fresh-Name Minting (MUST, new). Closes the collision where a
      resumed executor re-mints `fork#0` against restored names

- [x] U5 — [CORE-073] marking snapshot/restore (MUST) and [ENV-014] with the quiescence
      framing, committed in `78e3b10` (TypeScript), `ac3dbe0` (Rust, Python), `c26a1db` (Java).
      The pin moved to `808171c`; the tree is clean and its build fresh, so `--strict`
      certifies it and figures are attributable to a revision for the first time

**Ahead of the 6.1.0 release** (TS release commit `70e7f38`), none of it depended on:

- [ ] U7 — the `PrecompiledNet` word-index fix (`Int8Array` -> `Int32Array`): place ids from
      4096 up wrapped negative, a synchronous spin on an input arc and a silently ignored
      inhibitor. Found for us, fixed in libpetri's working tree, **uncommitted**; confirmed live
      when linked (4098 places in 121ms). `MAX_NET_PLACES` = 4096 keeps every id below 4096, so
      it excludes both failures on the release; lift it with the release that carries the fix.
      Confirmed 2026-09-23 by libpetri-d6: the only uncommitted code in libpetri, TS-only (Java
      uses `int[]`), no release scheduled; a TS 6.1.1 patch is the natural vehicle, and the
      libpetri session is raising it with the user
- [x] U8 — answered: several tokens into one place an `and` names once is **specified**
      ([IO-015] validates the set of places; [IO-016 AC4] deposits and reports one WARN per
      transition per execution). The loop gadget stands on specified behaviour
- `4d7a9d9` — ν-join verification soundness, committed after the release. Not relevant: no
  compiled net uses `matchSpec` or `freshName`

**Not pursued, deliberately:**

- [ ] U2 — admission hooks (`beforeCycle` / `afterAdmission`). Temporal needs them; this engine
      does not. Kept separate from U1 precisely so the clock could land without inheriting an
      [EXEC-001]/[EXEC-003] parity review. Not this repo's ask to make

**Open upstream question, reported not pressed:** action timeouts still elapse on a real
`setTimeout` under an injected clock, and `Out.Timeout` is exactly what step timeouts compile
to — so the one timing construct that survives a restore cleanly is the one virtual time does
not reach.
