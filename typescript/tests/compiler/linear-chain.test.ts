import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow, runWorkflowDetailed } from '../../src/engine/index.js';
import type { WorkflowDescription } from '../../src/compiler/types.js';
import { RecordingRunner, type Behaviour } from '../fixtures/runner.js';

const chain: WorkflowDescription = {
  id: 'orders',
  entries: [
    { kind: 'step', id: 'validate' },
    { kind: 'step', id: 'charge' },
    { kind: 'step', id: 'ship' },
  ],
};

const appending = (suffix: string): Behaviour => (input) => ({ status: 'success', output: `${input as string}+${suffix}` });

describe('linear chain', () => {
  it('runs every step in order and carries data through', async () => {
    const runner = new RecordingRunner({
      steps: { validate: appending('validated'), charge: appending('charged'), ship: appending('shipped') },
    });

    const outcome = await runWorkflow(compile(chain), 'order', { runner });

    expect(runner.calls).toEqual(['validate', 'charge', 'ship']);
    expect(outcome).toEqual({ status: 'success', output: 'order+validated+charged+shipped' });
  });

  it('routes a failed step to the failure terminal and stops the chain', async () => {
    const runner = new RecordingRunner({
      steps: { charge: () => ({ status: 'failed', error: 'card declined' }) },
    });

    const outcome = await runWorkflow(compile(chain), 'order', { runner });

    // `ship` never ran: the net's arcs stop it, not a check inside the engine.
    expect(runner.calls).toEqual(['validate', 'charge']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: 'card declined' });
  });

  it('treats a throwing runner as a failed step rather than a lost token', async () => {
    const boom = new Error('provider down');
    const runner = new RecordingRunner({
      steps: {
        validate: () => {
          throw boom;
        },
      },
    });

    const outcome = await runWorkflow(compile(chain), 'order', { runner });

    expect(runner.calls).toEqual(['validate']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'validate', error: boom });
  });

  it('treats an unrecognised runner result as a failed step', async () => {
    const runner = new RecordingRunner({
      steps: { charge: () => ({ status: 'done', output: 1 }) as never },
    });

    const outcome = await runWorkflow(compile(chain), 'order', { runner });

    expect(outcome).toEqual({
      status: 'failed',
      stepId: 'charge',
      error: expect.objectContaining({ message: expect.stringMatching(/unrecognised outcome for step 'charge'/) }),
    });
    expect(runner.calls).toEqual(['validate', 'charge']);
  });

  it('serves many runs from one compiled net, each with its own runner and step results', async () => {
    // `compile` takes no runner: the net is a function of the description alone, which is what
    // makes a compile cache keyed on `structuralHash` sound.
    const compiled = compile(chain);
    const left = new RecordingRunner({ steps: { charge: appending('visa') } });
    const right = new RecordingRunner({ steps: { charge: () => ({ status: 'failed', error: 'declined' }) } });

    const [a, b] = await Promise.all([
      runWorkflowDetailed(compiled, 'L', { runner: left }),
      runWorkflowDetailed(compiled, 'R', { runner: right }),
    ]);

    expect(a.outcome).toEqual({ status: 'success', output: 'L+visa' });
    expect(b.outcome).toEqual({ status: 'failed', stepId: 'charge', error: 'declined' });
    expect(left.calls).toEqual(['validate', 'charge', 'ship']);
    expect(right.calls).toEqual(['validate', 'charge']);
    expect([...a.stepResults.keys()]).toEqual(['validate', 'charge', 'ship']);
    expect(b.stepResults.get('charge')).toEqual({ status: 'failed', error: 'declined' });
    expect(b.stepResults.has('ship')).toBe(false);
  });

  it('keys step results by id without touching the prototype, even for __proto__ and constructor', async () => {
    // Behaviours built with Object.fromEntries, so both ids are own keys of the map.
    const steps: Record<string, Behaviour> = Object.fromEntries([
      ['__proto__', appending('p')],
      ['constructor', appending('c')],
    ]);
    const runner = new RecordingRunner({ steps });

    const { outcome, stepResults } = await runWorkflowDetailed(
      compile({ id: 'proto', entries: [{ kind: 'step', id: '__proto__' }, { kind: 'step', id: 'constructor' }] }),
      'x',
      { runner },
    );

    expect(outcome).toEqual({ status: 'success', output: 'x+p+c' });
    expect([...stepResults]).toEqual([
      ['__proto__', { status: 'success', output: 'x+p' }],
      ['constructor', { status: 'success', output: 'x+p+c' }],
    ]);
  });

  it('relates every transition and input place back to the entry that emitted it', () => {
    const { netMap, entryPlace } = compile(chain);

    expect(entryPlace.name).toBe('s.0.validate.in');
    // Map equality is order-insensitive, so this does not pin the right-to-left emission order.
    expect(netMap.transitionToEntry).toEqual(
      new Map([
        ['t.0.validate.run', { path: [0], id: 'validate' }],
        ['t.1.charge.run', { path: [1], id: 'charge' }],
        ['t.2.ship.run', { path: [2], id: 'ship' }],
      ]),
    );
    expect(netMap.placeToEntry.get('s.1.charge.in')).toEqual({ path: [1], id: 'charge' });
  });

  it('hashes structure, not payloads', () => {
    const a = compile(chain);
    const b = compile({ ...chain, entries: chain.entries.map((e) => ({ ...e })) });
    const different = compile({ id: 'orders', entries: [{ kind: 'step', id: 'validate' }] });

    expect(a.structuralHash).toBe(b.structuralHash);
    expect(a.structuralHash).not.toBe(different.structuralHash);
  });

  it('rejects an empty workflow rather than compiling a net that cannot start', () => {
    expect(() => compile({ id: 'empty', entries: [] })).toThrow(/no entries/);
  });
});
