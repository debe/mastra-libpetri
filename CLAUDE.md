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
- No Petri vocabulary in any Mastra-facing surface. Options stay in Mastra's words. Layer 1 is
  what Mastra already enforces (`retries`, `retryConfig`, `.foreach` `concurrency`); Layer 2
  annotations ride in Mastra's own `metadata`, which its engine ignores (`concurrency` on a block,
  `checkpoint`). The test: *a Layer 1 or 2 workflow carrying this config must stay meaningful if
  `DefaultExecutionEngine` runs it.* Anything that changes an outcome there — a timeout — is
  Layer 3, exempt by construction and saying so through the engine-type brand.
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

Installed from the registry: `"libpetri": "^8.0.0"`. 6.1.0 was the first release carrying
everything the engine calls — **TIME-015** (injectable clock), the **MOD-031** place-alias fix,
**NU-011** (resume-safe minting) and **CORE-073**/**ENV-014** snapshot; 7.0.0 adds the
`PrecompiledNet` word-index fix, so nets past 4096 places run. 8.0.0 verifies a firing whose
outputs another transition tests as a start and a completion (**VER-004**), as the executor runs
it: never opt out with `assumeAtomicFiring` to make a proof pass. A proof that does not close in
30 s is a net to redesign, not a budget to raise — the foreach was rebuilt for exactly that
([ADR 0009], amended). Figures measured against a release are reportable; figures through M5 are
6.1.0's, M6's 7.0.0's, from the 8.0.0 upgrade on 8.0.0's.

The sibling checkout is linked only on purpose, to try a fix that is not released yet:

```bash
scripts/link-libpetri.sh               # link typescript/node_modules/libpetri at ../libpetri
scripts/link-libpetri.sh --check       # verify the link; print the provenance line
scripts/link-libpetri.sh --provenance  # the one line to quote beside any measurement
scripts/link-libpetri.sh --strict      # as --check, but fail if the sibling tree is dirty
scripts/link-libpetri.sh --unlink      # back to the registry copy
```

**A figure measured while linked is not comparable with one from a release.** The sibling is a
peer session's working tree and is often mid-change, and `dist/` — what the package actually
imports — is gitignored, so neither a matching `HEAD` nor a clean `git status` proves what ran.
That was a *silent* mis-attribution once, which is why identity is content-addressed
(`libpetri <rev>[+dirty] dist=<hash>`) and `--strict` also refuses a `dist/` older than any
source file. Quote the provenance line next to any figure measured linked, and never commit the
`file:` specifier: `npm install` records it in the lockfile and keeps restoring the link.

What is ahead of the release is tracked in `tasks/todo.md` Track U. Ask the libpetri sessions
(`ListAgents`) rather than reconstructing it from git.

`scripts/libpetri-pin` records the sibling revision last linked against. `src/internal/libpetri-surface.ts` asserts
the surface at entry and `tests/upstream/libpetri-surface-gate.test.ts` gates the build, because
a missing clock does not throw — the executor silently reads the machine clock, and a run that
was supposed to be deterministic simply is not.

### Mastra

Never a fork and never a checked-in copy: `scripts/bootstrap-mastra.sh` puts a pinned tree under
the gitignored `.mastra/`, and `scripts/mastra-pin` records what was used.

```bash
scripts/bootstrap-mastra.sh          # --dist: the published package (the default)
scripts/bootstrap-mastra.sh --repo   # the monorepo clone; only conformance needs it
scripts/bootstrap-mastra.sh --check  # what is present, and does it match the pin
```

`--dist` fetches `@mastra/core`, verifies it against a pinned sha512, and recovers the workflow
engine's **original TypeScript from the sourcemaps the package publishes** — 53 files under
`.mastra/src-extracted/src/workflows/`, including `default.ts`, `execution-engine.ts`,
`workflow.ts` and `handlers/`. Read those, not the `.d.ts` files and not this repo's prose, when
a question about Mastra's semantics comes up: a `.d.ts` gives a shape, and almost every
divergence in `docs/divergences.md` rows 7–23 turned on behaviour a shape does not show.

### Verification

Requires a `z3` binary on `PATH`, or `LIBPETRI_Z3` pointing at one.
`tests/z3-gate.test.ts` fails the build when no solver resolves, so proofs cannot quietly become
skips.

## Source layout (`typescript/src/`)

- `index.ts` — package root.
- `compiler/` — `StepFlowEntry[]` -> `CompiledWorkflow` (one `PetriNet`, a cached
  `PrecompiledNet`, a `NetMap` relating transitions to entries and places to `(entry, port)`).
  Takes a structural description; no Mastra runtime dependency.
- `engine/` — the kernel (`runWorkflow`: seed, run to a terminal, classify) and the run scope.
  Host-free; `PetriExecutionEngine` itself lives in `mastra/` ([ADR 0005]).
- `codec/` — host-free snapshot helpers (empty today). Decoding Mastra's resume parameter lives in
  `mastra/resume-codec.ts`, because it reads Mastra's types ([ADR 0005], [ADR 0007]).
- `mastra/` — the **only** directory that imports `@mastra/core` at runtime ([ADR 0005]):
  `PetriExecutionEngine extends ExecutionEngine`, the runner that fires steps on Mastra's own
  `StepExecutor`, result formatting and persistence. `@mastra/core` is a peer dependency and a tsup
  external; `compiler/`, `engine/` and `verify/` stay host-free, enforced by a source guard test.
- `verify/` — the claims ([ADR 0009]): `verify(compiled)` proves completion, bounds, exclusion
  and liveness per segment; `claims.ts` derives them and holds the retry-ceiling check.
- `cli.ts` — `mastra-libpetri verify <module>`, over `mastra/verify.ts`'s `verifyMastraWorkflow`.
- `conformance/` — the classifier and the differential harness.
- `internal/` — the libpetri surface assertion and shared helpers.

## Working notes

Decisions go in `docs/adr/`. Open work goes in `tasks/todo.md`. Divergences from Mastra go in
`docs/divergences.md`.

Sibling integrations (`n8n-libpetri`, `temporal-libpetri`, `adk-libpetri`) solve the same
problems against different hosts. When one reports a libpetri bug, treat it as a question about
this codebase until proven otherwise — that habit found a three-language correctness bug during
planning. Cross-cutting libpetri gaps are raised upstream rather than worked around locally.

<!-- code-graph-mcp:begin v2 -->
## Code Graph (repo-wide AST index)

AST + FTS + vector index of the whole repo — prefer over multi-round Grep/Read for
structural queries (LSP only sees open files; this sees everything). Fastest path = Bash CLI:

| Intent | Command |
|--------|---------|
| Who calls X / what X calls | `code-graph-mcp callgraph X` |
| Impact before editing a fn | `code-graph-mcp impact X` |
| Unfamiliar dir / module | `code-graph-mcp overview <dir>` |
| Symbol source / signature | `code-graph-mcp show X` |
| Concept search (no exact name) | `code-graph-mcp search "…"` (vector: MCP `semantic_code_search`) |
| grep + AST context | `code-graph-mcp grep "pat" [paths] [-t lang] [-g glob] [-c]` |

Not on PATH? A plugin-only install keeps its own copy — same commands, run
`~/.cache/code-graph/bin/code-graph-mcp` (or `npm i -g @sdsrs/code-graph` once).

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
