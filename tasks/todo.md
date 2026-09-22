# mastra-libpetri — milestones

## M0 — Repository
- [x] Scaffold from n8n-libpetri conventions, TypeScript package skeleton, CI
- [x] `libpetri` linked as `file:../../libpetri/typescript`, because the engine calls surface
      that is committed but unreleased ([TIME-015] injectable clock, the [MOD-031] place-alias
      fix, [NU-011] resume-safe minting) plus [CORE-073]/[ENV-014] snapshot, which is
      implemented but uncommitted. npm publishes 6.0.0; the floor becomes `^6.1.0` the day it
      publishes. `scripts/libpetri-pin` records the sibling revision the numbers came from
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
- [ ] **Track A, contract completion — the next phase, and it comes before M2.** Four changes
      each touch a type every gadget uses, so none can be bolted on after the engine exists:
      (1) a structural cancellation path — a `_cancel` place in `GadgetContext` that every
      gadget's starts are inhibited on, plus a `canceled` outcome at Mastra's four check points
      (row 28); (2) `FailureToken` carries `path` and `nonRetryable`, which fixes duplicate-id
      ranking and gives the codec an execution path for every failure (rows 33, 36);
      (3) `foreachIndex` on `StepCall`, and a view path separate from the naming path, so the
      Mastra runner can build Mastra's per-item context (row 32); (4) what the step-result
      store holds for the codec — Mastra's `payload` and `metadata.iterationCount` too, or an
      opaque host record beside the outcome (rows 27, 37)
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
      as one token per named place ([IO-016]) — asked upstream whether that multiplicity is
      intended and stable (U8). No property establishes termination (see above)
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
- [ ] Track B: the named inert assertions from the four adversarial verdicts, chiefly
      `deposit-and-out`'s four `fastPathEligible` checks and `reset-clock`'s unreachable
      `transition-clock-restarted` half. A spike that passes for the wrong reason is worse than
      no spike, because it reads as coverage
- [ ] Track C: unpatched baseline run, conformance matrix scaffolding, the two upstream PRs
      drafted in `patches/mastra/` (`--repo` clone required)

## M2 — Engine (the kernel)
- [ ] `PetriExecutionEngine extends ExecutionEngine` with its own `execute()`, registered via
      `createWorkflow({ executionEngine })`; `init()` factory with the `PetriEngineType` phantom
      brand; `MarkingCodec` <-> `WorkflowRunState`; cancellation via `close()` + `_cancel`
      inhibitor, never `run(timeoutMs)`; `executionContextProvider` supplies `abortSignal`
- [ ] Data equivalence + happens-before on the fixture set at concurrency k = 1; divergence
      register complete for everything found

## M3 — Concurrency + differential report
- [ ] k > 1 under the structural budget; differ runs both engines in one process on one fake
      host; every ordering difference attributed to a divergence row or it is a finding
- [ ] Differential runs under injected clocks, one per executor. Correlate events on our own
      run handle, never `executionId()`, which collides when two executors start at the same
      virtual time. Copy libpetri's sharpest clock test: a virtual clock that only resolves on
      abort, so anything the net achieves it achieves through the executor's own wake sources
- [ ] Record the hole: action timeouts still use a real `setTimeout`, so step timeouts are not
      virtualized. Small values in tests; revisit if upstream closes it

## M4 — Suspend, resume, durability
- [ ] `_suspend` place + terminal-marking classification (success / failed / suspended /
      canceled / bailed / tripwire / stranded); codec round-trips `activePaths`,
      `activeStepsPath`, `suspendedPaths`, `resumeLabels` and the positional `executionPath`;
      capture via `executor.snapshot()` asserting `actionInFlight === false`, restore via
      `Marking.fromSnapshot()`
- [ ] Environment-place hygiene: `drain()` and injection driven from **inside** `Clock.sleep`,
      where the executor has already assigned its wake-up resolver — a `drain()` from outside
      the loop can be lost. Injection uses `injectNoAwait()`, never the awaitable form, which
      would suspend the only thing that can resolve it. Seeds use `seedToken(clock, value)`
- [ ] Restore semantics: elapsed time is not preserved ([CORE-073]), so `.sleep(ms)` re-waits in
      full. Sound because restores are rare and `Delayed` fails safe; no hard timing emitted on
      any path that can cross a restore. Divergence row + the starvation condition recorded

## M5 — Streaming and watch
- [ ] `EventStore` adapter maps net events onto Mastra's step-event vocabulary and publishes to
      `workflow.events.v2.${runId}`, so existing `.watch()` / `.stream()` observers keep working
      unchanged; `DebugAwareEventStore` tee for the libpetri debug UI

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

**Reported this phase, open upstream:**

- [ ] U7 — `PrecompiledNetExecutor` spins synchronously on a 4098-place chain that
      `BitmapNetExecutor` runs in ~115ms; no timeout can interrupt it. Repro sent to the libpetri
      session. Our stopgap is `MAX_NET_PLACES`; lift it when fixed
- [ ] U8 — question, not pressed: is depositing several tokens into one place an `and` names
      once intended and stable? The loop gadget's `start` depends on it

**Not pursued, deliberately:**

- [ ] U2 — admission hooks (`beforeCycle` / `afterAdmission`). Temporal needs them; this engine
      does not. Kept separate from U1 precisely so the clock could land without inheriting an
      [EXEC-001]/[EXEC-003] parity review. Not this repo's ask to make

**Open upstream question, reported not pressed:** action timeouts still elapse on a real
`setTimeout` under an injected clock, and `Out.Timeout` is exactly what step timeouts compile
to — so the one timing construct that survives a restore cleanly is the one virtual time does
not reach.
