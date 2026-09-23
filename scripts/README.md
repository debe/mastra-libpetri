# Scripts

| Script | Role |
|---|---|
| `link-libpetri.sh` | Links `typescript/node_modules/libpetri` at a sibling checkout, **on purpose only** — to try a libpetri fix that is not released. The package depends on the released `^6.1.0`. `--check` / `--strict` / `--provenance` report what a linked run actually used; `--unlink` returns to the registry copy. |
| `libpetri-pin` | The sibling revision measurements were taken against. A figure produced from a different revision is not comparable and is not reported as if it were. |
| `bootstrap-mastra.sh` | Puts a pinned Mastra tree under the gitignored `.mastra/`. `--dist` (the default) fetches the published `@mastra/core`, verifies it against the pinned sha512, and recovers the **original TypeScript** of the workflow engine from the sourcemaps the package ships — no monorepo clone. `--repo` clones the monorepo, which only conformance needs. `--check` reports what is present. |
| `mastra-pin` | The two Mastra pins, and why they are separate: the published version the compiler is written against, and the git commit conformance runs against. |

Planned, as their milestones land: `verify-patch.sh` (re-apply the upstream PRs and fail on
drift), `run-conformance.sh` (both engines, with the classifier), `check-docs.py` (every `spec/`
requirement ID appears in the coverage matrix and resolves to a real test).

## Why the dist route exists at all

The plan assumed Mastra's semantics could only be read from a monorepo clone. They cannot only be
read that way: `@mastra/core` publishes `.js.map` files carrying `sourcesContent`, so the tarball
contains the engine's original source — `default.ts`, `execution-engine.ts`, `workflow.ts` and
`handlers/` among ~53 workflow files. That is both cheaper and *more* correct to compile against,
because it is the tree a user of this engine actually runs, rather than whatever `main` happens to
be. The clone is kept for the one thing the tarball genuinely cannot do: run Mastra's own tests.
