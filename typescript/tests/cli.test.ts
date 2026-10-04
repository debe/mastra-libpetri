import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Z3Unavailable, type SmtVerificationResult } from 'libpetri/verification';
import {
  exitCodeFor,
  exitCodeForError,
  formatReport,
  main,
  parseCliArgs,
  reportJson,
  routeMix,
  UsageError,
  type NamedReport,
} from '../src/cli.js';
import { UnsupportedWorkflowError } from '../src/mastra/adapt.js';
import type { ClaimReport, VerificationReport } from '../src/verify/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('parseCliArgs', () => {
  it('reads every option', () => {
    expect(
      parseCliArgs(['verify', 'wf.ts', '--export', 'outer', '--concurrency', '2', '--iteration-bound', '5', '--timeout', '1000', '--families', 'completion,bounds', '--json']),
    ).toEqual({
      command: 'verify',
      modulePath: 'wf.ts',
      exportName: 'outer',
      concurrency: 2,
      iterationBound: 5,
      timeoutMs: 1000,
      families: ['completion', 'bounds'],
      json: true,
    });
  });

  it('omits what is not given', () => {
    expect(parseCliArgs(['verify', 'wf.ts'])).toEqual({ command: 'verify', modulePath: 'wf.ts', json: false });
  });

  it('answers --help', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['verify', '-h'])).toEqual({ command: 'help' });
  });

  it.each([
    [[], /missing command/],
    [['prove', 'wf.ts'], /unknown command 'prove'/],
    [['verify'], /missing <module-path>/],
    [['verify', 'a.ts', 'b.ts'], /unexpected argument: b.ts/],
    [['verify', 'wf.ts', '--concurrency', '0'], /--concurrency must be a positive whole number/],
    [['verify', 'wf.ts', '--concurrency', '1.5'], /--concurrency must be a positive whole number/],
    [['verify', 'wf.ts', '--timeout', 'soon'], /--timeout must be a positive whole number/],
    [['verify', 'wf.ts', '--families', 'completion,speed'], /unknown family speed/],
    [['verify', 'wf.ts', '--families', ','], /names no family/],
    [['verify', 'wf.ts', '--frobnicate'], /Unknown option/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

/** A result with only what the CLI reads. */
function result(verdict: SmtVerificationResult['verdict'], route: SmtVerificationResult['route'] = 'smt'): SmtVerificationResult {
  return {
    verdict,
    route,
    report: '',
    invariants: [],
    discoveredInvariants: [],
    counterexampleTrace: [],
    counterexampleTransitions: verdict.type === 'violated' ? ['t.start', 't.0.a.run'] : [],
    counterexampleConfirmed: verdict.type === 'violated' ? true : null,
    elapsedMs: 3,
    statistics: { places: 0, transitions: 0, invariantsFound: 0, structuralResult: '' },
  } as unknown as SmtVerificationResult;
}

const proven = { type: 'proven', method: 'test', inductiveInvariant: null } as unknown as SmtVerificationResult['verdict'];
const unknown = { type: 'unknown', reason: 'timeout' } as unknown as SmtVerificationResult['verdict'];
const violated = { type: 'violated' } as unknown as SmtVerificationResult['verdict'];

function claim(over: Partial<ClaimReport> & Pick<ClaimReport, 'result' | 'holds'>): ClaimReport {
  return { family: 'completion', kind: 'proof', property: 'deadlockFree', segment: 'closed', marking: '{s.0.a.in: 1}', ...over };
}

function report(claims: readonly ClaimReport[], over: Partial<VerificationReport> = {}): NamedReport {
  return {
    name: 'outer',
    report: {
      workflow: 'outer',
      k: 2,
      structuralHash: 'abc',
      segments: ['closed', 'cancel'],
      families: ['completion', 'liveness'],
      claims,
      unclaimed: [{ place: 's.1.f.acc', why: 'a foreach accumulates one token per item' }],
      unclaimedTargets: [],
      holds: claims.every((c) => c.holds),
      ...over,
    },
  };
}

const good = claim({ result: result(proven), holds: true });
const witness = claim({ family: 'liveness', kind: 'witness', property: 'live(t.0.a.run)', result: result(violated, 'enumeration'), holds: true });
const timedOut = claim({ result: result(unknown), holds: false });

describe('exit codes', () => {
  it('0 only when every claim of every workflow holds', () => {
    expect(exitCodeFor([report([good, witness]), report([good])])).toBe(0);
  });

  it('1 when a claim is unknown: a timeout is never a pass', () => {
    expect(exitCodeFor([report([good]), report([good, timedOut])])).toBe(1);
  });

  it('1 when a proof is violated', () => {
    expect(exitCodeFor([report([claim({ result: result(violated), holds: false })])])).toBe(1);
  });

  it('2 when a query had no route — no solver — and when there is nothing to verify', () => {
    expect(exitCodeFor([report([good, claim({ result: result(unknown, 'unavailable'), holds: false })])])).toBe(2);
    expect(exitCodeFor([])).toBe(2);
  });

  it('2 for a usage error, a missing z3 and an unsupported workflow; 1 for anything else', () => {
    expect(exitCodeForError(new UsageError('x'))).toBe(2);
    expect(exitCodeForError(new Z3Unavailable('no z3'))).toBe(2);
    expect(exitCodeForError(new UnsupportedWorkflowError('loop', 'l', 'no bound'))).toBe(2);
    expect(exitCodeForError(new Error('retry ceiling structure is unsound'))).toBe(1);
    expect(exitCodeForError('thrown string')).toBe(1);
  });
});

describe('formatting', () => {
  it('prints a line per failing claim, then the summary', () => {
    const text = formatReport(report([good, witness, timedOut]));
    const lines = text.split('\n');
    expect(lines[0]).toBe('FAILS completion: closed/deadlockFree: unknown via smt in 3ms (timeout) from {s.0.a.in: 1}');
    expect(lines[1]).toBe("FAILS workflow 'outer' [outer]: 2/3 claims hold");
    expect(text).toContain('  k: 2; structural hash: abc');
    expect(text).toContain('  segments (2): closed, cancel');
    expect(text).toContain('  routes: smt 2, enumeration 1');
    expect(text).toContain('    s.1.f.acc — a foreach accumulates one token per item');
  });

  it('names a nested workflow by its parent, and prints no claim line when all hold', () => {
    const text = formatReport({ ...report([good], { unclaimed: [] }), name: 'inner', nestedIn: 'outer' });
    expect(text.split('\n')[0]).toBe("HOLDS workflow 'inner' (nested in 'outer') [outer]: 1/1 claims hold");
    expect(text).toContain('  unclaimed places: none');
  });

  it('counts routes, most first', () => {
    expect(routeMix(report([good, good, witness]).report)).toBe('smt 2, enumeration 1');
    expect(routeMix(report([]).report)).toBe('none');
  });

  it('serialises a report without the raw solver result', () => {
    const json = reportJson(report([witness, timedOut])) as { claims: Record<string, unknown>[] };
    expect(json.claims[0]).toEqual({
      family: 'liveness', kind: 'witness', property: 'live(t.0.a.run)', segment: 'closed', marking: '{s.0.a.in: 1}',
      verdict: 'violated', route: 'enumeration', elapsedMs: 3, witness: ['t.start', 't.0.a.run'], holds: true,
    });
    expect(json.claims[1]).toMatchObject({ verdict: 'unknown', reason: 'timeout', holds: false });
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe('main, without a solver', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } };
  };

  it('exits 2 with the usage on a bad command line', async () => {
    const s = io();
    expect(await main(['verify'], s.io)).toBe(2);
    expect(s.err.join('\n')).toMatch(/missing <module-path>[\s\S]*usage: mastra-libpetri verify/);
  });

  it('exits 2 for a module that does not exist, or an export that is not there', async () => {
    const s = io();
    expect(await main(['verify', resolve(ROOT, 'tests/fixtures/nope.ts')], s.io)).toBe(2);
    expect(await main(['verify', resolve(ROOT, 'tests/fixtures/cli-workflow.ts'), '--export', 'missing'], s.io)).toBe(2);
    expect(await main(['verify', resolve(ROOT, 'tests/fixtures/cli-workflow.ts'), '--export', 'unrelated'], s.io)).toBe(2);
  });

  it('exits 0 for --help', async () => {
    const s = io();
    expect(await main(['--help'], s.io)).toBe(0);
    expect(s.out[0]).toMatch(/^usage: mastra-libpetri verify/);
  });
});

describe('the CLI, end to end', () => {
  const run = (args: readonly string[]) =>
    spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

  it('verifies every workflow of a module and exits 0 when every claim holds', () => {
    const r = run(['verify', 'tests/fixtures/cli-workflow.ts']);
    expect(r.stderr).toBe('');
    expect(r.status, r.stdout).toBe(0);
    // `outer` once, though exported and registered; `inner` once, as nested, though exported too.
    expect(r.stdout).toMatch(/^HOLDS workflow 'outer' \[cli-outer\]: (\d+)\/\1 claims hold$/m);
    expect(r.stdout).not.toMatch(/^HOLDS workflow 'inner'/m);
    expect(r.stdout).toMatch(/^HOLDS workflow 'cli-inner' \(nested in 'outer'\) \[cli-inner\]: (\d+)\/\1 claims hold$/m);
    expect(r.stdout).toContain('  k: 2;');
    expect(r.stdout).not.toMatch(/^FAILS/m);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('every claim of 2 workflow(s) holds');
  });

  it('exits 2 on a usage error', () => {
    const r = run(['verify', 'tests/fixtures/cli-workflow.ts', '--concurrency', 'many']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--concurrency must be a positive whole number');
  }, 60_000);
});
