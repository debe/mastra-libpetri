# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
