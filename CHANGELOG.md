# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **The four composite combinators compile.** `.parallel`, `.branch`, `.dowhile`/`.dountil` and
  `.foreach` each became a gadget against a shared contract. Two shapes are worth naming because
  the obvious version of each is wrong. A parallel arm deposits an arrival marker whether it
  succeeded or failed, so an early failure cannot strand siblings that are still in flight; a
  remembered `errSeen` marker plus an inhibitor decides the join's outcome structurally rather
  than inside an action the verifier cannot see. And `.branch` is compiled as **inclusive** —
  Mastra evaluates every condition concurrently and runs every truthy arm
  (`handlers/control-flow.ts:396,540`) — so it is *n* independent per-arm `xor(run, skip)` gates,
  not an exclusive choice. Measured: `deadlockFree` and `terminatesAtSink` proven across 30+
  shapes, and mutation-tested for non-vacuity — removing the join inhibitor, the `errSeen` reset
  or the arrival deposit each flips the verdict to `violated`.

### Fixed

- **A step id of `__proto__` silently discarded that arm's output.** The parallel join assembled
  its result with `aggregate[id] = value`, and `obj['__proto__'] = v` is a setter call that
  replaces the object's prototype rather than defining a key. Measured before the fix: the arm's
  output vanished from `Object.keys`, `hasOwnProperty('__proto__')` was false, and its fields
  reappeared as inherited properties on every downstream read. Arm ids are arbitrary
  user-supplied Mastra step ids, so this was reachable input. Assembling through
  `Object.fromEntries` defines it as an ordinary own key. No proof could have caught it — it
  lives entirely inside an action, in the half the model does not see.
- **`classify()` hid stranded tokens behind a terminal.** It checked `wf.failed`, then `wf.done`,
  and scanned for strays only when neither was marked — so reaching a terminal *and* leaking were
  never reported together, which is the combination that matters. Measured: six stranded tokens
  returned as `{status: 'success'}`, with the test asserting that shape passing unchanged. The
  residue scan now runs first and always, and `residue` appears only when non-empty, so every
  existing `toEqual({status, output})` assertion became a leak detector without opting in.

- **The orchestrator core: a compiler and a kernel.** `compile()` turns a workflow description
  into one Coloured Time Petri Net and `runWorkflow()` runs it to quiescence. The chain is the
  arcs, not a loop in the engine: entry *i* owns an input place and its transition produces into
  entry *i+1*'s place, or into `wf.done` for the last. Every run transition declares
  `xor(success, failure)`, so a failing step deposits a token on a declared branch rather than
  unwinding — and a runner that throws becomes a failed step rather than a lost token, which
  matters because the executor consumes inputs before the action runs and does not restore them
  ([EXEC-031]). `.sleep` compiles to `delayed` and `.sleepUntil` to `exact`; neither emits a
  hard bound, because a restore starts every clock fresh ([CORE-073]) and an upper bound would
  receive a fresh full budget. Measured: `deadlockFree` and `terminatesAtSink` both **proven**
  via the SMT route on a four-entry chain, and a 60-second `.sleep` elapsing in virtual time
  with two executors in one process on independent clocks ([TIME-015]).
- **Repository scaffold.** TypeScript package, CI, the decision records, the divergence
  register, the requirement mapping and the milestone tracker. The toolchain is green end to
  end (`npm run check && npm test && npm run build`), with two gates that fail loudly rather
  than degrading quietly: `tests/z3-gate.test.ts`, because a missing solver turns every proof
  into `unknown` while still reporting green, and `tests/upstream/libpetri-surface-gate.test.ts`,
  because a missing injectable clock does not throw — the executor silently reads the machine
  clock and a run that was supposed to be deterministic simply is not.
- **libpetri is linked from a sibling checkout**, not installed from the registry
  (`"libpetri": "file:../../libpetri/typescript"`). The engine calls surface that is committed
  but unreleased — [TIME-015] injectable clock, the [MOD-031] place-alias fix, [NU-011]
  resume-safe minting — plus [CORE-073]/[ENV-014] marking snapshot, which is implemented but
  uncommitted. npm publishes 6.0.0. `scripts/libpetri-pin` records the revision measurements
  came from, and the floor becomes `^6.1.0` the day 6.1.0 publishes.
