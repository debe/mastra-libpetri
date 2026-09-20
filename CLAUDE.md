# CLAUDE.md

Guidance for Claude Code when working in the mastra-libpetri repository.

## Project overview

mastra-libpetri is an alternative execution engine for Mastra workflows, registered through
Mastra's own `createWorkflow({ executionEngine })` extension point. It models a workflow as a
Coloured Time Petri Net built on [libpetri](https://github.com/debe/libpetri), so the scheduling
model is available to analysis as well as to execution. Mastra keeps step execution, storage,
suspend/resume persistence, observability and the authoring API. There is no Mastra fork:
`.mastra/` is a gitignored clone at a pinned commit, and `patches/mastra/` holds only
behaviour-neutral upstream PRs. With nothing registered, Mastra runs its own engine exactly as
before.

The architecture and the layer model live in the root [`README.md`](README.md). It is the single
source of truth; read it before structural changes.

## Hard rules

- Every transition carries a real `Out` spec. Never `null`, never `skipOutputValidation`.
- One net serves execution and verification. No separate "verification net".
- The net decides what runs. The engine extends `ExecutionEngine` and owns `execute()` — never
  `DefaultExecutionEngine` with overridden hooks, which leaves Mastra's `for` loop as the
  scheduler. No host-side dispatch queue or permit gating in the kernel.
- No Petri vocabulary in any Mastra-facing surface. Options stay in Mastra's words
  (`concurrency`, `retries`, `retryConfig`, `timeout`). The test: *a Layer 1 or 2 workflow
  carrying this config must stay meaningful if `DefaultExecutionEngine` runs it.* Layer 3 is
  exempt by construction and says so through the engine-type brand.
- Cancellation is structural — an inhibitor arc on `_cancel` plus reset arcs. Stop the executor
  with `close()`, never `run(timeoutMs)`, whose default policy keeps firing after it rejects.
- Every Mastra behaviour not reproduced is recorded in `docs/divergences.md`. No silent skips.
- Say proven, or say untested. A claim names the property, the initial marking, the environment
  mode and the route. Never `expect(isViolated()).toBe(false)` — that passes on `Unknown`.
- A number measured against a linked libpetri tree is not comparable with one measured against a
  release. Record which tree produced every figure, and unlink before measuring for reporting.
- No attribution trailers in commit messages.

## Build and test commands

### TypeScript (`typescript/`)

```bash
cd typescript
npm install
npm run build          # tsup, multi-entry ESM
npm run check          # tsc --noEmit for src and tests
npm test               # vitest
npm test -- compiler   # tests matching "compiler"
```

House style mirrors `libpetri/typescript`: ESM-only, strict + `noUncheckedIndexedAccess`, tests
under `tests/` (not beside sources), vitest, tsup, no ESLint/Prettier. Doc comments cite libpetri
requirement IDs (`IO-015`, `EXEC-003`, `MOD-031`, `TIME-015`, …).

### libpetri

Linked from a sibling checkout, not installed from the registry:
`"libpetri": "file:../../libpetri/typescript"`. The engine calls surface that is committed but
unreleased — **TIME-015** (injectable clock), the **MOD-031** place-alias fix, **NU-011**
(resume-safe minting) — plus **CORE-073**/**ENV-014** snapshot, which is implemented but
uncommitted. npm publishes 6.0.0. The floor becomes `^6.1.0` the day it publishes.

```bash
scripts/link-libpetri.sh --check   # verify the link and the pinned revision
scripts/link-libpetri.sh --unlink  # restore the registry copy before measuring
```

`scripts/libpetri-pin` records the sibling revision. `src/internal/libpetri-surface.ts` asserts
the surface at entry and `tests/upstream/libpetri-surface-gate.test.ts` gates the build, because
a missing clock does not throw — the executor silently reads the machine clock, and a run that
was supposed to be deterministic simply is not.

### Verification

Requires a `z3` binary on `PATH`, or `LIBPETRI_Z3` pointing at one.
`tests/z3-gate.test.ts` fails the build when no solver resolves, so proofs cannot quietly become
skips.

## Source layout (`typescript/src/`)

- `index.ts` — package root.
- `compiler/` — `StepFlowEntry[]` -> `CompiledWorkflow` (one `PetriNet`, a cached
  `PrecompiledNet`, a `NetMap` relating transitions to entries and places to `(entry, port)`).
  Takes a structural description; no Mastra runtime dependency.
- `engine/` — `PetriExecutionEngine` and the transition actions that call back into step
  execution.
- `codec/` — marking snapshot <-> Mastra's `WorkflowRunState`.
- `mastra/` — Mastra's interfaces mirrored **structurally**, so `@mastra/core` is a type-only
  devDependency and a tsup external and the package never imports Mastra at runtime.
- `verify/` — property derivation and the CLI.
- `conformance/` — the classifier and the differential harness.
- `internal/` — the libpetri surface assertion and shared helpers.

## Working notes

Decisions go in `docs/adr/`. Open work goes in `tasks/todo.md`. Divergences from Mastra go in
`docs/divergences.md`.

Sibling integrations (`n8n-libpetri`, `temporal-libpetri`, `adk-libpetri`) solve the same
problems against different hosts. When one reports a libpetri bug, treat it as a question about
this codebase until proven otherwise — that habit found a three-language correctness bug during
planning. Cross-cutting libpetri gaps are raised upstream rather than worked around locally.
