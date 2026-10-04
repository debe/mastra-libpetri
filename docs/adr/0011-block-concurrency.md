# ADR 0011 — A block's `concurrency` is a seeded pool of slots, admitted in arm order, proven

Status: accepted (2026-10-04, M7)

## Context

M7 was planned as "Mastra-vocabulary options (`concurrency`, `retries`, `retryConfig`, `timeout`)
compiled to structure". The survey against Mastra 1.67's recovered source says otherwise:

- `retries` and `retryConfig` are enforced by the default engine (`handlers/step.ts:314-315`,
  `default.ts:455-465`) and have been compiled since M1 — Layer 1 parity, not Layer 2.
- `concurrency` on `.foreach(step, { concurrency })` is enforced by `fastq`
  (`handlers/control-flow.ts:1053-1272`) — Layer 1, compiled.
- `timeout` does not exist on a step, tool, agent or entry (row 6); see [ADR 0013].
- `.parallel()` and `.branch()` take `StepFlowEntryOptions = {id, description, metadata}`
  (`types.d.ts:505-509`); `toEntryOptionFields` drops every other key (`workflow.ts:647-653`), and
  every arm runs under `Promise.all` (`handlers/control-flow.ts:220, 396, 540`).
- `metadata` (`Record<string, any>`) is read by the default engine only for span attributes
  (`handlers/control-flow.ts:62-81`); Mastra's own doc says none of it affects execution
  (`types.d.ts:500-503`). [ADR 0010]'s `checkpoint` already rides there.

So the one genuine Layer 2 resource is a bound on a block's fan-out, spelled in Mastra's word
(`concurrency`, from `.foreach`) and carried where Mastra keeps what it does not enforce.

## Decision

**`.parallel(steps, { metadata: { concurrency: c } })` and `.branch(pairs, { metadata: {
concurrency: c } })` run at most `c` arms at once, admitted in arm order, from a pool of `c` slots
seeded in every segment's initial marking. The bound is a proven P-invariant.**

- **Surface.** A whole number `c ≥ 1` in the block's own `metadata`. `c ≥ arms` compiles to exactly
  today's net — the limit cannot bind. Refused at adaptation, by name: `concurrency-value` (not a
  safe integer ≥ 1, or a function), `concurrency-position` (on a `.then` step, an agent, tool, map,
  sleep or loop, or on an arm's or body's own step metadata — the message names the enclosing
  block's options, the engine's run-wide `concurrency`, and `cloneStep`), `concurrency-foreach` (use
  `.foreach(step, { concurrency })`, which Mastra enforces). `adapt.ts` exports
  `LAYER2_METADATA_KEYS = ['checkpoint', 'concurrency']`.
- **The net.** A pool `wf.slots.<i>` — outside the `s.<i>` namespace, as `wf.permits` is — seeded
  with `c` tokens, never deposited by an action ([IO-016], [ADR 0006]). A FIFO cursor `q.j` passes
  only at `admit-j`: `q.j + slot -> armIn_j + active + q.{j+1}`. For a branch the gate first routes
  a skipped or reused arm straight to its arrival and passes the cursor without a slot. Every
  collect consumes one `active` and returns one slot. A resume's `re-admit-j`, after `re-enter-j` has checked the seed, takes a slot; replays
  take none. A slot is held from admission to settlement, across retries and retry delays.
- **Every arm still runs.** No fail-fast: `.parallel` semantics, not `.foreach`'s.
- **Cancellation.** Queued arms are not gated (ADR 0004, row 28: arms of a started block are not):
  an arm admitted after the abort starts with its signal aborted, every arm gets its record, and the
  run settles `canceled`. No new sweeps.
- **With the run budget `k`.** Slot first, then permit; a permit is never held while waiting for a
  slot. In flight within the block ≤ min(c, k).
- **Claims**, in every segment (`closed`, `cancel`, `resume@arm`, `restart@p`):
  `placeBound(active, c)`, `placeBound(wf.slots.<i>, c)`, `quiescentCount([wf.slots.<i>], c, c)`.
  The invariant `slots + active = c` is checked on the arcs by the shared pool check
  (`verify/pools.ts`, [ADR 0012]). The pool is a P-semiflow, which libpetri's linear bound and
  Route A use directly — preferred by libpetri over a threshold inhibitor, which is not planned.
- **Layer 2's contract is a test.** `tests/engine/layer2-ignorable.test.ts`, driven by
  `LAYER2_METADATA_KEYS`: the annotated workflow on `DefaultExecutionEngine` succeeds with the same
  result and steps as its unannotated twin, and the same result as on this engine; peak in flight is
  n there and ≤ c here. Type tests pin why the key lives in `metadata`: `{ concurrency: 2 }` in a
  block's options is a type error in Mastra's own types.

## Consequences

- A block limit is not data-neutral for read-modify-write workflow state (row 71), and arms start
  later than on Mastra; order only strengthens (row 4).
- Rate limits, mutexes and limits shared across steps have no Mastra word: they are Layer 3
  ([ADR 0012]).

## Evidence

Merged to `main` in `4b5383d` (M7); CI green on `f1c5506` (all jobs). libpetri 8.0.0
from npm, not linked.

- `tests/compiler/block-limit.test.ts` — the slot pool and FIFO admission on `.parallel()` and
  `.branch()`, `re-admit-j` under resume.
- `tests/mastra/adapt-concurrency.test.ts` — `metadata.concurrency` read off the block, refusals.
- `tests/engine/layer2-ignorable.test.ts` — the Layer test: the same workflow on
  `DefaultExecutionEngine` ignores the annotation and stays meaningful.
- `tests/conformance/block-limit-differential.test.ts` — block-limited fixtures against Mastra.
- `tests/verify/pools.test.ts` — `poolStructureViolations` on slots, each rule by a mutant; the
  slot claims proven in the corpus gate and in `tests/verify/blueprints.test.ts`
  (`limit(2) in .parallel(c=3)`: peak min(c, n, k)).

[ADR 0006]: 0006-run-step-budget.md
[ADR 0010]: 0010-restart-from-marked-checkpoints.md
[ADR 0012]: 0012-limiter-blueprints.md
[ADR 0013]: 0013-step-timeout.md
