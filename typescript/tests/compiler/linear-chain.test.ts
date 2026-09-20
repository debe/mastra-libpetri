import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { runWorkflow } from '../../src/engine/index.js';
import { RecordingRunner } from '../fixtures/runner.js';

const chain = {
  id: 'orders',
  entries: [
    { kind: 'step', id: 'validate' },
    { kind: 'step', id: 'charge' },
    { kind: 'step', id: 'ship' },
  ],
} as const;

describe('linear chain', () => {
  it('runs every step in order and carries data through', async () => {
    const runner = new RecordingRunner({
      validate: (input) => ({ status: 'success', output: `${input as string}+validated` }),
      charge: (input) => ({ status: 'success', output: `${input as string}+charged` }),
      ship: (input) => ({ status: 'success', output: `${input as string}+shipped` }),
    });

    const outcome = await runWorkflow(compile(chain, { runner }), 'order');

    expect(runner.calls).toEqual(['validate', 'charge', 'ship']);
    expect(outcome).toEqual({ status: 'success', output: 'order+validated+charged+shipped' });
  });

  it('routes a failed step to the failure terminal and stops the chain', async () => {
    const runner = new RecordingRunner({
      charge: () => ({ status: 'failed', error: 'card declined' }),
    });

    const outcome = await runWorkflow(compile(chain, { runner }), 'order');

    // `ship` never ran: the net's arcs stop it, not a check inside the engine.
    expect(runner.calls).toEqual(['validate', 'charge']);
    expect(outcome).toEqual({ status: 'failed', stepId: 'charge', error: 'card declined' });
  });

  it('treats a throwing runner as a failed step rather than a lost token', async () => {
    const boom = new Error('provider down');
    const runner = new RecordingRunner({
      validate: () => { throw boom; },
    });

    const outcome = await runWorkflow(compile(chain, { runner }), 'order');

    expect(outcome).toEqual({ status: 'failed', stepId: 'validate', error: boom });
  });

  it('hashes structure, not payloads', () => {
    const a = compile(chain, { runner: new RecordingRunner() });
    const b = compile(chain, { runner: new RecordingRunner() });
    const different = compile(
      { id: 'orders', entries: [{ kind: 'step', id: 'validate' }] },
      { runner: new RecordingRunner() },
    );

    expect(a.structuralHash).toBe(b.structuralHash);
    expect(a.structuralHash).not.toBe(different.structuralHash);
  });

  it('rejects an empty workflow rather than compiling a net that cannot start', () => {
    expect(() => compile({ id: 'empty', entries: [] }, { runner: new RecordingRunner() }))
      .toThrow(/no entries/);
  });
});
