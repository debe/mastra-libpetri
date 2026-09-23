# ADR 0004 — Cancellation is an environment place the net inhibits on, checked where Mastra checks

Status: accepted (2026-09-23)

## Context

CLAUDE.md requires cancellation to be structural — an inhibitor arc on a cancel place plus
cleanup arcs — and never an engine-level abort or a flag an action reads. Mastra's abort
semantics, read from its source rather than assumed:

- The signal is checked **before each top-level entry** (`default.ts:815`), **between loop
  iterations** (`handlers/control-flow.ts:742,807,889`) and **before each foreach dispatch**
  (`:1160,1298`). Never inside a step, and never between retries — `executeStepWithRetry` retries
  straight through an abort (`default.ts:455-460`). So once a `.parallel()` or `.branch()` has
  started, every arm runs.
- After **every** top-level entry, whatever it produced, the entry's result is re-stamped
  `canceled` if the signal fired meanwhile (`handlers/entry.ts:815-817`); the step's own record,
  stored just before, keeps its real outcome.
- In-flight work is awaited, never abandoned.

A cancel reaches a *running* net only by injection, which makes the cancel place an environment
place — and with one registered, libpetri's executor no longer ends at quiescence ([ENV-010]).

## Decision

**One cancel place, `wf.cancel`, reached through an arrival transition.** When a run has a signal,
the kernel registers `wf.cancel.request` as an environment place and injects one token there when
the signal fires; an immediate `t.cancel.arrive` moves it to `wf.cancel`. Nothing consumes
`wf.cancel`: every transition that
starts new work where Mastra checks carries an **inhibitor arc** on it, and every place where work
waits to start there has a **sweep** — a transition that reads it and moves the waiting token to
the `canceled` exit. A gadget receives the place only where Mastra would check; `emitNested`
defaults a child to ungated, so an arm of a started block runs, as in Mastra.

**The settle stage models the re-stamp.** A top-level outcome settles in a place first; two
structurally exclusive transitions — one inhibited by the cancel place, one reading it — send it
to its terminal or to `wf.canceled`. A non-final success needs none: it lands in the next entry's
input, whose sweep is the same check.

**The run ends by `drain()` when a terminal is marked**, called from an event store watching for
a token in a terminal place. `drain()` stops nothing — in-flight actions finish and the net comes
to rest ([ENV-011]) — and in libpetri 6.1.0 a wake-up raised while the executor is not parked is
latched, so calling it from inside the firing cycle is safe (advice from the libpetri session). An
abort after the drain is rejected by the executor, which reads correctly as "already terminal". A
run without a signal registers no environment place and ends at quiescence, as before.

**Proven in two segments, on one closed net.** `verifyWorkflow` proves a `closed` segment (no
cancel ever arrives) and a `cancel` segment (the request is seeded, so the arrival may fire in
every reachable marking), and returns both — a caller cannot take one without the other by
default. Neither implies the other: the arrival is enabled until it fires, so no marking with a
pending request is quiescent, and the `cancel` segment sees only runs the cancel reached (a gap
libpetri-d6 pointed out). The cancel place is a declared sink, which blinds `terminatesAtSink` to
a stranded run — so `exactlyOneTerminal` carries the claim in the `cancel` segment. The `closed`
segment adds `neverCanceled`: with no arrival, `wf.canceled` is unreachable.

**Structure is checked before behaviour.** A start that lost its inhibitor still drains to exactly
one terminal, so no quiescence property sees it. `cancelStructureViolations` checks the arcs: the
signal is never consumed or reset, and every transition that needs every input some sweep needs
is inhibited by the signal. `verifyWorkflow` runs it first and refuses an unsound net.

*Amended M1 (same day), from measurement:* the first version registered `wf.cancel` itself as the
environment place and proved with `bounded(1)`. libpetri routes any net with an environment place
away from enumeration to SMT: 0 of 103 cancellation proofs enumerated, the slowest took 411s, and
some mutants a closed proof refutes in 7ms came back `unknown` after minutes. With the arrival in
the net and the request seeded, the net stays closed and the same proofs run by enumeration in
18–29ms (parallel, branch and loop). One net still serves execution and verification — the
separate verification twin that would also have worked is ruled out by that rule.

## Consequences

- A run with a signal whose model strands a token never reaches a terminal and ends only at
  `timeoutMs`. `exactlyOneTerminal`, proven under cancellation, rules it out for the gadgets.
- Every top-level outcome costs one settle place and two transitions.
- A late abort after a terminal changes nothing, as in Mastra.
- **An action never decides cancellation**, even for work already running. An action-side wait
  cut short by the signal deposits into a local place, and the ordinary inhibitor/sweep pair sends
  it on or to `canceled`. A first version decided it in the action by reading
  `scope.signal.aborted`; the value-blind verifier then found `wf.canceled` reachable in the
  `closed` segment, and `neverCanceled` was violated. The rule caught its own author.
- **At runtime the environment writes to `wf.cancel` directly**; `wf.cancel.request` and
  `t.cancel.arrive` exist for the proof. Routing a real abort through the arrival cost an extra
  firing, and every verifier found the consequence: a start enabled in the same cycle fired before
  its inhibitor saw the signal, so a pre-aborted run started its first step and an abort raised a
  microtask after a step let the next one start. Mastra reads its signal synchronously and does
  neither. Direct injection is the event the verifier models, without the hop.
- **Which check sees which safeguard.** A step's first-attempt inhibitor is witnessed *only* by the
  structural check: the sweep wins the race at runtime and every proof drains to one terminal. A
  sweep is seen by the `cancel` segment; a sweep that lost its read arc, by `neverCanceled`; a
  lost inhibitor, by the structural check. The foreach's `refuse.l` transitions exist partly so
  that its lanes' start inhibitors have structural teeth.
- Coverage is not total. `neverEnabledWhile`, a property that would prove "no start fires while
  the signal is marked" directly, does not exist in libpetri 6.1.0; the structural check stands in
  for it. The libpetri session has passed it to the maintainer as a candidate requirement, along
  with enumeration support for bounded environment places.

## Evidence

A prototype established the verification route before any gadget used it: with sweeps, all three
properties proven under `bounded(1)`; without them, `deadlockFree` and `exactlyOneTerminal`
**violated** while `terminatesAtSink` stayed proven — the sink blind spot above, measured. On the
way, passing a `Place` instead of a place name to `environmentPlace()` silently verified a closed
net and proved the stranding net; the structural check now refuses a cancel place missing from the
net, a guard libpetri 6.1.0 does not have. Runtime: `tests/engine/cancel.test.ts`; structure:
`tests/verify/structure.test.ts`; both segments in every `tests/verify/` file.
