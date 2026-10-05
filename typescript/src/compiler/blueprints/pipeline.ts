import type { Gadget } from '../gadgets/types.js';

/**
 * `pipeline()` ([ADR 0015], amended by the W0 spike): a `.foreach()` whose items run a chain of
 * stages, `c_j` lanes per stage, each item handed lane to lane — stage `j + 1` of one item runs
 * while stage `j` of another does. Host-free (an M10 candidate), as `firstKGadget` is; `foreachGadget`
 * delegates here when the entry carries a `pipeline`, as `parallelGadget` delegates to `firstKGadget`.
 *
 * The net is the ADR's (`PipelineSite` in `../types.ts` draws it): stage `j`, lane `l`, flattened
 * `L = Σ_{i<j} c_i + l`, names through `names.entryPlace` / `entryTransition(path, id,
 * 'stage{j}.lane{l}.*')`, each lane body `ctx.emitNested(stages[j], [...path, L], done, exits, {
 * viewPath, cancel: undefined, item: true })` viewed at the foreach's path; frame, cursor, complement
 * flags, settle and finisher factories shared with the foreach (`gadgets/foreach-frame.ts`); every
 * frame-writing transition and every hand-off inhibited by `wf.cancel`, a `drop` per lane exit; no
 * exit pair, no resume place, no window pool; every place 1-bounded, none carrying an inhibitor,
 * reset, `all()`, drain or `atLeast()` ([VER-004]: the only split stays `t.cancel.arrive`). Returns
 * one `PipelineSite` through `GadgetResult.pipelines` and registers no resume site.
 *
 * Throws, naming the foreach, on a description the adapter would have refused: no stages
 * (`pipeline-empty`), a bound not a whole number ≥ 1, a bound vector whose length is not `s`, Σc_j
 * above `MAX_FOREACH_LANES` or not equal to the entry's `concurrency` (`pipeline-value`).
 *
 * Contract stub (M7b W0): W1 A builds it. Reached only by a `.foreach()` carrying a `pipeline`, which
 * nothing can produce yet — `init().pipeline` is itself a stub.
 */
export const pipelineGadget: Gadget = (entry) => {
  throw new Error(`pipelineGadget('${entry.id}'): not implemented (M7b W1)`);
};
