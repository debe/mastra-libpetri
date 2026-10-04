import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { UnrestartablePositionError, restartSeed, type RestartRequest } from '../../src/compiler/restart.js';
import type { CompiledWorkflow, EntryDescription } from '../../src/compiler/types.js';

/**
 * `restartSeed` ([ADR 0010]): where a restart continues, decoded from Mastra's stored `activePaths`.
 * `p = activePaths[0]`; a deeper path `[i, j]` — a row from Mastra's own engine, inside a block —
 * re-runs entry `i` whole; anything that names no top-level boundary is refused as `no-position`,
 * naming the path, before anything runs. Pure: the request is never mutated.
 */

const entries: readonly EntryDescription[] = [
  { kind: 'step', id: 'a' },
  { kind: 'parallel', id: 'fan', arms: [{ kind: 'step', id: 'x' }, { kind: 'step', id: 'y' }] },
  { kind: 'step', id: 'z' },
];
const compiled: CompiledWorkflow = compile({ id: 'w', entries });
const request = (activePaths: readonly number[], input: unknown = { v: 1 }): RestartRequest => ({
  activePaths: Object.freeze([...activePaths]),
  records: new Map(),
  input,
});

describe('restartSeed', () => {
  it.each([0, 1, 2])('[%i] seeds one FlowToken at boundary %i', (p) => {
    const input = { at: p };
    const seed = restartSeed(compiled, request([p], input));
    expect(seed.site).toBe(compiled.boundaries[p]);
    expect(seed.site.index).toBe(p);
    // Exactly `{data}`: never `resumed`, no foreach index, no iteration — entry p re-runs from its start.
    expect(seed.value).toStrictEqual({ data: input });
    expect(seed.value.data).toBe(input);
  });

  it('[0] is the entry place: no checkpoint taken restarts the whole run on the stored input', () => {
    expect(restartSeed(compiled, request([0])).site.place).toBe(compiled.entryPlace);
  });

  it('a deeper path [i, j] maps to the boundary of entry i', () => {
    expect(restartSeed(compiled, request([1, 0])).site).toBe(compiled.boundaries[1]);
    expect(restartSeed(compiled, request([1, 1, 3])).site).toBe(compiled.boundaries[1]);
  });

  it('does not mutate the request (Mastra consumes activePaths with shift())', () => {
    const r = request([1, 0]);
    restartSeed(compiled, r);
    expect(r.activePaths).toEqual([1, 0]);
  });

  it.each([
    ['empty', [], /the stored activePaths \[\] name no position to restart from/],
    ['negative', [-1], /the stored activePaths \[-1\] start at -1, which is not a top-level index/],
    ['non-integer', [1.5], /the stored activePaths \[1\.5\] start at 1\.5, which is not a top-level index/],
    ['NaN', [Number.NaN], /start at NaN, which is not a top-level index/],
    ['past the last entry', [3], /the stored activePaths \[3\] start at 3, and the workflow has no top-level boundary there \(entries 0\.\.2\)/],
    ['past the last entry, deeper', [7, 0], /the stored activePaths \[7, 0\] start at 7/],
  ] as const)('refuses %s as no-position, naming the path', (_label, path, message) => {
    let thrown: unknown;
    try {
      restartSeed(compiled, request(path));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnrestartablePositionError);
    const e = thrown as UnrestartablePositionError;
    expect(e.name).toBe('UnrestartablePositionError');
    expect(e.reason).toBe('no-position');
    expect(e.path).toEqual(path);
    expect(e.message).toMatch(message);
    expect(e.message).toContain("workflow 'w'");
  });
});
