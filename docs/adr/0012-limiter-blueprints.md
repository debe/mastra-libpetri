# ADR 0012 — `limit` and `rateLimit` are blueprints over fused quota places, one quota per run

Status: proposed (2026-10-04, M7)

## Context

Mastra has no word for a limit shared across different steps, a mutex, or a rate limit. Under
[ADR 0002] such a thing is Layer 3: capability the IR cannot express, gated by the `PetriEngineType`
brand. libpetri's fusion sets were motivated by exactly this case — "a global rate limiter shared by
three instances of a leaky-bucket subnet" (spec/11, fusion) — and merge places, not transitions.
n8n-libpetri's ADR 0009 §6 gives the rule a refill must follow: gate it on outstanding demand, or
the net never quiesces. temporal-libpetri's `BoundedOperation` has the admit/settle shape.

## Decision

**`init()` returns `limit(n, {id})` and `rateLimit(burst, per, {id})`; a petri `createStep({ ...,
uses: [quota] })` draws on them. Each quota is one set of canonical places per run, which every
using step's local places are fused into.**

- **Surface.** On `init()`'s factories, so the brand is the gate. The petri `createStep` — every
  overload: params, agent, tool — accepts `uses?: readonly Quota[]` (and `timeout`, [ADR 0013]),
  strips them before Mastra's `createStep`, and attaches `{ quotas, timeoutMs }` under a
  module-private symbol `STEP_RESOURCES` on the Step object, and on the options object Mastra keeps
  as `__agentOptions` / `__toolOptions` for agent and tool sources (`workflow.ts:579-593`). The
  petri `cloneStep` copies it. The adapter reads it into `StepDescription.quotas`. Quota identity is
  the object; `id` names its places. Refusals: `quota-id-collision` (two quota objects, one id),
  `quota-value` (not a whole number ≥ 1, or `per` above the wait ceiling), `uses-position` (a
  declarative `.agent('id')` / `.tool('id')` that never passed through the petri `createStep`).
- **Scope: one run.** Each run is its own net; a quota shared across concurrent runs would need a
  long-lived net hosting every run. Out of scope (maintainer decision), recorded as a divergence.
- **`limit(n)`.** A pool seeded with `n`. Each attempt takes `one(quota)` with its run permit in the
  same firing and returns it on every branch — no hold-and-wait, so no deadlock between pools. With a
  timeout the attempt is in flight until the step returns, so the quota is held throughout.
- **`rateLimit(burst, per)`.** At most `burst` tokens at once, one back every `per` ms; every
  attempt spends one, retries included (a provider counts calls). Places `bucket` (seeded `burst`),
  `spent`, `demand`. Per using attempt, `request-j: in_j -> ready_j + demand` (inhibited by
  `wf.cancel` at entry), and the attempt consumes `ready_j + demand + bucket` and deposits `spent` on
  every branch. Once per quota, emitted by the compiler and never by a gadget (fusion does not merge
  transitions): `refill: one(spent), read(demand), delayed(per) -> bucket`. With no demand the
  refill is disabled and the net quiesces. After idle the clock restarts at first demand ([TIME-011]),
  so the rate is never exceeded and may be under-used.
- **One structural check for every pool.** `verify/pools.ts` generalises `budgetStructureViolations`
  (which keeps its export): each pool declares its conservation vector (pool plus holder places),
  takers and givers; every branch of every transition preserves the weighted sum; takers and givers
  move exactly one token; nothing reads or resets a pool except the refill's read of `demand`. It
  covers run permits, block slots ([ADR 0011]), `limit` quotas and buckets, and is host-agnostic —
  an M10 candidate.
- **Claims.** `limit`: `placeBound(quota, n)`, `quiescentCount([quota], n, n)`. `rateLimit`:
  `placeBound(bucket, burst)`, `placeBound(spent, burst)`, `quiescentCount([demand], 0, 0)`, and the
  existing completion claims. *At most `burst` per window* is a timed property the untimed verifier
  cannot state: it is **tested** under ManualClock, not proven, and the report says so.
- **Proof routes.** `limit` keeps enumeration. A `rateLimit` adds one timed transition per quota and
  takes the SMT route, as nets with a `delayed` retry hop already do. A query over 30 s means one
  shared `request` per quota instead of one per attempt — a redesign, never a bigger budget.

## Consequences

- Composition is the acceptance test (`tests/verify/blueprints.test.ts`, named by ADR 0002): a
  `rateLimit` used by three steps compiles to one `bucket`, `spent`, `demand` and refill, and under
  ManualClock three steps × 10 calls at burst 3, per 1 s finish at exactly a single bucket's instants;
  a `limit` inside a block-limited `.parallel()` peaks at min(c, n, k).
- `race`, `quorum`, `pipeline`, `supersede`, `correlate`, `compensate`, `circuitBreaker` and `queue`
  stay in M7b.

## Evidence

Untested until M7 lands. Planned: `tests/compiler/quota.test.ts`, `tests/mastra/blueprints-surface.test.ts`,
`tests/mastra/adapt-resources.test.ts`, `tests/verify/pools.test.ts`, `tests/verify/blueprints.test.ts`.

[ADR 0002]: 0002-three-layer-surface.md
[ADR 0011]: 0011-block-concurrency.md
[ADR 0013]: 0013-step-timeout.md
