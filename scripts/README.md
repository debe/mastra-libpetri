# Scripts

| Script | Role |
|---|---|
| `link-libpetri.sh` | Links `typescript/node_modules/libpetri` at a sibling checkout. The default until libpetri 6.1.0 publishes — the engine calls `TIME-015`, the `MOD-031` alias fix and `NU-011`, none of which are in the released 6.0.0. `--check` verifies the link and the pinned revision; `--unlink` restores the registry copy. |
| `libpetri-pin` | The sibling revision measurements were taken against. A figure produced from a different revision is not comparable and is not reported as if it were. |

Planned, as their milestones land: `bootstrap-mastra.sh` (clone Mastra at a pinned commit and
capture an unpatched baseline), `verify-patch.sh` (re-apply the upstream PRs and fail on drift),
`run-conformance.sh` (both engines, with the classifier), `check-docs.py` (every `spec/`
requirement ID appears in the coverage matrix and resolves to a real test).
