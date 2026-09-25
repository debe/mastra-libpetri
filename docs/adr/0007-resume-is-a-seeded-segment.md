# ADR 0007 — A resume is a seeded, gated, separately proven segment of the same net

Status: accepted (2026-09-24)

## Context

Mastra resumes only a `suspended` run (`workflow.ts:4600-4608`), and resumes it **from records**:
`Run.resume` hands `execute()` the stored `stepResults`, the positional `resumePath`, the resume
data and the resumed step ids (`workflow.ts:4807-4828`), and the default engine continues from
`resumePath[0]` (`default.ts:792-808`). Inside a block it re-runs only the arm at the next path
index and rebuilds the block's outcome from the siblings' records (`handlers/entry.ts:350-392`); a
loop re-runs iteration *n* from the stored record's payload and count
(`handlers/control-flow.ts:726-790`); a foreach classifies every item from its records and skips
the ones that succeeded (`:1227-1270`); a nested workflow re-reads its own snapshot. Nothing about
the default engine's control state is persisted — the records are the state.

Three designs were drawn up independently and judged through three lenses (fidelity to Mastra,
provability and net design, cost and risk). Parking suspended work in the net and persisting a
libpetri marking snapshot scored lowest on fidelity: it cannot resume a run suspended under
Mastra's own engine, it adds a non-Mastra key to `WorkflowRunState`, and it would rewrite proven
gadgets. All three judges chose the design below, and none found a fatal flaw in it.

## Decision

**A resume is a new run segment of the same compiled net, seeded with exactly one token at a
registered resume site.** Nothing about the net is persisted; `WorkflowRunState` stays the only
record, so ADR 0003's rule holds and resume works across engines in both directions.

- **Sites.** A top-level step or loop resumes at its own input place, already gated and swept.
  Each `.parallel()` / `.branch()` arm and each `.foreach()` gets a `resume-*` place with a gate
  inhibited by the cancel signal and a sweep beside it — Mastra's check before each entry
  (`default.ts:815`) holds for a resumed segment too.
- **A block's interior is rebuilt by transitions, never written by hand.** Re-entering arm *j*
  emits the arm's stored input plus one `replay-i` token per sibling; each `replay-i` makes a
  decide-then-emit choice among exactly the arrivals a real collect produces (ok, suspended,
  failed, settled, skipped), and the block's unchanged join decides. Every count stays one token
  per named place ([IO-016]), and the value-blind verifier explores every sibling status from one
  seed.
- **The resumed attempt is marked by colour.** `FlowToken.resumed` marks the one attempt Mastra
  would feed the resume data to; no arc reads it. The runner hands that attempt the resume data and
  the stored suspend data, on Mastra's own `StepExecutor`.
- **No CORE-073 restore.** Clocks start fresh by construction, as in Mastra; no stale-name hazard;
  resuming under a different `concurrency` needs nothing special. libpetri 6.1.0 suffices.
- **Every site is proven as its own segment**, with and without a cancel: `resume@s` from
  `{site: 1, permits: k}` and `resume@s+cancel` from that plus `{wf.cancel.request: 1}`. This is
  CORE-073's sanctioned route for a restored marking: re-verify with it as the initial marking
  (libpetri `spec/01-core-model.md:748-755`). The proof and the kernel share one definition of
  those counts (`initialCounts` in `src/engine/kernel.ts`, which `segmentInitialMarking` calls),
  and the kernel refuses, before any executor exists, a run whose marking differs from it per
  place. A run that is not pre-aborted starts from exactly `resume@s`'s marking. A **pre-aborted**
  run starts from `{site: 1, wf.cancel: 1, permits: k}`. That is not `resume@s+cancel`'s marking.
  It is that marking's successor after `t.cancel.arrive` moves the request to the signal, so it is
  reachable from the proven marking and covered by its proof. The kernel checks an entry
  seed's colour (a non-null object with `data`), which the value-blind proofs cannot see; an arm or
  foreach seed that does not fit is refused by name by its own gate, as the block's `failed`
  outcome (`seedMisfit` in `reentry.ts` / `foreach.ts`; `tests/engine/kernel-resume.test.ts`,
  "a seed's colour"). The shared counts do not check k independently — both sides read the
  compiled budget — they refuse a start that collides with the permits or the cancel place. Structural checks make sure every construct that can suspend has a site, and that
  every site's sweep outputs only into `wf.canceled`, which no proof distinguishes from `wf.done`.
- **A failed firing ends the run.** A replay or gate whose action throws, or emits outside its
  `Out` spec, consumes its inputs and produces nothing. The proofs model the spec, not the
  action, so they stay proven. The kernel watches for `transition-failed` and ends the run at once
  as `stranded`, with the failed transition in `RunOutcome.failure` (`execute()`'s
  `StrandedRunError` names only the places so far; `TransitionFailure` keeps strings only, which
  is why a host precondition failure takes its own route, `HostPreconditionError`, row 84). Otherwise a run with a signal would wait at quiescence forever
  (`timeoutMs` is `null` under Mastra).

### Decisions taken

By the maintainer, 2026-09-24:
1. **M5 comes after M4**; restart and crash recovery follow as M4b.
2. **A changed workflow is refused by name**: when the step stored at the resume path is not the one
   compiled there, resume throws before persisting anything. Mastra resumes blindly (a divergence).
3. **Foreach resume is M4's last area**, refused by name until its proofs and three-lane timings
   are green.
4. **Resume data stays position-exact.** Mastra selects by step id, so a later step reusing the id
   also receives it with a stale input (a divergence).

By default, as the synthesis recommended: a bailed or paused sibling in a resumed block completes
the block (Mastra's unresumable dead end goes to the M9 upstream list); the loss of resume labels on
still-suspended arms is reproduced once a fixture confirms it; every site is proven by default, with
only large shapes in the slow lane; a resumed loop's allowance restarts at its bound; a nested
workflow inside a foreach stays refused until a real-Mastra fixture exists.

### Two corrections to the synthesis

- The decoder of Mastra's resume parameter lives in `src/mastra/resume-codec.ts`, not
  `src/codec/`: it reads Mastra's types, and only `src/mastra/` may ([ADR 0005]).
- `SuspendToken.suspendedAt` is optional in the type, always stamped by the leaf, so a hand-built
  token need not invent one; the codec falls back to the record's `suspendedAt`.

## Consequences

- A suspended block no longer drops its losing suspensions: the join carries them as `pending`, so
  the result and the snapshot name every suspended step (closes row 34).
- The gates are dead in a fresh segment and live only in a resumed one, so whole-workflow analysis
  in M6 is the union of the segments.
- A timed proof of a resumed segment is about that segment. An untimed one holds from the seeded
  marking and from every marking reachable from it, including a pre-aborted run's. The seeded
  marking is never claimed to be reachable from the fresh entry marking.

## Evidence

`tests/compiler/resume-seed.test.ts`, `tests/compiler/{parallel,branch,leaf,loop,foreach}-resume.test.ts`,
`tests/verify/resume-segments.test.ts`, `tests/engine/kernel-resume.test.ts`, `tests/mastra/engine-resume.test.ts`, and the differential's
suspend-then-resume driver on both engines and crossed, at every k.
