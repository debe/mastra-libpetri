import { describe, expect, it } from 'vitest';
import { place } from 'libpetri';
import {
  compile,
  foreachSeed,
  resumeSeed,
  stepGadget,
  UnresumablePositionError,
  type Gadget,
} from '../../src/compiler/index.js';
import type {
  ArmResume,
  ArmSite,
  CompiledWorkflow,
  EntryDescription,
  ForeachResume,
  ForeachSite,
  ResumeSite,
  StepDescription,
  StepRecord,
  WorkflowDescription,
} from '../../src/compiler/types.js';
import type { ResumeRequest } from '../../src/compiler/resume.js';
import { cancelStructureViolations, describeReport, verifyWorkflow, type PropertyReport } from '../../src/verify/index.js';

/**
 * `resumeSeed` ([ADR 0007], contract C7) and the entry sites `compile` registers (C9), tested against
 * Mastra's resume protocol as its source states it:
 *
 * - `workflow.ts:4807-4828`, `default.ts:792-808`: a resume continues from `resumePath[0]` with the
 *   stored `stepResults`; `resumePath = suspendedPaths[steps[0]]`, keyed by the stored step id.
 * - `handlers/entry.ts:111-128,306-316`: the resumed step's input is its STORED `payload`.
 * - `handlers/control-flow.ts:726-790`: a loop body suspends under the body's id at the loop's own
 *   top-level index, and the loop re-reads the body record to restart iteration n.
 * - `handlers/entry.ts:38-109,350-509`: inside a block only the resumed arm runs; the siblings'
 *   records are replayed; a `.branch()` ignores arms with no record (`onlyExecutedSteps`).
 *
 * Pure function tests: nothing runs. The one proof block shows a composite with every entry-site
 * kind proven in every segment — fresh and resumed at each site, with and without a cancel — and its
 * structure clean.
 */

const step = (id: string, extra: Omit<StepDescription, 'kind' | 'id'> = {}): StepDescription => ({ kind: 'step', id, ...extra });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'resume', entries });
const loop = (id: string, body: StepDescription): EntryDescription => ({
  kind: 'loop',
  id,
  body,
  loopType: 'dowhile',
  iterationBound: 2,
});

const request = (
  path: readonly number[],
  steps: readonly string[],
  records: Readonly<Record<string, StepRecord>>,
  forEachIndex?: number,
): ResumeRequest => ({
  path,
  steps,
  records: new Map(Object.entries(records)),
  ...(forEachIndex === undefined ? {} : { forEachIndex }),
});

const suspended = (payload: unknown, extra: Partial<StepRecord> = {}): StepRecord =>
  ({ status: 'suspended', suspendPayload: { ask: payload }, payload, startedAt: 10, suspendedAt: 20, ...extra }) as StepRecord;
const success = (payload: unknown, output: unknown): StepRecord => ({ status: 'success', output, payload, startedAt: 1, endedAt: 2 });

/** Catches the refusal and returns it, so a test can assert reason, path and message whole. */
function refusal(fn: () => unknown): UnresumablePositionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnresumablePositionError);
    return error as UnresumablePositionError;
  }
  throw new Error('expected an UnresumablePositionError, and nothing was thrown');
}

/**
 * The arm and foreach sites belong to the block and foreach gadgets (W2, W4). Until they register
 * theirs, this adds a site for every arm or foreach that has none, exactly as the contract types
 * describe them; once they do, their own sites are used untouched.
 */
function withGadgetSites(compiled: CompiledWorkflow, description: WorkflowDescription): CompiledWorkflow {
  const sites = new Map<string, ResumeSite>(compiled.resumeSites);
  description.entries.forEach((entry, i) => {
    if (entry.kind === 'parallel' || entry.kind === 'branch') {
      entry.arms.forEach((arm, a) => {
        const key = `${i}.${a}`;
        if (sites.has(key)) return;
        const site: ArmSite = { kind: 'arm', block: entry.kind as 'parallel' | 'branch', path: [i, a], stepId: arm.id, place: place<ArmResume>(`test.resume.${key}`) };
        sites.set(key, site);
      });
    }
    if (entry.kind === 'foreach' && !sites.has(String(i))) {
      const site: ForeachSite = { kind: 'foreach', path: [i], stepId: entry.body.id, place: place<ForeachResume>(`test.resume.${i}`) };
      sites.set(String(i), site);
    }
  });
  return { ...compiled, resumeSites: sites };
}

// ---------------------------------------------------------------------------------------------
// C9 — compile registers an entry site for every top-level step and loop
// ---------------------------------------------------------------------------------------------

describe('compile: entry sites', () => {
  const description = wf(
    step('a'),
    { kind: 'sleep', id: 'nap', duration: { fixed: 5 } },
    step('child', { source: 'workflow' }),
    loop('poll', step('tick')),
    { kind: 'sleepUntil', id: 'later', until: { perRun: true } },
  );
  const compiled = compile(description);

  it('registers a step, a nested workflow and a loop at their own input place, and a sleep nowhere', () => {
    const entrySites = [...compiled.resumeSites.entries()].map(([key, site]) => [
      key,
      site.kind,
      site.path,
      site.stepId,
      site.kind === 'entry' ? site.construct : undefined,
    ]);
    expect(entrySites.sort()).toStrictEqual([
      ['0', 'entry', [0], 'a', 'step'],
      ['2', 'entry', [2], 'child', 'step'],
      ['3', 'entry', [3], 'tick', 'loop'],
    ]);
    // The site is the entry's own input place — gated and swept already, nothing added.
    expect(compiled.resumeSites.get('0')?.place).toBe(compiled.entryPlace);
    for (const [key, site] of compiled.resumeSites) {
      expect(compiled.net.places.has(site.place), key).toBe(true);
      expect(compiled.netMap.placeToEntry.get(site.place.name)?.path, key).toStrictEqual(site.path);
    }
  });

  it('maps every top-level path to its entry', () => {
    expect([...compiled.netMap.pathToEntry.entries()].sort()).toStrictEqual([
      ['0', { entryId: 'a', kind: 'step' }],
      ['1', { entryId: 'nap', kind: 'sleep' }],
      ['2', { entryId: 'child', kind: 'step' }],
      ['3', { entryId: 'poll', kind: 'loop' }],
      ['4', { entryId: 'later', kind: 'sleepUntil' }],
    ]);
  });

  it('refuses two sites at one path', () => {
    // A step gadget that also claims its own path collides with the entry site compile registers.
    const claiming: Gadget = (entry, next, ctx) => {
      const result = stepGadget(entry, next, ctx);
      return {
        ...result,
        resumeSites: [{ kind: 'entry', path: [0], stepId: entry.id, construct: 'step', place: result.inPlace }],
      };
    };
    expect(() => compile(wf(step('a')), { gadgets: { step: claiming } })).toThrow('two resume sites at path 0');
  });

  it('a step, a nested workflow and a loop: every segment proven, fresh and resumed, with and without a cancel', async () => {
    // Proven: deadlockFree, terminatesAtSink, exactlyOneTerminal (+ neverCanceled with no cancel),
    // permitsBounded and permitsReturned at k = 2, from each segment's initial marking —
    // {entry: 1, permits: 2} (closed), plus {cancel.request: 1} (cancel), and {site: 1, permits: 2}
    // [+ {cancel.request: 1}] for each of the three entry sites; closed net, whichever route the
    // verifier takes (the fixed sleep is timed). Structure checks run first inside verifyWorkflow.
    const composite = compile(
      wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 5 } }, step('child', { source: 'workflow' }), loop('poll', step('tick'))),
      { concurrency: 2 },
    );
    expect([...composite.resumeSites.keys()].sort()).toStrictEqual(['0', '2', '3']);
    expect(cancelStructureViolations(composite)).toStrictEqual([]);
    const reports = await verifyWorkflow(composite, { timeoutMs: 120_000 });
    const key = (r: PropertyReport) => `${String(r.segment)}/${r.property}`;
    const props = (segment: string, cancel: boolean) => [
      `${segment}/deadlockFree`, `${segment}/terminatesAtSink`, `${segment}/exactlyOneTerminal`,
      ...(cancel ? [] : [`${segment}/neverCanceled`]),
      `${segment}/permitsBounded`, `${segment}/permitsReturned`,
    ];
    expect(reports.map(key)).toStrictEqual([
      ...props('closed', false),
      ...props('cancel', true),
      ...['0', '2', '3'].flatMap((site) => [...props(`resume@${site}`, false), ...props(`resume@${site}+cancel`, true)]),
    ]);
    for (const report of reports) expect(report.result.verdict.type, describeReport(report)).toBe('proven');
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------
// C7 — entry seeds
// ---------------------------------------------------------------------------------------------

describe('resumeSeed: entry', () => {
  const compiled = compile(wf(step('a'), step('b'), step('child', { source: 'workflow' }), loop('poll', step('tick'))));

  it('seeds a top-level step with its stored payload, flagged as the resumed attempt', () => {
    const seed = resumeSeed(compiled, request([1], ['b'], { a: success('in', 'A'), b: suspended('A') }));
    expect(seed.site).toBe(compiled.resumeSites.get('1'));
    expect(seed.value).toStrictEqual({ data: 'A', resumed: true });
  });

  it('seeds a nested workflow at its own position; the inner ids are the runner\'s, not the net\'s', () => {
    const seed = resumeSeed(compiled, request([2], ['child', 'inner'], { child: suspended({ n: 1 }) }));
    expect(seed.site).toBe(compiled.resumeSites.get('2'));
    expect(seed.value).toStrictEqual({ data: { n: 1 }, resumed: true });
  });

  it('seeds a loop at its input place under the body id; the payload is the stored iteration input', () => {
    const body = suspended(7, { metadata: { iterationCount: 3 } });
    const seed = resumeSeed(compiled, request([3], ['tick'], { tick: body }));
    expect(seed.site).toMatchObject({ kind: 'entry', construct: 'loop', stepId: 'tick', path: [3] });
    expect(seed.value).toStrictEqual({ data: 7, resumed: true });
  });

  it('takes the stored payload whatever the record status (Run, not the engine, checks "was not suspended")', () => {
    const seed = resumeSeed(compiled, request([0], ['a'], { a: success('stored', 'out') }));
    expect(seed.value).toStrictEqual({ data: 'stored', resumed: true });
  });
});

// ---------------------------------------------------------------------------------------------
// C7 — arm seeds: one verdict per stored sibling status
// ---------------------------------------------------------------------------------------------

const block = (kind: 'parallel' | 'branch') => wf(step('pre'), { kind, id: 'blk', arms: [step('p'), step('q'), step('r')] }, step('post'));
const armCompiled = (kind: 'parallel' | 'branch') => withGadgetSites(compile(block(kind)), block(kind));

describe('resumeSeed: parallel arm', () => {
  const compiled = armCompiled('parallel');
  const seedAt = (records: Record<string, StepRecord>) => resumeSeed(compiled, request([1, 1], ['q'], records));

  it('seeds the resumed arm\'s stored input; a success sibling replays as ok with its stored output', () => {
    const seed = seedAt({ p: success('x', 'P'), q: suspended('x'), r: success('x', 'R') });
    expect(seed.site).toBe(compiled.resumeSites.get('1.1'));
    expect(seed.value).toStrictEqual({
      data: 'x',
      siblings: [
        { kind: 'ok', index: 0, output: 'P' },
        { kind: 'ok', index: 2, output: 'R' },
      ],
    });
  });

  it('a suspended sibling replays as a suspension at its arm path, with its suspend payload and time', () => {
    const seed = seedAt({ p: suspended('x', { suspendedAt: 33 }), q: suspended('x'), r: success('x', 'R') });
    expect((seed.value as ArmResume).siblings[0]).toStrictEqual({
      kind: 'suspended',
      index: 0,
      token: { stepId: 'p', path: [1, 0], payload: { ask: 'x' }, suspendedAt: 33 },
    });
  });

  it('a suspended sibling with no stored time carries none', () => {
    const { suspendedAt: _drop, ...noTime } = suspended('x') as StepRecord & { suspendedAt?: number };
    const seed = seedAt({ p: noTime as StepRecord, q: suspended('x'), r: success('x', 'R') });
    expect((seed.value as ArmResume).siblings[0]).toStrictEqual({
      kind: 'suspended',
      index: 0,
      token: { stepId: 'p', path: [1, 0], payload: { ask: 'x' } },
    });
  });

  it('a failed sibling (a stale record, row 33) replays as a failure with its error, tripwire and class', () => {
    const failed: StepRecord = { status: 'failed', error: 'boom', tripwire: { reason: 't' }, nonRetryable: true, payload: 'x', startedAt: 1, endedAt: 2 };
    const seed = seedAt({ p: success('x', 'P'), q: suspended('x'), r: failed });
    expect((seed.value as ArmResume).siblings[1]).toStrictEqual({
      kind: 'failed',
      index: 2,
      token: { stepId: 'r', path: [1, 2], stepPayload: 'x', error: 'boom', tripwire: { reason: 't' }, nonRetryable: true },
    });
  });

  it('a plain failed sibling carries no tripwire and no retry class', () => {
    const seed = seedAt({ p: { status: 'failed', error: 'e', payload: 'x' }, q: suspended('x'), r: success('x', 'R') });
    expect((seed.value as ArmResume).siblings[0]).toStrictEqual({
      kind: 'failed',
      index: 0,
      token: { stepId: 'p', path: [1, 0], stepPayload: 'x', error: 'e' },
    });
  });

  it('a bailed sibling replays as settled', () => {
    const seed = seedAt({ p: { status: 'bailed', output: 'B', payload: 'x' }, q: suspended('x'), r: success('x', 'R') });
    expect((seed.value as ArmResume).siblings[0]).toStrictEqual({ kind: 'settled', index: 0 });
  });

  it('a paused sibling replays as settled', () => {
    const seed = seedAt({ p: success('x', 'P'), q: suspended('x'), r: { status: 'paused', payload: 'x' } });
    expect((seed.value as ArmResume).siblings[1]).toStrictEqual({ kind: 'settled', index: 2 });
  });

  it('refuses a sibling with no record as unsupported: every parallel arm ran', () => {
    const e = refusal(() => seedAt({ p: success('x', 'P'), q: suspended('x') }));
    expect(e.reason).toBe('unsupported');
    expect(e.path).toStrictEqual([1, 1]);
    expect(e.message).toContain("sibling 'r' at [1, 2] has no stored record");
  });

  it('refuses a sibling whose stored record is canceled (only a loop or foreach writes it)', () => {
    const e = refusal(() => seedAt({ p: { status: 'canceled' }, q: suspended('x'), r: success('x', 'R') }));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toContain("'canceled' record");
  });

  it('refuses a sibling whose stored record is waiting (only a sleep writes it)', () => {
    const e = refusal(() => seedAt({ p: success('x', 'P'), q: suspended('x'), r: { status: 'waiting', payload: 'x' } }));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toContain("'waiting' record");
  });

  it('resumes the first and the last arm with every other arm as a sibling, in arm order', () => {
    const records = { p: suspended('x'), q: success('x', 'Q'), r: suspended('y') };
    const first = resumeSeed(compiled, request([1, 0], ['p'], records)).value as ArmResume;
    expect(first.siblings.map((s) => s.index)).toStrictEqual([1, 2]);
    const last = resumeSeed(compiled, request([1, 2], ['r'], records)).value as ArmResume;
    expect(last.data).toBe('y');
    expect(last.siblings.map((s) => s.index)).toStrictEqual([0, 1]);
  });
});

describe('resumeSeed: the arm sites of one block are a compiler invariant', () => {
  // A gap or a mix of block kinds is a compiler defect, not a stored shape: a plain Error, not a
  // refusal the engine would turn into UnsupportedRunModeError.
  const base = armCompiled('parallel');
  const records = { p: suspended('x'), q: success('x', 'Q'), r: success('x', 'R') };
  const armSite = (index: number, kind: 'parallel' | 'branch', stepId: string): ArmSite => ({
    kind: 'arm',
    block: kind,
    path: [1, index],
    stepId,
    place: place<ArmResume>(`test.gap.${kind}.${index}`),
  });
  const withArmSites = (arms: readonly ArmSite[]): CompiledWorkflow => {
    const sites = new Map<string, ResumeSite>([...base.resumeSites].filter(([, s]) => !(s.kind === 'arm' && s.path[0] === 1)));
    for (const arm of arms) sites.set(arm.path.join('.'), arm);
    return { ...base, resumeSites: sites };
  };

  it('a block whose arm sites skip an index (1.0 and 1.2 only) throws', () => {
    const gapped = withArmSites([armSite(0, 'parallel', 'p'), armSite(2, 'parallel', 'r')]);
    let thrown: unknown;
    try {
      resumeSeed(gapped, request([1, 0], ['p'], records));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnresumablePositionError);
    expect((thrown as Error).message).toBe('the arm sites of the block at [1] are not one parallel with arms 0..n-1');
  });

  it('a block whose arm sites mix block kinds throws', () => {
    const mixed = withArmSites([armSite(0, 'parallel', 'p'), armSite(1, 'branch', 'q'), armSite(2, 'parallel', 'r')]);
    expect(() => resumeSeed(mixed, request([1, 0], ['p'], records))).toThrow(
      new Error('the arm sites of the block at [1] are not one parallel with arms 0..n-1'),
    );
  });

  it('the same three sites, contiguous and of one kind, seed', () => {
    const whole = withArmSites([armSite(0, 'parallel', 'p'), armSite(1, 'parallel', 'q'), armSite(2, 'parallel', 'r')]);
    expect(resumeSeed(whole, request([1, 0], ['p'], records)).value).toStrictEqual({
      data: 'x',
      siblings: [
        { kind: 'ok', index: 1, output: 'Q' },
        { kind: 'ok', index: 2, output: 'R' },
      ],
    });
  });
});

describe('resumeSeed: branch arm', () => {
  const compiled = armCompiled('branch');

  it('a sibling with no record replays as skipped: its condition was not truthy', () => {
    const seed = resumeSeed(compiled, request([1, 2], ['r'], { p: success('x', 'P'), r: suspended('x') }));
    expect(seed.site).toBe(compiled.resumeSites.get('1.2'));
    expect(seed.value).toStrictEqual({
      data: 'x',
      siblings: [
        { kind: 'ok', index: 0, output: 'P' },
        { kind: 'skipped', index: 1 },
      ],
    });
  });

  it('a stale record under a sibling\'s id counts as having run, as in Mastra (row 33)', () => {
    const seed = resumeSeed(compiled, request([1, 0], ['p'], { p: suspended('x'), q: success('old', 'stale'), r: suspended('x') }));
    expect((seed.value as ArmResume).siblings).toStrictEqual([
      { kind: 'ok', index: 1, output: 'stale' },
      { kind: 'suspended', index: 2, token: { stepId: 'r', path: [1, 2], payload: { ask: 'x' }, suspendedAt: 20 } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// C7 — refusals, one per reason
// ---------------------------------------------------------------------------------------------

describe('resumeSeed: refusals', () => {
  const description = wf(step('a'), { kind: 'sleep', id: 'nap', duration: { fixed: 1 } }, { kind: 'parallel', id: 'fan', arms: [step('x'), step('y')] });
  const compiled = withGadgetSites(compile(description), description);

  it('no-site: a path past the last entry', () => {
    const e = refusal(() => resumeSeed(compiled, request([7], ['a'], { a: suspended(1) })));
    expect(e.reason).toBe('no-site');
    expect(e.path).toStrictEqual([7]);
    expect(e.message).toBe('nothing resumable at [7]: the workflow has no entry at [7]');
  });

  it('no-site: a sleep, which never suspends', () => {
    const e = refusal(() => resumeSeed(compiled, request([1], ['nap'], {})));
    expect(e.reason).toBe('no-site');
    expect(e.message).toBe("nothing resumable at [1]: the workflow has the sleep 'nap' at [1]");
  });

  it('no-site: a block named without its arm', () => {
    const e = refusal(() => resumeSeed(compiled, request([2], ['x'], { x: suspended(1) })));
    expect(e.reason).toBe('no-site');
    expect(e.message).toBe("nothing resumable at [2]: the workflow has the parallel 'fan' at [2]");
  });

  it('no-site: an empty path', () => {
    const e = refusal(() => resumeSeed(compiled, request([], ['a'], {})));
    expect(e.reason).toBe('no-site');
    expect(e.path).toStrictEqual([]);
  });

  it('id-mismatch at an entry: the workflow changed since the run suspended (maintainer decision 2)', () => {
    const e = refusal(() => resumeSeed(compiled, request([0], ['renamed'], { renamed: suspended(1) })));
    expect(e.reason).toBe('id-mismatch');
    expect(e.path).toStrictEqual([0]);
    expect(e.message).toBe(
      "the step stored at [0] is 'renamed', but the workflow now has 'a' there: the workflow changed since the run suspended",
    );
  });

  it('id-mismatch at an arm', () => {
    const e = refusal(() => resumeSeed(compiled, request([2, 1], ['x'], { x: suspended(1), y: suspended(1) })));
    expect(e.reason).toBe('id-mismatch');
    expect(e.path).toStrictEqual([2, 1]);
  });

  it('id-mismatch at a loop: the loop id is not what Mastra stores, the body id is', () => {
    const looped = compile(wf(loop('poll', step('tick'))));
    const e = refusal(() => resumeSeed(looped, request([0], ['poll'], { poll: suspended(1) })));
    expect(e.reason).toBe('id-mismatch');
  });

  it('unsupported: a resume that names no step', () => {
    const e = refusal(() => resumeSeed(compiled, request([0], [], { a: suspended(1) })));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toBe('a resume at [0] names no step');
  });

  it('unsupported: the resumed step has no stored record, so no stored input', () => {
    const e = refusal(() => resumeSeed(compiled, request([0], ['a'], {})));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toBe("no stored input for step 'a' at [0]: its record is missing");
  });

  it('unsupported: the resumed arm has no stored record', () => {
    const e = refusal(() => resumeSeed(compiled, request([2, 0], ['x'], { y: suspended(1) })));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toBe("no stored input for step 'x' at [2, 0]: its record is missing");
  });

  it('unsupported: the resumed step\'s record carries no payload', () => {
    const e = refusal(() => resumeSeed(compiled, request([0], ['a'], { a: { status: 'canceled' } })));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toBe("no stored input for step 'a' at [0]: its record is 'canceled' with no payload");
  });
});

// ---------------------------------------------------------------------------------------------
// C7 — foreach, delegated to foreachSeed (W4 lands last; maintainer decision 3)
// ---------------------------------------------------------------------------------------------

describe('resumeSeed: foreach', () => {
  const description = wf(step('a'), { kind: 'foreach', id: 'each', body: step('item'), concurrency: 2 });
  const compiled = withGadgetSites(compile(description), description);
  const aggregate = suspended([1, 2, 3]);

  it('foreach-nested: a nested workflow as the body is refused by name', () => {
    const e = refusal(() => resumeSeed(compiled, request([1], ['item', 'inner'], { item: aggregate }, 1)));
    expect(e.reason).toBe('foreach-nested');
    expect(e.path).toStrictEqual([1]);
  });

  it('unsupported: the foreach step has no stored aggregate record', () => {
    const e = refusal(() => resumeSeed(compiled, request([1], ['item'], {})));
    expect(e.reason).toBe('unsupported');
    expect(e.message).toBe("no stored record for the .foreach() step 'item' at [1]");
  });

  it('delegates to foreachSeed: the seed is exactly its value, at the site the gadget registered', () => {
    const site = compiled.resumeSites.get('1') as ForeachSite;
    const records = new Map<string, StepRecord>([['item', aggregate]]);
    const direct = foreachSeed(site, aggregate, records, 1);
    const seed = resumeSeed(compiled, request([1], ['item'], { item: aggregate }, 1));
    expect(seed.site).toBe(site);
    expect(seed.value).toStrictEqual(direct);
    // No stored foreachOutput: every item is queued, the named one resumed.
    expect(seed.value).toStrictEqual({ items: [1, 2, 3], order: [{ index: 0 }, { index: 1, resumed: true }, { index: 2 }], done: [], parked: [] });
  });

  it('a step body registers a site with no nested flag', () => {
    expect(compiled.resumeSites.get('1')).not.toHaveProperty('nested');
  });

  it('foreach-nested: a nested-workflow body is refused even when resume.steps holds its id alone', () => {
    // Mastra accepts `step: 'child'` for a nested body as ['child'] (workflow.ts:4613-4618,
    // 4661-4665) and then resumes the child the aggregate names, not the item (row 77).
    const nested = wf(step('a'), { kind: 'foreach', id: 'each', body: step('child', { source: 'workflow' }), concurrency: 2 });
    const nestedCompiled = compile(nested);
    const site = nestedCompiled.resumeSites.get('1') as ForeachSite;
    expect(site).toMatchObject({ kind: 'foreach', path: [1], stepId: 'child', nested: true });
    const e = refusal(() => resumeSeed(nestedCompiled, request([1], ['child'], { child: suspended([1, 2]) }, 0)));
    expect(e.reason).toBe('foreach-nested');
    expect(e.path).toStrictEqual([1]);
    expect(e.message).toBe("resume inside the nested workflow 'child' run by the .foreach() at [1] is not supported");
  });
});
