# ADR 0009 — Every compiled workflow carries four families of claims, derived, proven, and gated over the corpus

Status: accepted (2026-09-25)

## Context

Through M5, `verifyWorkflow` proved one family per segment — `deadlockFree` with every terminal a
sink, `terminatesAtSink`, `exactlyOneTerminal`, `neverCanceled`, and the budget's two — and six
structural checks ran before it. Each gadget's own invariants (a foreach's cursor never beside a
recorded outcome, a lane idle or busy, never both) were proven in that gadget's tests, over
hand-built nets, and nowhere else. Nothing proved anything about the workflows a user writes, and
three of M6's four items — dead steps, mutual exclusion, place bounds — had no derivation at all.
The retry ceiling was a comment on the leaf gadget.

M6 asks for all of it per compiled workflow, gated over the corpus, with `unknown` failing.

## Decision

**`verify(compiled)` proves four families, every claim derived from the compiled net and what its
gadgets declared** — never written per workflow:

| family | claim | query | segments |
|---|---|---|---|
| completion | `verifyWorkflow`'s set, unchanged | as before | all |
| bounds | every place at its claimed bound | `placeBound(p, n)` | all |
| exclusion | Mastra's barrier, and each gadget's declared pairs | `mutualExclusion(a, b)` | all |
| liveness | every step attempt, retries included, can fire | `unreachable(inputs(t))` refuted | `closed` |

plus a seventh structural check, `retryCeilingViolations`, before any query.

**Bounds: 1 unless a gadget says otherwise.** A gadget returns `claims` only for its exceptions —
a `.parallel()` / `.branch()` claims `n` on its shared settlement places (`arrived`, the four arm
exits, the two markers), a `.foreach()` claims its lane count on `faults` and `exits` — at up to
two lanes. That bound rests on the dispatch inhibitors (once an outcome is recorded no item
starts), which no linear invariant captures: z3 proves it at two lanes and returns `unknown` at
three after 300 s, 600 s with [VER-016]'s counters (`foreach-c3`). Above two lanes the two places
are listed as unclaimed with that reason, not claimed and failed. A new place
is held to the strictest bound until someone argues for more. A place whose count is **data**, or
is deposited several at a time by one firing — which every analysis counts as one ([IO-016]) — is
`unclaimed`, with its reason, and the report lists it: a foreach's `results` (one per item),
`parked` and `suspensions` (carried suspensions arrive together), and a loop's allowance (seeded
`iterationBound` at once; bounded by construction, not by proof). The permit place is left to
`permitsBounded`.

**Exclusion: the barrier, pairwise.** Mastra's `for` loop over the step flow starts entry `i + 1`
only once entry `i` has returned, and reports an outcome only once the entry that produced it has
returned. For every top-level entry `i`, every place it owns (named under `s.<i>`, arms and lanes
included) is exclusive with `next(i)` — the next entry's input, or the success settle place — and
with every outcome place: the settle places and `wf.canceled`. Pairwise is enough for the whole
claim: a place of entry `i` is filled only by a firing of entry `i` or by entry `i − 1`'s success,
so if all of entry `i` is empty at the moment `next(i)` is marked, nothing refills it afterwards.
Gadgets add their own pairs: the foreach cursor against each recorded outcome (`queue.kill()`), and
each lane's permit against its slot.

**Liveness: a witness, not a proof.** "No dead steps" is existential, so it is shown by a run: the
query that a step attempt's inputs are never marked together must come back `violated` **with a
confirmed firing sequence** (`counterexampleConfirmed === true`). An unconfirmed violation does not
count. Only the `closed` segment is asked — a step that runs in a fresh run is not dead, and the
other segments start inside one. With every attempt covered, the final attempt's witness is the
retry ceiling **reached**, not merely bounded.

**The retry ceiling, on the arcs.** Retries are unrolled, so the ceiling is topology: the leaf
records each step's chain (`StepChain`), and `retryCeilingViolations` checks that it is a simple
path nothing else enters — `retries + 1` attempts, `retries` hops, each link produced and consumed
only by its neighbours, the final attempt producing into no link. A token arriving at the input
then passes each attempt at most once. A proof cannot say this: the analyses have no counter to
bound, and a missing link would not strand anything.

**What a claim ranges over.** Every query is over the untimed, value-blind model ([VER-004]). A
`proven` holds of every run, because the model can do anything the executor can. A witness is a
run of the model; on a net with timed transitions it may be one the clock rules out — the report
names the route.

**Two phases per query.** libpetri tries the enumeration route first, and on a wide net it declines
only after exhausting its class budget — 3–5 s a query on `parallel-wide`, where the linear bound
of [VER-015] proves the same barrier claim in about 20 ms (measured against libpetri 7.0.0, not
linked). So each bounds, exclusion and liveness query first runs with enumeration off and a short
budget; its answer is kept only if it settles the claim (`proven`, or a confirmed witness), which
is sound however short the budget. Otherwise the query runs again in full. The quick phase changes
how fast a verdict arrives, never which verdict a claim reports. A segment whose completion proofs
took the enumeration route within 250 ms skips the quick phase: its state space is small, and
enumeration settles it faster than any solver. The threshold matters — `parallel-wide`'s closed
segment enumerates too, at about 3 s a query, and routing its 5,183 claims that way took 44 min (beside a second shard).

**A completion proof that comes back `unknown` is asked once more with [VER-016]'s firing
counters** (`stateEquation(true)`). At five foreach lanes `deadlockFree` is `unknown` after 131 s
without them and `proven` in 346 s with them. libpetri keeps them opt-in because they slow the
witness search on a violated property, so they are asked only where the plain query could not
decide; a retry that decides nothing keeps the first answer.

**A missing solver throws before any query** (`Z3Unavailable`): a small net can settle every
claim structurally or by enumeration, and a missing z3 would then go unnoticed until the net that
needs it.

**Entry points.** `verify(compiled, options)` in `verify/`, host-free; `verifyMastraWorkflow` in
`mastra/`, which adapts and compiles a committed `Workflow` as the engine would and verifies its
nested workflows too; and the `mastra-libpetri verify <module>` CLI, which exits non-zero on any
claim that does not hold — `unknown` included — and 2 when no solver resolves. `verify` asserts the
libpetri surface at entry.

## Consequences

- `verifyWorkflow` and its report keys are unchanged: every existing test's verdict map still
  reads the same. `verify` is the superset: it runs `verifyWorkflow`'s structural checks, then asks
  the same completion queries (`completionProperties`, one definition) itself, in its pool, so a
  five-lane foreach's six segments are not proven one after another.
- The compiled workflow carries more: `steps`, `claims`, `exclusions`, `entries`. None of it is
  read at runtime.
- A gadget that adds a place bounded above 1 must say so, or its workflow stops verifying — which
  is the point.
- The barrier is `O(|places| × 7)` queries per segment. Most settle structurally in milliseconds;
  the corpus figures are in `tasks/todo.md` M6.

## Evidence

`tests/verify/claims.test.ts` (derivation, the retry-ceiling rules, and one mutant per family that
flips exactly its claims), `tests/verify/corpus.test.ts` (the gate), `tests/mastra/verify.test.ts`,
`tests/cli.test.ts`.
