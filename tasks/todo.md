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
- [x] `debe/mastra-libpetri` created (private) and pushed, 2026-10-04
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
- [x] Dot export: `toDot(compiled)` in `src/compiler/dot.ts`, over libpetri 8.0.0's
      `libpetri/export` (`mapToGraph`, `renderDot`) with one cluster per entry path from the `NetMap`;
      compiler entry only, never the Mastra-facing root. It refuses a net whose distinct names
      `sanitize` merges into one DOT id (a block `0_b` at [1] and its arm `b` at [1,0]): `slug` keeps
      `-` and `_`, `sanitize` maps both to `_`. Only the picture is refused, not the run; an injective
      `sanitize` is a libpetri ask (Track U)
- [ ] Track A, remaining: the `.branch` split threshold, chosen from the measured curve above
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
- [x] Track A: assert the instantiate -> fuse -> re-instantiate round-trip
      (`tests/compiler/fuse-roundtrip.test.ts`): a compiled child bound by identity-named ports, its
      cancel fused with the parent's, re-instantiated; every place once under its final name, every
      alias resolving, no token lost on the executor, a cancel reaching the child through the fusion.
      Reapplying the [MOD-031] defect (`dropIdentityEntries`) fails it. Was: Depth is
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
      preconditions rejecting the resume as on the default engine (`HostPreconditionError`, row 84;
      inside a `.parallel()` arm and a `.dountil()` body too, `tests/mastra/host-precondition.test.ts`)
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
      the item's full record on its tokens, a `stepRecord?` on the exit tokens); a real Mastra run
      reaching `StrandedRunError` with a failed firing (the error names the transition since M7b
      prep, pinned on a replayed report: a checkpoint failure is thrown as the storage error first);
      surviving mutants P6, P8, P13, P14; partial resume@ verdict maps in the budget, loop
      and foreach mutant tests; exact key lists in leaf-resume and anchored refusal messages in
      parallel-/branch-resume; ManualClock stamps for pending tokens; `foreachOutput.*` clock stamps
      in `EXCLUDED_PATHS`; the e2e falsy-resume loop for `''` and omitted data
- Dropped from the plan, with reasons in ADR 0007: capturing a marking with `executor.snapshot()`
  (a suspended marking is dead and rebuilt from records; `snapshot()` throws after drain), and
  driving drain and injection from inside `Clock.sleep` (a resume injects nothing)

## M4b — Restart and crash recovery ([ADR 0010])
- [x] Design: maintainer decisions — checkpoints are explicit (`metadata.checkpoint`, snapshots are
      not free), only at top-level boundaries; `engineType` stays `'petri'` and `createRun` is
      wrapped; a failed checkpoint write rejects the run; restart proven at every boundary; a Mastra
      row inside a block re-runs the whole entry. Restore timing: a restarted sleep waits in full,
      as on Mastra (`handlers/entry.ts:586-660`)
- [x] W0 contract (`9676227`): `BoundarySite`, `CheckpointEvent`, `StepRunner.checkpoint`,
      `RestartSeed`, `RunOptions.restart`, `RestartSegment`, the checkpoint persist phase
- [x] W1 compiler and adapter — `s.<i>.checkpoint`, `t.<i>.checkpoint` (inhibited by `wf.cancel`)
      and `t.<i>.checkpoint-cancel` into `wf.canceled` (amended from the next boundary: liveness
      witnesses went `unknown` at 30 s); unmarked nets byte-identical; `checkpoint-position` and
      `checkpoint-value` refusals; the Layer test on the default engine
- [x] W2 kernel and verify — `restartSeed`, boundary seeding, `checkpointError` on the report,
      `restart@p` / `restart@p+cancel` at every boundary, a marking proven once and cited under
      every label that shares it, `checkpointStructureViolations`
- [x] W3 host — `restart-codec.ts`, the checkpoint row, no start row on restart, `no-position` /
      `workflow-changed` refusals, the storage error rethrown, nested `restart: true`
- [x] W4 surface — the `createRun` / `_restart` seam with its upstream guard,
      `restartAllActiveWorkflowRuns` without the gate, `restartActiveRuns(mastra)`
- [x] Existing tests: fresh/resume-only proofs pass `restart: 'none'`; default lists include the
      restart segments
- [x] W5 conformance — `src/conformance/restart.ts`, `tests/conformance/restart-differential.test.ts`:
      a crash at every `running`/`waiting` row, then `restart()` on a fresh store. 8 fixtures at
      k = 1, 2, 4, unbounded: petri>petri 0 differences (a petri checkpoint restarts identically on
      Mastra's engine); default>petri 71 pass, 3 divergent-and-attributed (rows 92, 93), 0 fail at
      every k. It found a branch reusing stored arms under restart; fixed (`RunScope.restarted`)
- [ ] Open after M4b, none blocking: rows 39, 96, 99 unexercised; row 94's resumed-foreach crash;
      restarting past a `.sleep()` in a new process fails the next step on both engines (Mastra
      mints sleep ids with `randomUUID()` per build) — an upstream issue for M9
- [ ] M9 PR 2 (capability predicate) retires the seam and `restartActiveRuns`

## M5 — Streaming and watch ([ADR 0008])
- [x] Contract: an observation-only lifecycle hook, `StepRunner.observe(LifecycleEvent)` —
      `step-settled`, `sleep-waiting` / `-settled`, `foreach-entered` / `-settled` — raised by the
      firing that writes each record, awaited only when there is an observer; a step's start is the
      runner's first call. `StepCall.iteration` / `.startedAt`. Kernel `RunOptions.eventStore` tee and
      `RunReport.observerError`: an observer's throw never fails a firing. The plan's `EventStore`
      adapter was not taken: transition names cannot tell a retried attempt from the last one, and
      `append` cannot await a publish (ADR 0008)
- [x] Step events (rows 57, 58): start / result / finish / suspended / waiting, foreach progress and
      aggregate, `workflow-canceled` (row 89), gated on `emitStepEvents`, payloads equal the default
      engine's; writers routed as Mastra's (`src/mastra/events.ts`, `runner.ts`)
- [x] Spans, scorers, `actor`, `disableScorers` (row 59), a failing branch condition's log and span
      (row 60), parallel / conditional / loop / foreach spans (row 30; sleep spans and one loop cancel
      window stay open) — `src/mastra/spans.ts`, `scorers.ts`; built only under a workflow span
- [x] Differential: watch events a gated dimension on every fixture and resume route — per step id in
      order, happens-before across steps, progress and writer chunks inside their owner, clock keys by
      presence, `stepCallId` correlation; no switch turns the gate off. New fixtures `sleep-until`,
      `emit-step-events-off`, `writer`, `writer-stream`
- [x] Adversarial verification against Mastra's source found no payload defect and five others, all
      fixed: one publish queue per run serialised `.parallel()` arms behind a slow pubsub (5 arms at
      20ms latency started 21ms apart); the start event validated input a second time (an impure
      schema ran twice); the start's `startedAt` was a second clock read; a finish followed a rejected
      result; `await undefined` gave an unobserved run an extra microtask. Four harness blind spots
      closed, each with a unit test that shows it caught. A rejecting publish is recorded (row 88)
- [x] Debug UI: engine option `debug` (a libpetri `DebugSessionRegistry`, also through `init`), one
      session per segment (`<runId>`, `<runId>~resume-<n>`); a failing registry or store is logged
      and changes nothing (row 90; tests/mastra/debug.test.ts)
- [x] **The live testbed and browser e2e.** `testbed/` (committed) + `scripts/bootstrap-testbed.sh`
      build a gitignored `.testbed/`: a Mastra 1.67.0 app (mastra CLI 1.30.0, LibSQL) with seven
      workflows on this engine and the libpetri debug UI served beside it (`/debug/petri/ui/`,
      WebSocket `/debug/petri`). Recorded with agent-browser: Studio shows a sleep run's steps
      progress live and a suspend / resume through Studio's own form; the debug UI follows a live
      run's marking (`docs/assets/m5/`, the rest under `.testbed/recordings/`). Testbed timings are in
      `testbed/README.md`, kept apart from conformance figures
- [x] Final integration (libpetri 6.1.0 from the registry, not linked; z3 on PATH): `npm run check`
      exit 0; `npm run build` exit 0; `npm test` "Test Files 60 passed (60)", "Tests 2323 passed | 35
      skipped (2358)". Differential: fresh k=1 37 pass / 6 divergent / 0 fail, k=2, 4, unbounded
      38 / 5 / 0; resume k=1 80 / 12 / 0, k=2, 4, unbounded 79 / 13 / 0; 0 verdicts with an
      unattributed event difference
- [ ] Open after M5, none blocking: `WORKFLOW_SLEEP` spans and the loop span left open by a cancel
      between a continuing verdict and the next body (both need a lifecycle event, row 30); the scorer
      hook's owning `Mastra` (row 59); `foreach-empty-cancel-inside` agrees or not by microtask depth
      (row 49); Studio's recent-runs icon stays stale until reload — untested whether engine-specific;
      debug UI issues to raise upstream (no auto-fit for large nets, session list only on Refresh, a
      `?sessionId=` link opens in replay mode, tokens logged as `[object Object]`)

## M6 — Verification ([ADR 0009])
- [x] Contract: gadgets declare what they claim — `GadgetResult.claims` (a bound other than 1, or
      `unclaimed` with the reason) and `.exclusions`; the leaf records each step's attempt chain
      (`StepChain`); `CompiledWorkflow.{steps, claims, exclusions, entries}`. Nothing new is read at
      runtime, and `verifyWorkflow` is unchanged
- [x] `verify(compiled)` (`src/verify/workflow.ts`, `claims.ts`): four families per segment —
      completion (the existing set), bounds (`placeBound` on every place, 1 unless claimed), exclusion
      (Mastra's barrier, pairwise over each entry's places against `next` and every outcome place,
      plus the foreach's cursor/record and permit/slot pairs), liveness (every step attempt, retries
      included, refuted-unreachable with a **confirmed** firing sequence, `closed` only). The retry
      ceiling is `retryCeilingViolations`, a seventh structural check: each chain a simple path of
      `retries + 1` attempts nothing else enters; its final attempt's witness is the ceiling reached.
      `unknown` never holds; a missing z3 throws `Z3Unavailable` before any query
- [x] Cost, measured against libpetri 7.0.0 from npm: libpetri tries enumeration before the linear
      bound, 3–5 s a query on `parallel-wide` where the bound proves in ~20 ms. A quick phase
      (enumeration off, 5 s, kept only if it settles the claim) took `parallel-wide` from over 15 min
      to 149 s, 5,183 claims; a segment whose completion proofs enumerated skips it. A completion
      proof that is `unknown` is retried once with [VER-016] counters: `foreach-c5` `deadlockFree`
      `unknown` at 131 s -> `proven` in 346 s. Reported to the libpetri sessions, not pressed
- [x] Finding, recorded rather than claimed: a foreach's `faults` / `exits` <= lanes rests on the
      dispatch inhibitors, which no linear invariant captures; z3 proves it at 2 lanes and returns
      `unknown` at 3 (300 s; 600 s with counters). Above 2 lanes both are listed as unclaimed with
      that reason (`MAX_PROVEN_RECORD_LANES`)
- [x] `verifyMastraWorkflow` (`src/mastra/verify.ts`): adapts and compiles as `execute()` does, the
      workflow's own `PetriExecutionEngine` supplying `concurrency` / `iterationBound`
      (`settings()`), nested workflows verified too. CLI `mastra-libpetri verify <module>`
      (`src/cli.ts`): exit 0 iff every claim holds, 1 on any failure or `unknown`, 2 on usage, no
      solver, or an unsupported workflow
- [x] Non-vacuity (`tests/verify/claims.test.ts`): one mutant per family that every completion
      proof passes — a block claiming 1 where arms settle n times (bounds), a step leaving a token
      that drains later (the barrier; completion cannot see a transient), an attempt no failure
      reaches (liveness); each retry-ceiling rule by its own mutant
- [x] **The gate** (`tests/verify/corpus.test.ts`): every corpus workflow and each it nests, at
      k = unbounded and 1. Fast lane in `npm test`; the 13 workflows with a `.foreach()` (read off
      the step flow) and `parallel-wide` run with `SLOW_PROOFS=1`, sharded over a 6-way CI matrix
      (`CORPUS_SHARD`). Measured locally against libpetri 7.0.0 from npm (not linked), z3 on PATH,
      10 cores, two shards at once: **132 cases (66 workflows x 2 budgets) + 8 nested workflows,
      120,972 claims, every one holding** — completion 4,410, bounds 25,840, exclusion 90,300,
      liveness 422; routes enumeration 71,572, structural 41,674, smt 7,726. Shards 66/66 in 91 min
      and 66/66 in 134 min; the longest workflow `emit-step-events-off` (a timed foreach) at 18 min,
      `foreach-c5` 13 min, `parallel-wide` 10.5 min. Fast lane alone: 154 passed, 28 skipped, 87 s.
      *Superseded on the libpetri 8.0.0 upgrade (U13):* one lane, every workflow in `npm test`,
      30 s a query, no CI matrix — see U13 for the figures
- [x] Final integration: `npm run check` exit 0; `npm run build` exit 0; `npm test` "Test Files 64
      passed (64)", "Tests 2477 passed | 63 skipped (2540)" in 1,141 s. CI's `typescript` job timeout
      raised 20 -> 45 min for the fast lane; the `proofs` matrix has not run on GitHub — the repo is
      not pushed (M0)
- [ ] Open after M6, none blocking: a foreach's record bounds above two lanes (needs an
      inhibitor-aware invariant, or a `StateSpaceCache`-independent route; raise upstream with a
      repro); retire the quick phase once U10 ships; the CI proofs job's timing on a 4-core runner is
      unmeasured; `verify` on a nested net takes the caller's `segments` verbatim (a site list is
      per net); liveness witnesses are untimed-model runs — on a net with a fixed sleep or retry
      delay a witness may be one the clock rules out, and none has been replayed on the executor

## M7 — Structural resources ([ADR 0011], [ADR 0012], [ADR 0013])
- [x] Survey against Mastra 1.67's source: `retries`/`retryConfig` and `.foreach` `concurrency` are
      Layer 1 (enforced, compiled since M1); `timeout` does not exist; `.parallel`/`.branch` drop a
      `concurrency` key, so it rides in `metadata`. CLAUDE.md's Layer rule amended
- [x] Maintainer decisions: block concurrency (Layer 2); `limit` / `rateLimit` pulled in from M7b
      (Layer 3, per-run quotas); a step timeout now (Layer 3), raced inside the attempt on the run's
      clock after consulting libpetri (Out.Timeout runs on real time and abandons work; no abort hook
      or threshold inhibitor planned); queued arms start with the abort; a late success after the
      deadline is discarded and the timeout is retryable
- [x] W0 contract (`e1951bd`); W1 (`b9fc1ba`): block slot pool and FIFO admission (A), leaf quota
      arcs, timeout branch and funnel, `armDeadline` (B), adapter refusals (C), fused canonical quota
      places and one refill per rate quota (D), one pool conservation check and pool claims (E), the
      petri `createStep` surface, `limit`/`rateLimit`, the per-attempt gate in the runner (F)
- [x] W2 integration (`85324cc`, `f819f64`) — limited fixtures in the differential and corpus,
      `layer2-ignorable`, `blueprints` composition, timeout end to end. Every test capped at 60 s and
      every query at a 30 s total budget (`totalBudget`), queries pooled per workflow, the widest
      corpus workflows proven segment by segment. Merged `4b5383d`
- [x] CI on `24518d8`: three failures were contention — proof files side by side on a 4-core runner,
      each pooling z3, each passing alone — so `tests/verify` is its own sharded `proofs` job, one
      file at a time (`1e5e86f`). One was real: `parallel-wide` k=1 `closed/live(t.2.join.run)`
      `unknown` at 30 s alone. libpetri-d0's diagnosis (TS 8 source): enumeration is breadth-first
      and truncates at 50k classes while the witness is at the deepest level; read arcs are invisible
      to the VER-015 incidence matrix, so `neverCanceled` on a timed net fell to the state equation.
      Two local routes, each adversarially verified, until libpetri ships its own:
      - **structural, by an initially empty siphon** (`src/verify/siphon.ts`): a `placeBound` or
        `mutualExclusion` on a place no transition of the segment can ever mark is proven without the
        solver — closed `neverCanceled` on the retrying parallel 4.6–11.8 s -> under 1 ms;
      - **execution witnesses** (`src/verify/witness.ts`): on an untimed net, a liveness witness is an
        executor run of the same net with stub actions, recorded as a VER-004 firing sequence (start,
        then `complete:` with its branch) that replays against pre/post; otherwise the verifier.
      `parallel-wide @ closed` k=1 and unbounded: 26 s for both. The `limit + rateLimit + timeout`
      composition is proven segment by segment (claim volume, not a slow proof: 2,256 claims, 210 by
      smt, slowest 3.5 s). libpetri 8.0.0 from npm, not linked
- [ ] Parked for the maintainer: hold a `.parallel()` arm's run permit until its collect fires
      (prototype at libpetri-d0's suggestion). `parallel-wide` closed at k=1 from 87,152 classes to
      4,925; unbounded unchanged. Amends ADR 0006 ("returned in the same firing"), and needs the
      budget/pool structure checks to accept declared holders and givers. `branch.ts` arms likely the
      same. Not needed for the 60 s cap now
- [x] ADRs 0011–0013 accepted with Evidence; CI green on `f1c5506` (run 37231776725: `typescript`, 4 `proofs` shards, 8 `corpus` shards)
- [ ] Track U asks from this round (libpetri-d0 has them): dead-transition pruning by empty siphons
      in VER-015; a depth-first or bounded witness mode; an injective DOT `sanitize` (EXP-014, a
      breaking export change, next majors)
- [ ] Possible follow-up: verification in worker threads, grouped per net and marking, so a
      synchronous enumeration does not block the pool
- [ ] Track U asks: an `AbortSignal` on `TransitionContext` fired by `Out.Timeout`; `Out.Timeout` on
      the TIME-015 clock; a settle-before-deposit timeout. Each would let ADR 0013 use `Out.Timeout`

## M7b — Blueprints (Layer 3 — new capability)
- [ ] The `PetriEngineType` phantom brand gates the extended builder, so reaching for a
      blueprint is a typed, visible decision and never a silent incompatibility
- [ ] First wave: `race()`, `quorum(k, n)` (`limit` and `rateLimit` shipped in M7), [ADR 0014]:
  - [x] Maintainer decisions: the `init()` surface spread into `.parallel()` (B); first success wins
        (the name stays `race`); the next entry gets every declared arm from step records; a
        suspended arm is a miss, the block never suspends, a suspended loser is rewritten `canceled`.
        Defaults taken: lowest-index failure forwarded (`QuorumNotMetError` only when none failed);
        loser `canceled` with a `StepPreemptedError { kind: 'preempted', block }`; preempt on `met` and `short`; a loser in
        a retry delay finishes it; winners FIFO; `.parallel()` only
  - [x] W0 spike (libpetri 8.0.0 from npm, not linked): the drafted net is provable in budget (448
        queries, slowest 10.5 s, n=4 cancel off enumeration) but its resets make every collect a
        VER-004 split, 4–7× the baseline's classes. ADR amended to absorb the surplus into `settled`
        after the decision: n=4 back on enumeration in both segments, slowest untimed 600 ms, timed
        retry arm 3.4 s
  - [x] W0 contract (uncommitted): `BlockDecision`, `PreemptedToken`, `DecisionSite` and
        `CompiledWorkflow.decisions`; `StepPreemptedError` (`compiler/preempt.ts`, the signal's
        reason, an `Error`) and the canceled `StepRecord`'s `reason`; `StepCall.preempt`;
        `ArmPreemption` (`GadgetContext.preempt`, `NestedOptions.preempt`, `GadgetResult.decisions`);
        `RunScope.preempt(path, reason)` / `preemption` / `forgetSuspension`,
        `StepRunner.forgetSuspension`; `firstKGadget`, `QuorumNotMetError` (arrival statuses),
        `settledBound` (`compiler/blueprints/first-k.ts`); `race` / `quorum` / `Decision` /
        `BLOCK_DECISION` / `decisionOf`; `PetriRace` / `PetriQuorum` on `init()`;
        `BLUEPRINT_REFUSALS` (five, with `blueprint-reused`), `blockDecision` (arm matching by kind),
        `refuseMisplacedDecision`; `decisionStructureViolations`, `decisionTargets`,
        `LivenessTarget.kind` `decision`; `structuralHash` carries `decision.k` only when present;
        divergence rows 103–110 `planned (M7b)`. Every stub throws `not implemented (M7b W<n>)`; an
        unannotated workflow compiles and hashes as before
  - [x] W0 contract review: agent / tool arms matched by ref and options identity; the preempt
        reason an `Error` on the record; a suspended loser's resume labels dropped
        (`forgetSuspension`), a nested child's own snapshot a residual (row 107); `structuralHash`;
        arm keys optional in the next schema (row 103); precedence run abort > deadline > preempt;
        row 110 (a late loser waits for its quota); `collect-preempted-i` liveness unclaimed (vacuous);
        dead absorbs omitted at k = n and k = 1, `settled` and preemption omitted at n = 1;
        `blueprint-reused` (no existing refusal covered it)
  - [x] W1 built and adversarially verified over three rounds (2026-10-05). What the reviews changed:
        **one host-owned verdict** — the runner freezes each attempt's verdict when the step settles
        (first fired of run abort -> `own`, deadline -> `timedOut`, preemption -> `preempted`; a later
        signal never re-decides) and applies state, resume labels and scorers iff `own`; the leaf maps
        the verdict and reads no signal (source guard green, no new allowance). It closed a
        late-decision window a reviewer reproduced end to end (an async `scorers` fn committed a
        canceled loser's state and left an orphan label). Resume labels written at `suspend` and
        again at settle, as Mastra (`handlers/step.ts:491`), fixing a plain-path divergence that
        predated M7b. `live(short)` witnessed through genuine misses only (no `preempted` or `paused`
        branch before a decision); unclaimed liveness targets in the report and CLI; the deciding-arm
        suspension-coverage exemption in `structure.ts`. Proofs, libpetri 8.0.0 from npm, not linked:
        compiled race n=3 k=1..3 and n=4 k=1,2, every family, at most 908 ms a workflow, slowest
        query 619 ms. `npm test` without `tests/verify`: 85 files, 2,662 passed; `tests/verify` without
        the corpus, sequential: 17 files, 567 passed. Plan as it was:
        Lead keeps the contract: `src/compiler/types.ts`, `src/compiler/gadgets/types.ts`,
        `src/compiler/preempt.ts`, `src/compiler/compile.ts`, `src/compiler/index.ts`,
        `src/mastra/index.ts`, `src/verify/index.ts`, ADR 0014, this file
    - **W1a** (parallel; nothing in it reads another's work):
      - **B — leaf**: `src/compiler/gadgets/leaf.ts`. The `preempted` xor branch on every attempt
        (permit and quotas back), `StepCall.preempt = scope.preemption(block)`, not calling the
        runner once fired, awaiting and discarding otherwise, precedence at settle (run abort >
        deadline > preempt), the `canceled` record with `reason` = `signal.reason`. No branch when
        `ctx.preempt` is absent (every non-arm, and the arm of an n = 1 block). Tests:
        `tests/compiler/leaf-preempt.test.ts` (incl. an attempt behind an exhausted `limit` entering
        after the decision)
      - **C — scope, gate, runner, records**: `src/engine/scope.ts` (`preempt` / `preemption`, one
        controller per block per segment; `forgetSuspension` forwarding to the runner),
        `src/compiler/scope.ts` (its docs only), `src/mastra/attempt-gate.ts` (`preempt` as a third
        source; `expired()` covers it; reason of the first to fire), `src/mastra/runner.ts`
        (`forgetSuspension`: drop the step's resume labels), `src/mastra/step-result.ts` (`reason`
        written as the row's `error`, restored from `error.name === 'StepPreemptedError'`). Tests:
        `tests/engine/preempt-scope.test.ts`, `tests/mastra/runner-preempt.test.ts`, and the
        preempted-row cases in `tests/mastra/step-result-roundtrip.test.ts`
      - **D — surface and adapter**: `src/mastra/resources.ts` (`race`, `quorum`, `decisionOf`),
        `src/mastra/init.ts`, `src/mastra/adapt.ts` (`blockDecision` into the `parallel` case with
        arm matching by kind — `step` by identity, `agent` / `tool` by id, ref and options identity;
        `refuseMisplacedDecision` beside `refuseMisplacedConcurrency`, with `blueprint-reused`; the
        five refusals). Tests: `tests/mastra/race-surface.test.ts` (the brand gate as a
        `@ts-expect-error` under `npm run check`: a default-engine step is not a petri arm),
        `tests/mastra/adapt-decision.test.ts` ("agent and tool arms match by ref and options
        identity", and an equal-but-distinct options object refused `blueprint-arms`)
    - **W1b** (after B): **A — decision gadget**: `src/compiler/blueprints/first-k.ts`. The amended
      net, per-arm `preempted` places through `emitNested(…, { preempt })` (none at n = 1), dead
      absorb pairs omitted (k = n, k = 1), `settled` omitted at n = 1, admission under
      `concurrency`, `met` / `short` building one `StepPreemptedError` for `scope.preempt(path,
      reason)`, the join's output from records, the lowest-index failure or `QuorumNotMetError`
      with arrival statuses, the suspended loser's record rewrite plus `scope.forgetSuspension`,
      claims (`okSeen`/`miss` ≤ n, `settled` ≤ `settledBound` when emitted), the `won`/`short`
      exclusion and one `DecisionSite`. Tests: `tests/compiler/quorum.test.ts` (shape, names, an
      early-`preempted` firing, counts 0 omitting their arcs, dead absorbs omitted, n = 1, the hash
      moving with `k`)
    - **W1c** (after A, against its `DecisionSite`):
      - **E — verify**: `src/verify/decision.ts` (the seven rules; mutants `inhibitor(won)` on
        `short`, a success collect producing `miss`, a reset on `okSeen`, a dead absorb pair
        emitted), `src/verify/claims.ts` (`decisionTargets` — `met` and `short` only — appended by
        `livenessTargets`), `src/verify/properties.ts` (`decision structure` beside `pool
        structure`). Tests: `tests/verify/decision.test.ts`
      - **F — docs**: `docs/divergences.md` rows 103–110 checked against what W1 built; README's
        Layer 3 list
  - [x] W2 integration (2026-10-05), three agents on disjoint files, each adversarially reviewed with
        mutants on `src/` (restored), no `src/` defect found:
        - `tests/engine/race.test.ts` (+11): all fail -> lowest index; `QuorumNotMetError` with
          `suspended` / `preempted` distinct and labels forgotten; cancel mid-race (arms keep their own
          `success` on both engines, only the run is `canceled` — the plan's "arms canceled" was
          wrong); a retrying loser finishes its delay and runs once; a loser ignoring its signal is
          awaited and discarded; a loser behind an exhausted `limit` waits for the quota, then leaves
          without running (row 110); `concurrency: 2` admits FIFO and the queued never run; winners by
          arrival, not index; `.then(next)` with arm keys optional and required
        - `tests/engine/race-next.test.ts` (new, 4): `validateInputs` against a default-engine oracle
          (optional keys run, required fail naming the losers); quorum then next; a forced
          `cloneWorkflow` runs on `DefaultExecutionEngine` as a plain `.parallel()`, the mark carried
          in metadata and ignored
        - `tests/verify/race-blueprints.test.ts` (new, 26): n=3 k=1..3, n=4 k=1,2 × run budget 1 ×
          `limit(1)` in two arms, untimed; timed (arm retrying 2 × 5 ms) under budget + limit per
          (n, k) and alone at (3, 1). Every family in all 8 default segments (pinned), the decision's
          claims by name, the limit's takers pinned. 61 s alone, slowest query 7.7 s (`deadlockFree
          @closed`, smt). The full 40-shape cross product was measured once: all held, 161 s, slowest
          7.6 s — the 15 other timed crossings were dropped for cost. libpetri 8.0.0 from npm, not
          linked
  - [x] W3: ADR 0014 accepted with Evidence; rows 103–110 `fixed (M7b)`; CI green on `3ebb1c8`
        (all jobs)
- [ ] Second wave, first: `pipeline()` [ADR 0015]:
  - [x] Maintainer decisions (2026-10-05): Layer 3 reason (A, stages in the parent's run); retries per stage
        inheriting the parent's `retryConfig`; item scope at twin parity; a suspended pipeline
        refused on resume. Defaults taken: c_j = 1, W = Σc_j (no window pool); unordered
        later-stage admission; rendezvous hand-off; nested-workflow stages refused; cancel drops
        every unsettled item (a hole)
  - [ ] W0 spike (libpetri 8.0.0 from npm, `scripts/link-libpetri.sh --check` "not linked"): the
        drafted net with a leaf wrapper, c ∈ {(1,1), (1,1,1), (2,1), (1,2,1), (2,2)} × ± run budget 1
        × `limit(1)` on the widest stage, plus `limit(1)` shared by stages 0 and 2, plus one stage
        retrying 2 × 5 ms (SMT). Report classes closed / cancel, route, slowest query, and the same
        for a foreach of Σc_j lanes; the overlap `Violated` with its trace. Any query over 30 s:
        redesign (relay per boundary, or fewer drops) before W1, recorded as an ADR amendment
        table. Also pin: spread inference of `pipeline(...)` into `.foreach` and `Chained<S>` under
        `npm run check`; whether the twin merges state for a failed item; whether the child
        validates the body's output schema at its end
  - [ ] W0 contract (lead): `ForeachPipeline` on the foreach description, `PipelineSite` and
        `CompiledWorkflow.pipelines` / `GadgetResult.pipelines`, `NestedOptions.item`,
        `RunScope.itemRecords`, `ResumeRefusal.reason 'pipeline'`, `FOREACH_PIPELINE` / `Pipeline` /
        `pipelineOf`, `PetriPipeline` on `init()`, the three new `BLUEPRINT_REFUSALS`,
        `pipelineStructureViolations`, `pipelineLaneAttempts`; `structuralHash` carries the
        pipeline only when present; rows 111–118 `planned (M7b)`. Stubs throw
        `not implemented (M7b W<n>)`; an unannotated workflow compiles and hashes as before.
        Lead keeps: `src/compiler/types.ts`, `src/compiler/gadgets/types.ts`,
        `src/compiler/compile.ts`, `src/compiler/index.ts`, `src/mastra/index.ts`,
        `src/verify/index.ts`, ADR 0015, this file
  - [ ] W1a (parallel; nothing in it reads another's work):
    - **A — frame and gadget**: `src/compiler/gadgets/foreach-frame.ts` (extracted first, gated on
      an unchanged `structuralHash`, a name-and-arc snapshot and `foreach.test.ts` class counts),
      `src/compiler/gadgets/foreach.ts` (delegation only), `src/compiler/blueprints/pipeline.ts`
      (the net, flattened lane paths `[i, L]`, the `PipelineSite`). Tests:
      `tests/compiler/pipeline.test.ts`
    - **B — item scope**: `src/engine/scope.ts` (`itemRecords`, forget), `src/compiler/gadgets/leaf.ts`
      (`item` option: the view overlay, the record sink), `src/mastra/runner.ts` (`#resolveStep`
      for pipeline lanes, stage calls without `foreachIdx` or `nestedRunId`, stage-0 body-schema
      validation, per-item state snapshot and merge). Tests: `tests/engine/item-scope.test.ts`,
      `tests/mastra/runner-pipeline.test.ts`; foreach and race suites unchanged
    - **C — surface, adapter, resume refusal**: `src/mastra/pipeline.ts` (new),
      `src/mastra/resources.ts`, `src/mastra/init.ts`, `src/mastra/adapt.ts` (`case 'foreach'`,
      `matchMinted` factored out of `blockDecision`, `refuseMisplacedBlueprints`, `innerSteps`),
      `src/compiler/resume.ts` and `src/mastra/engine.ts` (the `pipeline` refusal). Tests:
      `tests/mastra/pipeline-surface.test.ts`, `tests/mastra/adapt-pipeline.test.ts`
  - [ ] W1b (after A): **D — verify**: `src/verify/pipeline.ts` (seven rules, a mutant each),
        `src/verify/structure.ts` (`pipelineLaneAttempts` exemption), `src/verify/properties.ts`
        ("pipeline structure"), `src/verify/claims.ts` (bounds, exclusions, the overlap query).
        Tests: `tests/verify/pipeline.test.ts`
  - [ ] W1c: **E — docs**: rows 111–118 checked against what W1 built; README's Layer 3 list
  - [ ] W2 integration, agents on disjoint files, each adversarially reviewed with mutants on `src/`
        (restored): `tests/engine/pipeline.test.ts` (overlap under ManualClock, failure drain, bail,
        cancel holes, suspend refusal, item scope, `limit(1)` peak, run budget 1);
        `tests/engine/pipeline-next.test.ts` (default-engine oracle, forced `cloneWorkflow`, twin
        differential on success / failure / cancel); `tests/verify/pipeline-blueprints.test.ts`
        (the W0 matrix, every family in every default segment, slowest query recorded, libpetri
        8.0.0 from npm, not linked)
  - [ ] W3: ADR 0015 accepted with Evidence; rows 111–118 `fixed (M7b)`; CI green
- [ ] Second wave, after `pipeline()`: `supersede()`, `compensate()`, `circuitBreaker()`,
      `queue(depth)`, `correlate(key)`
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
- [x] U9 — **libpetri TypeScript 7.0.0** (released 2026-09-25, tag `typescript/v7.0.0`, reported by
      the temporal-libpetri session), taken after M5 as an upgrade of its own. Breaking for us:
      nothing (`NodeCategory` gains `'terminal'`; we switch over neither it nor
      `terminationReason`). It carries U7: `dist` allocates `needsSingleWordIndex` as an
      `Int32Array`, checked in the file rather than trusted from the version, so `MAX_NET_PLACES`
      is removed; a 4313-place chain runs to success and stops at a cancel on step 4200
      (tests/compiler/leaf.test.ts; not run against 6.1.0, where U7's 4098-place repro spun).
      **Terminal places ([EXEC-042]) not adopted**: a terminal ends the run the moment it is marked
      and abandons in-flight actions, where the kernel's `drain()` lets them finish so the run rests
      and `classify` sees any residue; and the verifier excuses every marking a terminal ends in,
      which would blunt `exactlyOneTerminal` and residue detection — the properties that catch a
      token left beside a terminal. The drain-on-terminal watcher stays. `executionScope` pinning is
      moot while no compiled net uses `freshName`

- [x] U10 — a caller-owned `StateSpaceCache` (shipped in 8.0.0; adopted with U13) for the [VER-017] enumeration route, raised from M6's
      cost finding (enumeration tried before the linear bound, 3–5 s a query on `parallel-wide`):
      the state-class graph built once per net and marking, a truncation remembered, verdicts
      unchanged. In progress upstream in all four languages (temporal-terminal-places-refactor,
      2026-09-25), not released. When it ships, pass one cache per net and marking and retire the
      quick phase in `src/verify/workflow.ts`; route order (VER-015 after enumeration) stays

- [x] U11 — libpetri-87's unreleased verification changes (2026-09-28). Only item 4 applies to
      us: the result for an initially violating marking, which is every first-step liveness witness
      in the M6 gate. Answered 2026-09-28: the shape is kept and now documented in all four
      languages — `violated`, `counterexampleConfirmed: true` (even with replay off), trace `[M0]`,
      no firings. Pinned here in `tests/verify/claims.test.ts` ("a witness of zero firings") and
      upstream in `typescript/tests/verification/initial-violation-trace.test.ts`. Items 1–3 and 5
      do not apply: reaping touches only `deadline`/`window`, and our nets use `delayed` and
      immediate only; libpetri will say first if that widens

- [x] U12 — libpetri-87 round 2 (2026-09-29, uncommitted and unreleased). Item 1, the VER-004
      in-flight split: a transition is split into start → `inflight:t` → `complete:t` when another
      transition tests one of its OUTPUT places by inhibitor, reset, `all()` or `atLeast()`
      (`exactly` does not count). In our nets that is `t.cancel.arrive`, every foreach lane's step
      attempts, the foreach settles and unpark, parallel/branch `collect-err`/`collect-susp`, and
      the loop's `budget`/`running` writers. Answered 2026-09-29: the barrier claims are *not*
      weakened. They are now checked at every in-flight marking as well, so a claim that stays
      proven holds at strictly more executor states. `inflight:t` is not a supported property
      target; do not build on it. `assumeAtomicFiring(true)` restores the old encoding byte for
      byte. Item 3 will key sinks, property places and the initial marking by name; we mint each
      name once, so there should be no change. Item 2: no effect.
      **Run 2026-09-29 on the linked snapshot** (libpetri f04d128+dirty, dist=ba757fcd1216 by our
      script, b16e20d6f357eb80 by libpetri's method; not a release figure; unlinked afterwards):
      the M6 claims, Mastra-verify, CLI and surface tests all pass (54, mutants included). The
      corpus fast lane is 104 passed, 28 skipped; 67,434 claims hold and no claim count moved.
      **One real flip:** foreach `closed/deadlockFree` at 3 and 5 lanes is *violated* (proven with
      `assumeAtomicFiring(true)`). Confirmed trace: lane 1's `start` holds the cursor in flight;
      lane 0's item fails and its settle resets the cursor (`queue.kill()`), which is empty; the
      start then completes and re-deposits the cursor, so the run ends as
      `{cursor: 1, wf.failed: 1}`. The kill was reasoned about as if a start were atomic. At runtime
      this would leave residue beside a terminal. The window is narrow and untested; no executor
      repro yet. Split vs atomic cost (closed segment): c1 deadlockFree 86 s vs 5.7 s; c5
      neverCanceled 90 s vs 4 s; the rest 1.5–2x; no unknowns
- [x] **Foreach cursor revived by an in-flight start** (found by U12; fixed with U13): every lane
      `start` is also inhibited by `faults` / `exits` / `suspensions`; the `fail` / `exit` /
      `suspend` finishers reset the cursor; `unpark-killed` joins carried suspensions beside a
      recorded one. The TypeScript executor did not show it in 2,400 runs (2/3/5 lanes, the failure
      synchronous or after a tick); libpetri's model covers executors that interleave more. The
      cursor/record exclusion claims are withdrawn; a mutant shows the start inhibitors are what keep
      `faults` <= lanes

- [x] U13 — **libpetri 8.0.0** (released 2026-09-30), taken after M6. Breaking for us: the
      in-flight split ([VER-004]); `And(P, P)` and a second input arc on one place refused at build
      (two budget tests pin the refusal). Not applicable: deadline reaping, ν mint declarations,
      `Bounded(k)` premises, timeout forwards. The old foreach became unprovable on the split net
      (2 lanes `unknown` at 900 s); rebuilt rather than given a bigger budget — see the entry below.
      `verify` attaches an `assumingAtomic` answer to an `unknown` proof, never counting it; the gate
      admits no exception. The quick phase is retired for 8.0.0's `StateSpaceCache` (closes U10);
      the slow lanes and the CI `proofs` matrix are gone; every proof budget in the suite is 30 s.
      **Figures, libpetri 8.0.0 from npm (not linked), z3 on PATH, 10 cores:** corpus gate — 132
      cases (66 workflows x 2 budgets) + 8 nested, **124,388 claims, every one holding** under
      in-flight firing, no exception admitted; routes enumeration 95,080, structural 28,440, smt 868;
      769 s for the whole corpus, slowest `parallel-wide` k=1 102 s, `foreach-c5` 72 s, `foreach-c3`
      1.1 s (63 min before the redesign). `npm run check` exit 0; `npm run build` exit 0; `npm test`
      "Test Files 64 passed (64)", "Tests 2514 passed (2514)" — nothing skipped — in 832 s (19 min on
      7.0.0 with the slow lanes skipped)
- [x] **Foreach redesigned for the split** (2026-10-03, from libpetri-66's suggestions; the user's
      rule: a proof that does not close in 30 s means redesign). Results and recorded outcomes ride
      the frame as data; recorded kinds are complement pairs (`no-fault`/`fault`, `no-exit`/`exit`,
      `no-susp`/`susp`) taken one token at a time; the queue is `queue.open`/`queue.closed`, taken
      by a non-success settle (waiting for an in-flight start, so no revival); every place 1-bounded,
      no settle split, `unpark`, `join-empty`, `canceled-empty` and `thresholdOnlyViolations` gone.
      Fail-fast proven again: `mutualExclusion(queue.open, fault | exit)` in every segment. Measured
      on libpetri 8.0.0 (npm), closed + cancel + resume segments, completion set, 30 s budget: 1 lane
      slowest query 6 ms, 2 lanes 29 ms, 3 lanes 0.4 s, 5 lanes 7.9 s — all proven (was `unknown` at
      900 s from 2 lanes). Gadget suites: verify/foreach 38 tests in 75 s, verify/foreach-resume 15 in
      5 s. Behaviour unchanged: every engine and Mastra-level test green; the window between an
      outcome and its settle is closed by priority at run time, as before by inhibitors
- [x] Widened to 20 / 30 / 100 / 150 ms (every gap at least 30 ms, the designed order kept, no retry).
      Was: `tests/mastra/events.test.ts` "concurrency 3 … progress per item": the differential's oracle
      (Mastra's own engine) settled items out of the delays' designed order once under load ~20+
      (2026-10-03), ours in it; 3/3 green at normal load. The 3 ms / 10 ms / 13 ms / 25 ms spacing
      is too tight for a loaded machine — widen it rather than retry

**Not pursued, deliberately:**

- [ ] U2 — admission hooks (`beforeCycle` / `afterAdmission`). Temporal needs them; this engine
      does not. Kept separate from U1 precisely so the clock could land without inheriting an
      [EXEC-001]/[EXEC-003] parity review. Not this repo's ask to make

**Open upstream question, reported not pressed:** action timeouts still elapse on a real
`setTimeout` under an injected clock, and `Out.Timeout` is exactly what step timeouts compile
to — so the one timing construct that survives a restore cleanly is the one virtual time does
not reach.
