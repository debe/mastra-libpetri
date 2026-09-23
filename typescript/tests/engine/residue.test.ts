import { describe, expect, it } from 'vitest';
import { Marking, tokenOf, type Place, type Token } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { classify } from '../../src/engine/index.js';
import type {
  BailToken,
  CanceledToken,
  FailureToken,
  FlowToken,
  PauseToken,
  SuspendToken,
} from '../../src/compiler/types.js';
import type { RunOutcome } from '../../src/engine/index.js';

/** Reads the residue off an outcome without widening the union at each call site. */
function residueOf(outcome: RunOutcome): readonly string[] | undefined {
  return outcome.status === 'stranded' ? outcome.places : outcome.residue;
}

/** A marking built by hand: each place with the values of its tokens, in order. */
function markingOf(...entries: readonly (readonly [Place<unknown>, readonly unknown[]])[]): Marking {
  return Marking.from(
    new Map<Place<unknown>, Token<unknown>[]>(entries.map(([p, values]) => [p, values.map((v) => tokenOf(v))])),
  );
}

/**
 * Non-vacuity for the residue scan.
 *
 * An earlier `classify()` checked the terminals first and scanned for stray tokens only when
 * neither was marked, so a run that reached `wf.done` *and* stranded tokens reported a clean
 * success. These tests construct those markings by hand — they are the cases the gadgets are
 * designed never to produce, which is precisely why no gadget test could cover them.
 */
describe('residue reporting', () => {
  const compiled = compile({ id: 'two-step', entries: [{ kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }] });
  const { terminals } = compiled;
  const stray = [...compiled.net.places].find((p) => p.name === 's.1.b.in')!;

  const done: FlowToken = { data: 'ok' };
  const failure: FailureToken = { stepId: 'a', path: [0], error: 'boom' };
  const suspension: SuspendToken = { stepId: 'b', path: [1], payload: { ask: 'approve' } };
  const pause: PauseToken = { stepId: 'b', path: [1] };
  const bail: BailToken = { stepId: 'a', path: [0], output: 'early' };
  const cancellation: CanceledToken = { origin: { stepId: 'b', path: [1] } };

  it('finds the stray place it is about to mark', () => {
    expect(stray).toBeDefined();
  });

  it('reports a stranded token alongside a success terminal', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done]], [stray, [{ data: 'left behind' }]]));

    // The point: the terminal did NOT mask the leak.
    expect(outcome).toEqual({ status: 'success', output: 'ok', residue: [stray.name] });
  });

  it('counts multiple tokens in one place rather than reporting it once', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done]], [stray, [{ data: 1 }, { data: 2 }]]));

    expect(residueOf(outcome)).toEqual([`${stray.name}=2`]);
  });

  it('omits the residue key entirely on a clean run, so toEqual assertions stay terse', () => {
    // A clean outcome has no `residue` key at all — which is what lets every other test in this
    // suite act as a leak detector without opting in.
    const outcome = classify(compiled, markingOf([terminals.done, [done]]));

    expect(outcome).toEqual({ status: 'success', output: 'ok' });
    expect(outcome).not.toHaveProperty('residue');
  });

  it.each([
    ['done', () => terminals.done, done, { status: 'success', output: 'ok' }],
    ['bailed', () => terminals.bailed, bail, { status: 'success', output: 'early', bailed: true }],
    ['failed', () => terminals.failed, failure, { status: 'failed', stepId: 'a', path: [0], error: 'boom' }],
    [
      'failed with a tripwire',
      () => terminals.failed,
      { stepId: 'a', path: [0], error: new Error('blocked'), tripwire: { reason: 'blocked' } } satisfies FailureToken,
      { status: 'tripwire', stepId: 'a', path: [0], tripwire: { reason: 'blocked' } },
    ],
    [
      'suspended',
      () => terminals.suspended,
      suspension,
      { status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'approve' } },
    ],
    ['paused', () => terminals.paused, pause, { status: 'paused', stepId: 'b', path: [1] }],
    ['canceled', () => terminals.canceled, cancellation, { status: 'canceled', origin: { stepId: 'b', path: [1] } }],
    ['canceled with no origin', () => terminals.canceled, {} satisfies CanceledToken, { status: 'canceled' }],
    [
      'canceled from a foreach item',
      () => terminals.canceled,
      { origin: { stepId: 'b', path: [1], foreachIndex: 4 } } satisfies CanceledToken,
      { status: 'canceled', origin: { stepId: 'b', path: [1], foreachIndex: 4 } },
    ],
  ] as const)('classifies a lone token in the %s terminal cleanly', (_name, terminal, value, expected) => {
    expect(classify(compiled, markingOf([terminal() as Place<unknown>, [value]]))).toEqual(expected);
  });

  it.each([
    [
      'failed',
      () => terminals.failed,
      { stepId: 'b', path: [1], foreachIndex: 2, error: 'e' } satisfies FailureToken,
      { status: 'failed', stepId: 'b', path: [1], foreachIndex: 2, error: 'e' },
    ],
    [
      'tripwire',
      () => terminals.failed,
      { stepId: 'b', path: [1], foreachIndex: 2, error: 'e', tripwire: { reason: 'r' } } satisfies FailureToken,
      { status: 'tripwire', stepId: 'b', path: [1], foreachIndex: 2, tripwire: { reason: 'r' } },
    ],
    [
      'suspended',
      () => terminals.suspended,
      { stepId: 'b', path: [1], foreachIndex: 0, payload: 'p' } satisfies SuspendToken,
      { status: 'suspended', stepId: 'b', path: [1], foreachIndex: 0, payload: 'p' },
    ],
    [
      'paused',
      () => terminals.paused,
      { stepId: 'b', path: [1], foreachIndex: 3 } satisfies PauseToken,
      { status: 'paused', stepId: 'b', path: [1], foreachIndex: 3 },
    ],
  ] as const)('a %s outcome carries the full origin, foreachIndex included (0 too)', (_name, terminal, value, expected) => {
    // What the codec needs to write the snapshot's paths; an index of 0 is an index.
    expect(classify(compiled, markingOf([terminal() as Place<unknown>, [value]]))).toEqual(expected);
  });

  it('keeps nothing but the origin from an exit token: no stray fields reach the outcome', () => {
    const noisy = { stepId: 'a', path: [0], error: 'e', nonRetryable: true, extra: 'x' };
    expect(classify(compiled, markingOf([terminals.failed, [noisy]]))).toEqual({ status: 'failed', stepId: 'a', path: [0], error: 'e' });
  });

  it('reports a pending cancel request as residue: the request is work, only the delivered signal is not', () => {
    expect(classify(compiled, markingOf([terminals.done, [done]], [compiled.cancelRequest, [null]]))).toEqual({
      status: 'success',
      output: 'ok',
      residue: ['wf.cancel.request'],
    });
  });

  it('reports a SECOND marked terminal as residue: every entry ends in exactly one outcome', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done]], [terminals.failed, [failure]]));

    expect(outcome).toEqual({ status: 'failed', stepId: 'a', path: [0], error: 'boom', residue: ['wf.done'] });
  });

  it('reports a second token in the reported terminal as residue', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done, { data: 'again' }]]));

    // The first token is the result; the terminal's own count is decremented by exactly one.
    expect(outcome).toEqual({ status: 'success', output: 'ok', residue: ['wf.done'] });
  });

  it('reports a bail and a completion together as a bail with wf.done as residue', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done]], [terminals.bailed, [bail]]));

    expect(outcome).toEqual({ status: 'success', output: 'early', bailed: true, residue: ['wf.done'] });
  });

  it('picks a fixed precedence among terminals and reports every loser as residue', () => {
    const all = markingOf(
      [terminals.done, [done]],
      [terminals.bailed, [bail]],
      [terminals.paused, [pause]],
      [terminals.suspended, [suspension]],
      [terminals.failed, [failure]],
    );

    // failed > suspended > paused > bailed > done; the losers, sorted.
    expect(classify(compiled, all)).toEqual({
      status: 'failed',
      stepId: 'a',
      path: [0],
      error: 'boom',
      residue: ['wf.bailed', 'wf.done', 'wf.paused', 'wf.suspended'],
    });
    expect(
      classify(compiled, markingOf([terminals.suspended, [suspension]], [terminals.paused, [pause]])),
    ).toEqual({ status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'approve' }, residue: ['wf.paused'] });
    expect(classify(compiled, markingOf([terminals.paused, [pause]], [terminals.bailed, [bail]]))).toEqual({
      status: 'paused',
      stepId: 'b',
      path: [1],
      residue: ['wf.bailed'],
    });
  });

  describe('with cancellation', () => {
    it('puts canceled above every other terminal, as entry.ts:815-817 re-stamps any result', () => {
      const all = markingOf(
        [terminals.done, [done]],
        [terminals.bailed, [bail]],
        [terminals.paused, [pause]],
        [terminals.suspended, [suspension]],
        [terminals.failed, [failure]],
        [terminals.canceled, [cancellation]],
        [compiled.cancel, [null]],
      );

      // canceled > failed > suspended > paused > bailed > done; the losers, sorted — and never the
      // cancel place, which is the environment's signal, not work left behind.
      expect(classify(compiled, all)).toEqual({
        status: 'canceled',
        origin: { stepId: 'b', path: [1] },
        residue: ['wf.bailed', 'wf.done', 'wf.failed', 'wf.paused', 'wf.suspended'],
      });
      expect(classify(compiled, markingOf([terminals.canceled, [{}]], [terminals.done, [done]]))).toEqual({
        status: 'canceled',
        residue: ['wf.done'],
      });
    });

    it('excludes the marked cancel place from residue, beside any terminal', () => {
      expect(classify(compiled, markingOf([terminals.done, [done]], [compiled.cancel, [null]]))).toEqual({
        status: 'success',
        output: 'ok',
      });
      expect(classify(compiled, markingOf([terminals.canceled, [cancellation]], [compiled.cancel, [null]]))).toEqual({
        status: 'canceled',
        origin: { stepId: 'b', path: [1] },
      });
      expect(classify(compiled, markingOf([terminals.failed, [failure]], [compiled.cancel, [null]]))).toEqual({
        status: 'failed',
        stepId: 'a',
        path: [0],
        error: 'boom',
      });
    });

    it('excludes the cancel place even when it holds more than one token', () => {
      // `bounded(1)` in the verifier and a `once` listener in the kernel keep it at one; the
      // classifier does not depend on that.
      expect(classify(compiled, markingOf([terminals.done, [done]], [compiled.cancel, [null, null]]))).toEqual({
        status: 'success',
        output: 'ok',
      });
    });

    it('still reports real residue beside a canceled terminal and a marked cancel place', () => {
      expect(
        classify(compiled, markingOf([terminals.canceled, [cancellation]], [compiled.cancel, [null]], [stray, [{ data: 1 }]])),
      ).toEqual({ status: 'canceled', origin: { stepId: 'b', path: [1] }, residue: [stray.name] });
    });

    it('reports a second canceled token as residue', () => {
      expect(classify(compiled, markingOf([terminals.canceled, [cancellation, {}]]))).toEqual({
        status: 'canceled',
        origin: { stepId: 'b', path: [1] },
        residue: ['wf.canceled'],
      });
    });

    it('reports a marked cancel place with no terminal as stranded with nothing named', () => {
      // A run whose signal fired and that reached no terminal: the cancel place is not work, so
      // the stranded list is empty rather than naming it.
      expect(classify(compiled, markingOf([compiled.cancel, [null]]))).toEqual({ status: 'stranded', places: [] });
      expect(classify(compiled, markingOf([compiled.cancel, [null]], [stray, [{ data: 1 }]]))).toEqual({
        status: 'stranded',
        places: [stray.name],
      });
    });

    it('the cancel place is the net\'s own, named wf.cancel, and not a terminal', () => {
      expect(compiled.cancel.name).toBe('wf.cancel');
      expect([...compiled.net.places]).toContain(compiled.cancel);
      expect(Object.values(terminals)).not.toContain(compiled.cancel);
    });
  });

  it('reports a marking with no terminal as stranded, naming every marked place', () => {
    expect(classify(compiled, markingOf([stray, [{ data: 1 }]]))).toEqual({ status: 'stranded', places: [stray.name] });
    expect(classify(compiled, Marking.empty())).toEqual({ status: 'stranded', places: [] });
  });
});
