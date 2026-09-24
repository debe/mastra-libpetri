import { describe, expect, it } from 'vitest';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { PetriExecutionEngine } from '../../src/mastra/engine.js';

/**
 * `docs/divergences.md` row 15. Mastra keeps a `.foreach()`'s options object **by reference**
 * (`workflow.ts:2629-2636`) so an agentic workflow can raise `concurrency` between runs. The engine
 * adapts the graph on every `execute()` and keys its compiled-net cache on the adapted description,
 * so a raised concurrency must compile a new net — measured here as items actually in flight at
 * once, not inferred from the cache.
 */
describe('a .foreach() concurrency raised between two runs of one workflow', () => {
  it('takes effect on the next run, on one engine instance', async () => {
    let inFlight = 0;
    let peak = 0;
    const item = createStep({
      id: 'item',
      inputSchema: z.number(),
      outputSchema: z.number(),
      execute: async ({ inputData }) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return inputData * 2;
      },
    });
    const opts = { concurrency: 1 };
    const engine = new PetriExecutionEngine();
    const workflow = createWorkflow({
      id: 'live-concurrency',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.number()),
      executionEngine: engine,
    })
      .foreach(item, opts)
      .commit();

    const first = await (await workflow.createRun()).start({ inputData: [1, 2, 3, 4] });
    expect(first.status).toBe('success');
    expect(peak).toBe(1);

    peak = 0;
    opts.concurrency = 3;
    const second = await (await workflow.createRun()).start({ inputData: [1, 2, 3, 4] });
    expect(second.status).toBe('success');
    expect(second.status === 'success' && second.result).toEqual([2, 4, 6, 8]);
    expect(peak).toBe(3);
  });
});
