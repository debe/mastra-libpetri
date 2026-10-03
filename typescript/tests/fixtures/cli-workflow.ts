/**
 * The CLI's end-to-end fixture: a module exporting two tiny petri workflows, one nested in the
 * other, and a `Mastra` instance registering the outer one — so `workflowsIn` sees each export
 * once, and the nested workflow is reached through the outer one's step flow.
 */
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import { init } from '../../src/mastra/init.js';

const num = z.object({ n: z.number() });
const { createWorkflow, createStep } = init({ concurrency: 2 });

const double = createStep({ id: 'double', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n * 2 }) });
const inc = createStep({ id: 'inc', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });

export const inner = createWorkflow({ id: 'cli-inner', inputSchema: num, outputSchema: num }).then(inc).commit();
export const outer = createWorkflow({ id: 'cli-outer', inputSchema: num, outputSchema: num })
  .then(double)
  .then(createStep(inner))
  .commit();

export const mastra = new Mastra({ workflows: { outer }, logger: false });

/** Not a workflow: ignored. */
export const unrelated = 42;
