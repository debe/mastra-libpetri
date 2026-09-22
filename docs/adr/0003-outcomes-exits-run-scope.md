# ADR 0003 — Outcomes route to exits the context chooses; a run carries its own scope

Status: accepted (2026-09-22)

## Context

The M1 audit read Mastra's recovered source against the compiler and found the IR modelled a
step as succeeding or failing. A Mastra step handler assigns five outcomes — `success`, `failed`,
`bailed`, `suspended`, `paused` (`handlers/step.ts:516-529`) — and the compiler had two. Three
more findings sat on the same seam:

- **Where `bail` goes depends on where the step is.** At the top level it ends the run as a
  success (`default.ts:926-928`); inside a `loop` or `foreach` it exits that combinator and then
  the run; inside `.parallel()` or `.branch()` it is silently swallowed and the block succeeds
  (`handlers/control-flow.ts:267-295`). Two audit areas recommended incompatible fixes because
  each looked at one context.
- **The next entry's input is not the block's output.** After a `.parallel()` or `.branch()`,
  Mastra hands the next entry a record keyed by *every declared arm*, each read from
  `stepResults` (`default.ts:1141-1149`) — so a skipped arm is present as `undefined`, or as a
  stale output if that step id ran earlier. The block's own output, which becomes the run's
  result when it is last, keeps only the arms that ran and succeeded.
- **The runner was bound at compile time**, so a compiled net was tied to one run, and the
  compile cache keyed by structural hash could not be sound.

## Decision

**A step routes every outcome to `ctx.exits`; the enclosing context chooses the exits.** The leaf
gadget declares one `xor` over `next` and the four exits, and the action writes exactly one. At
the top level the exits are the workflow's terminals. A combinator passes its own places and
settles every arm before deciding the block's outcome. `emitNested` requires all four exits, so a
combinator cannot inherit a destination it did not choose. `tripwire` is a field on the failure,
not a sixth outcome: Mastra carries it on the failure path everywhere and reclassifies it only in
`fmtReturnValue`.

**Five terminal places, each a declared sink** — `wf.done`, `wf.failed`, `wf.bailed`,
`wf.suspended`, `wf.paused`. They are separate places rather than one terminal with a status
field because the outcomes take separate paths, and a proof about one should not quietly cover
another: `wf.done` used to receive bailed runs too, so every proof about completion was narrower
than it read.

**Combinators do not nest.** Arms and bodies are `StepDescription`, as Mastra types them
(`SingleStepEntry`, `types.d.ts:577,583,601,619`). A nested workflow arrives as one step.

**A run carries its own scope**, handed to every firing through libpetri's
`executionContextProvider`: the runner, the workflow input, and the step results — Mastra's own
`stepResults`, latest outcome per id. The compiled net holds none of it, so one net serves every
run of its shape. Step results live beside the marking, never inside a `FlowToken`: the marking is
control state and the scope is data, so what a step returns cannot disturb a P-invariant over the
flow places. On a resume the scope is rehydrated from the same `WorkflowRunState` Mastra already
persists; nothing about the net is persisted separately.

**Retries are unrolled.** Attempt *i* is its own transition, so the retry ceiling is structure:
there is no budget place to seed with a multiplicity, and nothing to drain on success. The wait is
`delayed(d)`, which fails safe across a restore. A step with no retries emits one transition.

**Only a fixed `.sleep` is a timed transition; every other wait is an action.** libpetri timing
belongs to the transition, not to the token, and it is relative to enablement — `exact(t)` fires
`t` ms after the transition became enabled, not at epoch `t`. So a relative wait maps onto
`delayed(ms)`, and nothing else maps onto anything: a `.sleep(fn)` resolves its duration through
the runner, and a `.sleepUntil`, literal or per run, resolves its instant against the run's epoch
clock when it is reached, both waiting inside the action. Mastra's sleep is an in-process timer
with no resume path either, so an uncheckpointable in-flight wait costs nothing Mastra had.

*Amended M1:* the first version of this decision emitted `exact(epochMs)` for a literal
`.sleepUntil`, which waits about fifty-four years for a real date. An independent test of the leaf
against Mastra's semantics found it; the M1 first slice had carried the same mapping untested.

## Consequences

- The join a `.parallel()` or `.branch()` uses is no longer a pass-through of arm tokens: it reads
  the step results for the next entry's record and the arrivals for the block's own output. Both
  gadgets implement one shared join so the two blocks agree where Mastra's do.
- A combinator that drops an exit strands a token, and `classify()` reports it as residue — so a
  mis-routed outcome fails every `toEqual` assertion without a test opting in.
- Every step transition now declares five or six branches instead of two. The verifier sees that
  any step may suspend or bail, which is true of Mastra.
- `compile()` lost its `runner` option and `runWorkflow()` gained a required one. Every caller
  changed once.
- A per-run wait calls `Clock.sleep` from an action, outside the executor loop [TIME-015]
  specifies it for. A real clock is unaffected; a virtual clock that advances on every finite
  `sleep` can advance further than either overlapping wait alone. Recorded in
  `src/engine/scope.ts`.

## Evidence

`tests/compiler/leaf.test.ts` (routing of each outcome, unrolled retries in virtual time,
per-run waits), `tests/engine/residue.test.ts` (a second marked terminal is residue),
`tests/compiler/parallel.test.ts` and `tests/compiler/branch.test.ts` (lowest-index failure,
both value shapes, the stale-scope record), and `deadlockFree`, `terminatesAtSink` and `exactlyOneTerminal` proven with all five sinks
declared in `tests/verify/`. `tests/verify/linear-chain.test.ts` pins why the third exists: a step
reaching two terminals leaves the first two proven and only `exactlyOneTerminal` violated.
