# Integration specification

The language-neutral observable contract for compiling and running Mastra workflows as Coloured
Time Petri Nets. It **extends** the [libpetri specification](https://github.com/debe/libpetri/blob/main/spec/00-index.md);
core firing, topology, timing and composition semantics remain upstream and are cited, never
restated. TypeScript API details belong in the [package README](../typescript/README.md).

Requirements use stable category IDs with MUST statements and testable acceptance criteria.
These IDs are local to mastra-libpetri.

| Chapter | Prefix | Requirements |
|---|---|---|
| [compilation](01-compilation.md) | CMP | 0 |
| [engine boundary](02-engine-boundary.md) | ENG | 0 |
| [suspend and resume](03-suspend-resume.md) | RES | 0 |
| [observability](04-observability.md) | OBS | 0 |
| [blueprints](05-blueprints.md) | BPT | 0 |
| [verification](06-verification.md) | VER | 0 |

Chapters are written as the milestones that produce them land; a chapter with zero requirements
is a placeholder, not an omission.

See the [concept mapping](mapping.md), the [coverage matrix](coverage-matrix.md), the
[decision records](../docs/adr/README.md) and the [divergence register](../docs/divergences.md).
