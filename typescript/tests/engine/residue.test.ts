import { describe, expect, it } from 'vitest';
import { Marking, tokenOf, type Place, type Token } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import { classify } from '../../src/engine/index.js';
import type {
  BailToken,
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
  const failure: FailureToken = { stepId: 'a', error: 'boom' };
  const suspension: SuspendToken = { stepId: 'b', path: [1], payload: { ask: 'approve' }, output: 'partial' };
  const pause: PauseToken = { stepId: 'b', path: [1] };
  const bail: BailToken = { stepId: 'a', output: 'early' };

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
    ['failed', () => terminals.failed, failure, { status: 'failed', stepId: 'a', error: 'boom' }],
    [
      'failed with a tripwire',
      () => terminals.failed,
      { stepId: 'a', error: new Error('blocked'), tripwire: { reason: 'blocked' } } satisfies FailureToken,
      { status: 'tripwire', stepId: 'a', tripwire: { reason: 'blocked' } },
    ],
    [
      'suspended',
      () => terminals.suspended,
      suspension,
      { status: 'suspended', stepId: 'b', path: [1], payload: { ask: 'approve' } },
    ],
    ['paused', () => terminals.paused, pause, { status: 'paused', stepId: 'b', path: [1] }],
  ] as const)('classifies a lone token in the %s terminal cleanly', (_name, terminal, value, expected) => {
    expect(classify(compiled, markingOf([terminal() as Place<unknown>, [value]]))).toEqual(expected);
  });

  it('reports a SECOND marked terminal as residue: every entry ends in exactly one outcome', () => {
    const outcome = classify(compiled, markingOf([terminals.done, [done]], [terminals.failed, [failure]]));

    expect(outcome).toEqual({ status: 'failed', stepId: 'a', error: 'boom', residue: ['wf.done'] });
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

  it('reports a marking with no terminal as stranded, naming every marked place', () => {
    expect(classify(compiled, markingOf([stray, [{ data: 1 }]]))).toEqual({ status: 'stranded', places: [stray.name] });
    expect(classify(compiled, Marking.empty())).toEqual({ status: 'stranded', places: [] });
  });
});
