import { describe, expect, it } from 'vitest';
import { Marking, tokenOf } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { classify } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';
import type { FlowToken } from '../../src/compiler/types.js';
import type { RunOutcome } from '../../src/engine/index.js';

/** Reads the residue off an outcome without widening the union at each call site. */
function residueOf(outcome: RunOutcome): readonly string[] | undefined {
  return outcome.status === 'stranded' ? outcome.places : outcome.residue;
}

/**
 * Non-vacuity for the residue scan.
 *
 * An earlier `classify()` checked the terminals first and scanned for stray tokens only when
 * neither was marked, so a run that reached `wf.done` *and* stranded tokens reported a clean
 * success. These tests construct that exact combination by hand — it is the case the gadgets
 * are designed never to produce, which is precisely why no gadget test could cover it.
 */
describe('residue reporting', () => {
  const compiled = compile(
    { id: 'two-step', entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }] },
    { runner: new RecordingRunner() },
  );

  it('reports a stranded token alongside a success terminal', () => {
    const stray = [...compiled.net.places].find((p) => p.name.includes('.b.in'))!;
    const marking = Marking.from(
      new Map<never, never>([
        [compiled.donePlace, [tokenOf<FlowToken>({ data: 'ok' })]],
        [stray, [tokenOf<FlowToken>({ data: 'left behind' })]],
      ] as never),
    );

    const outcome = classify(compiled, marking);

    expect(outcome.status).toBe('success');
    // The point: the terminal did NOT mask the leak.
    expect(outcome).toHaveProperty('residue');
    expect(residueOf(outcome)).toEqual([stray.name]);
  });

  it('counts multiple tokens in one place rather than reporting it once', () => {
    const stray = [...compiled.net.places].find((p) => p.name.includes('.b.in'))!;
    const marking = Marking.from(
      new Map<never, never>([
        [compiled.donePlace, [tokenOf<FlowToken>({ data: 'ok' })]],
        [stray, [tokenOf<FlowToken>({ data: 1 }), tokenOf<FlowToken>({ data: 2 })]],
      ] as never),
    );

    expect(residueOf(classify(compiled, marking))).toEqual([`${stray.name}=2`]);
  });

  it('omits the residue key entirely on a clean run, so toEqual assertions stay terse', () => {
    const marking = Marking.from(
      new Map<never, never>([[compiled.donePlace, [tokenOf<FlowToken>({ data: 'ok' })]]] as never),
    );

    // A clean outcome has no `residue` key at all — which is what lets every other test in this
    // suite act as a leak detector without opting in.
    expect(classify(compiled, marking)).toEqual({ status: 'success', output: 'ok' });
  });

  it('does not count the terminals themselves as residue', () => {
    const marking = Marking.from(
      new Map<never, never>([
        [compiled.donePlace, [tokenOf<FlowToken>({ data: 'ok' })]],
        [compiled.failedPlace, [tokenOf({ stepId: 'a', error: 'boom' })]],
      ] as never),
    );

    const outcome = classify(compiled, marking);
    expect(outcome.status).toBe('failed');
    expect(outcome).not.toHaveProperty('residue');
  });
});
