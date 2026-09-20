# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
