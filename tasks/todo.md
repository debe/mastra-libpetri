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
- [ ] Track A: `src/compiler` — `StepFlowEntry[]` -> one net. Per-step gadget as a `SubnetDef`
      instantiated at the entry's positional path; join gadget; inclusive-branch routing with
      the split threshold; loop gadget with a bounded iteration place; foreach with permits and
      ν-minting; sleep/sleepUntil timing; mapping/agent/tool entries; one naming vocabulary with
      a global-uniqueness assertion; `NetMap` (transition<->entry, place<->(entry,port));
      structural hash as the compile-cache key; dot export
- [ ] Track A: assert the instantiate -> fuse -> re-instantiate round-trip. Depth is
      unconstrained now that [MOD-031] is fixed, but it is the shape nested workflows take and
      a regression there is silent token loss rather than a build error
- [ ] Track B: `tests/spikes` — pin every derived fact about libpetri against the installed
      version: same-pass deposit invisibility, [EXEC-002] ready order and the all-immediate
      fast path vs general path seam, reset-arc clock restart including the *intermediate*
      disablement case of [TIME-012], `Out` validation exactness, compose name collisions,
      ν tie-break
- [ ] Track C: `scripts/bootstrap-mastra.sh` at a pinned commit, unpatched baseline run,
      conformance matrix scaffolding, the two upstream PRs drafted in `patches/mastra/`

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

**Implemented, uncommitted:**

- [ ] U5 — [CORE-073] marking snapshot/restore (now MUST) and [ENV-014] with the quiescence
      framing. TS surface is `marking.snapshot()` / `Marking.fromSnapshot()` /
      `executor.snapshot(): { marking, actionInFlight }`. M4 tracks it landing

**Not pursued, deliberately:**

- [ ] U2 — admission hooks (`beforeCycle` / `afterAdmission`). Temporal needs them; this engine
      does not. Kept separate from U1 precisely so the clock could land without inheriting an
      [EXEC-001]/[EXEC-003] parity review. Not this repo's ask to make

**Open upstream question, reported not pressed:** action timeouts still elapse on a real
`setTimeout` under an injected clock, and `Out.Timeout` is exactly what step timeouts compile
to — so the one timing construct that survives a restore cleanly is the one virtual time does
not reach.
