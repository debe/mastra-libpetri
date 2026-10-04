import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No gadget reads the abort signal ([ADR 0004], CLAUDE.md: cancellation is structural).
 *
 * The one time an action did — an action-side sleep deciding "was I cut short?" from
 * `scope.signal.aborted` — the value-blind verifier found `wf.canceled` reachable in a run no
 * cancel reaches, and `neverCanceled` was violated. Whether work starts, and where a cut-short wait
 * goes, is decided by arcs on `wf.cancel`. A gadget may *pass* the signal on (a step's own
 * `abortSignal` is the runner's business, through `viewOf`); it may not branch on it. This guard
 * keeps that out of review's hands.
 *
 * One pass-through is allowed by name: the leaf hands a timed attempt's `deadline.signal` to the
 * runner ([ADR 0013]). That is the attempt's own deadline, not the run's abort, and the leaf decides
 * the timeout from the deadline's `expired` promise into an output branch the net already has.
 */
const SIGNAL_READ = /\.signal\b|\.aborted\b|abortSignal/g;

describe('source guard: gadgets never read the abort signal', () => {
  const dir = join(import.meta.dirname, '../../src/compiler/gadgets');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('finds the gadget sources', () => {
    expect(files).toEqual(expect.arrayContaining(['leaf.ts', 'parallel.ts', 'branch.ts', 'loop.ts', 'foreach.ts']));
  });

  it.each(files)('%s has no signal read outside comments', (file) => {
    const code = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code.replace(/\bdeadline\.signal\b/g, '').match(SIGNAL_READ) ?? []).toEqual([]);
  });

  it('would catch the defect it guards against', () => {
    const offending = 'if (scope.signal.aborted) { tctx.output(canceled, x); }';
    expect(offending.match(SIGNAL_READ)).not.toBeNull();
    // The deadline allowance covers that exact pass-through, not the run's signal beside it.
    expect('deadline.signal; scope.signal'.replace(/\bdeadline\.signal\b/g, '').match(SIGNAL_READ)).not.toBeNull();
  });
});
