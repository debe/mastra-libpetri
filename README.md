# mastra-libpetri

**An alternative execution engine for [Mastra](https://mastra.ai) workflows, built on
[libpetri](https://github.com/debe/libpetri).** A compiler turns a committed Mastra workflow into
one Coloured Time Petri Net; a kernel runs that net, so the net decides what runs next.

It registers through Mastra's own extension point — `createWorkflow({ executionEngine })` — and
changes nothing else. Mastra keeps step execution, storage, suspend/resume persistence,
observability, agents and the authoring API. **With nothing registered, Mastra runs its own
engine exactly as before.**

> Status: early. The repository is scaffolded and the toolchain is green; the compiler and
> kernel are being built. See [`tasks/todo.md`](tasks/todo.md) for the milestone state, which is
> the honest answer to "does this work yet".

## Why a net

Two payoffs, and the second is the larger one.

**Provability.** Retry budgets, concurrency limits, rate limits and mutexes become *places*
rather than executor options, so a limit is part of the model and can be proven. Cancellation and
staleness become inhibitor and reset arcs rather than flags. Every compiled workflow gets a
declared property set — deadlock freedom with a complete sink list, termination at declared
sinks, place bounds, mutual exclusion — checked before it runs.

**Expressiveness.** Mastra's `StepFlowEntry[]` is a *barrier* model: it fans out only inside a
`parallel` / `conditional` / `loop` / `foreach` entry and always joins before the next index. A
net is a *dataflow* model with no barriers, only enablement. That one difference is what makes
pipelining, racing, quorum joins, shared cross-step resources, barge-in, correlated joins and
compensation expressible — none of which arrive by writing more TypeScript inside the existing
shape.

## Three layers

New capability never costs compatibility, because each layer states its own contract
([ADR 0002](docs/adr/0002-three-layer-surface.md)).

| Layer | What it is | Runs on Mastra's engine? |
|---|---|---|
| **1 — parity** | existing workflows, compiled | yes, identically |
| **2 — annotations** | options Mastra has a word for but does not enforce (a `concurrency` on `.parallel()`) | yes — **degrades**; unenforced, same meaning |
| **3 — blueprints** | capability the IR cannot express | **no**, and the type system says so |

Layer 3 is gated by a phantom engine-type brand on the `init()` factory's re-branded
`createWorkflow` / `createStep` — the mechanism `@mastra/inngest` already uses. Reaching for a
blueprint is a typed, visible decision, never a silent incompatibility.

## Blueprints

Each is a subnet with named ports, surfaced in Mastra's vocabulary, shipping with a proven
property. They compose because they are subnets over shared places.

| Blueprint | What you get | Why the IR can't |
|---|---|---|
| `limit(n)` | a bound on fan-out | `.parallel()` is unbounded `Promise.all`; there is no concurrency option |
| `rateLimit(burst, per)` | one provider quota shared across *different* steps | no cross-step resource concept |
| `race()` | first result wins, losers structurally excluded | `.branch()` is inclusive — every truthy arm runs and all join |
| `quorum(k, n)` | proceed when k of n agree | joins are all-or-nothing |
| `pipeline()` | stage 2 of item 1 while stage 1 of item 2 runs | join-before-next-index is the IR's defining property |
| `supersede()` | new input invalidates in-flight work | a cancelled flag read inside an action is the classic stall |
| `correlate(key)` | overlapping groups joined by identity | no way to pair results across concurrent groups |
| `compensate()` | saga rollback | no rollback story; failure propagates |
| `circuitBreaker()` | stop calling a failing dependency, shared | per-step `retries` only |
| `queue(depth)` | backpressure | no bounded channel |

## Scope

| Mastra keeps | mastra-libpetri provides |
|---|---|
| step execution, `createStep`, agents, tools | the scheduling decision — which step runs when |
| storage, `WorkflowRunState`, run IDs | the marking that state encodes and decodes |
| `.watch()` / `.stream()` observers | the event stream behind them |
| the authoring API and its types | compilation, plus the Layer 2/3 surface |
| cron scheduling (evented engine) | verification, blueprints, structural limits |

## Honesty rules

These are not aspirations; they are how results are reported.

- A property is **proven**, **violated** with a counterexample, or **not checked**. Never
  "correct because it was read and looked right". `Unknown` fails a build rather than passing
  quietly — see [`tests/z3-gate.test.ts`](typescript/tests/z3-gate.test.ts).
- A proof is about the *model*. It says nothing about whether a step's action throws or the
  service it calls is down. Executor-level tests cover that half and are not optional.
- Every Mastra behaviour not reproduced is in [`docs/divergences.md`](docs/divergences.md). No
  silent skips.
- A number measured against a linked libpetri checkout is not comparable with one measured
  against a release, and never reported as if it were.

## Building and testing

Requires Node >= 24 and a `z3` binary on `PATH` (or `LIBPETRI_Z3` pointing at one).

```bash
cd typescript
npm install          # links libpetri from the sibling checkout, see below
npm run check        # tsc --noEmit for src and tests
npm test             # vitest
npm run build        # tsup, multi-entry ESM
```

**libpetri is linked, not installed from the registry.** The engine calls surface that is
committed but unreleased — [TIME-015] injectable clock, the [MOD-031] place-alias fix, [NU-011]
resume-safe minting — plus [CORE-073]/[ENV-014] snapshot, which is implemented but uncommitted.
npm publishes 6.0.0. `package.json` therefore declares
`"libpetri": "file:../../libpetri/typescript"`, and the floor becomes `^6.1.0` the day it
publishes. `scripts/libpetri-pin` records the sibling revision, and
`scripts/link-libpetri.sh --check` verifies it.

## Verifying a workflow

```bash
npx mastra-libpetri verify ./src/mastra/index.ts          # every exported Workflow, and a Mastra's
npx mastra-libpetri verify ./flows.ts --export orders --concurrency 4 --json
```

or `verifyMastraWorkflow(workflow)` from code. Either compiles the workflow exactly as the engine
would, nested workflows included, and proves four families of claims about the net
([ADR 0009](docs/adr/0009-verification-claims.md)):

| family | what it says |
|---|---|
| completion | no run strands a token; every run that comes to rest ends in exactly one terminal; nothing is canceled unasked; a budget's permits are conserved |
| bounds | every place holds at most its claimed count — 1 unless a gadget says why more; a count that is data is listed as unclaimed, not proven |
| exclusion | Mastra's barrier: no entry holds work once the next has started or an outcome is on its way out; plus each gadget's own pairs |
| liveness | every step attempt, every retry included, has a confirmed run that reaches it: no dead steps, and each retry ceiling is reached |

Each is proven for a fresh run, a run canceled at any point, and a run resumed at each resume
site. The CLI exits 0 only when every claim holds; `unknown` exits 1, and a missing solver 2.
Every workflow of the differential corpus is gated this way in CI
([`tests/verify/corpus.test.ts`](typescript/tests/verify/corpus.test.ts)).

## Repository map

| Path | Role |
|---|---|
| `typescript/` | the package (never the repo root) |
| `tasks/todo.md` | milestones and open work — the honest project state |
| `docs/adr/` | decisions |
| `docs/divergences.md` | every Mastra behaviour not reproduced |
| `spec/` | local requirements, the concept mapping, the coverage matrix |
| `patches/mastra/` | behaviour-neutral upstream PRs, each with its neutrality proof |
| `scripts/` | bootstrap, conformance, libpetri linking |

## License

Apache-2.0. Mastra and libpetri are separate projects under their own licenses.
