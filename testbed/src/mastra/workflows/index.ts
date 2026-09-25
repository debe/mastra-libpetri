import { z } from 'zod';
import { createStep, createWorkflow } from '../petri.js';

/**
 * Representative workflows, one per control-flow shape the engine compiles: linear, parallel,
 * branch, loop, foreach, sleep and suspend/resume. Each step waits a little (`PACE_MS`) so a run's
 * progress is visible in Studio and its marking in the debug UI; set `TESTBED_PACE_MS=0` to run flat out,
 * and `TESTBED_SLEEP_MS` to change the `sleep` workflow's wait.
 */
const PACE_MS = Number(process.env.TESTBED_PACE_MS ?? 400);
const SLEEP_MS = Number(process.env.TESTBED_SLEEP_MS ?? 3000);
const pace = (ms = PACE_MS) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const num = z.object({ n: z.number() });

const add = <Id extends string>(id: Id, k: number) =>
  createStep({
    id,
    description: `adds ${k}`,
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData }) => {
      await pace();
      return { n: inputData.n + k };
    },
  });

const double = createStep({
  id: 'double',
  description: 'doubles n',
  inputSchema: num,
  outputSchema: num,
  execute: async ({ inputData }) => {
    await pace();
    return { n: inputData.n * 2 };
  },
});

// ---- linear: a -> b -> c -------------------------------------------------------------------

export const linearWorkflow = createWorkflow({
  id: 'linear',
  description: 'Three steps in sequence.',
  inputSchema: num,
  outputSchema: num,
})
  .then(add('add-one', 1))
  .then(double)
  .then(add('add-ten', 10))
  .commit();

// ---- parallel: three arms, joined -----------------------------------------------------------

const arm = <Id extends string>(id: Id, ms: number) =>
  createStep({
    id,
    description: `waits ${ms} ms`,
    inputSchema: num,
    outputSchema: num,
    execute: async ({ inputData }) => {
      await pace(ms);
      return { n: inputData.n + ms };
    },
  });

const join = createStep({
  id: 'join',
  inputSchema: z.object({ fast: num, medium: num, slow: num }),
  outputSchema: num,
  execute: async ({ inputData }) => ({ n: inputData.fast.n + inputData.medium.n + inputData.slow.n }),
});

export const parallelWorkflow = createWorkflow({
  id: 'parallel',
  description: 'Three arms of different lengths run at once, then join.',
  inputSchema: num,
  outputSchema: num,
})
  .parallel([arm('fast', 300), arm('medium', 900), arm('slow', 1500)])
  .then(join)
  .commit();

// ---- branch: small or large -----------------------------------------------------------------

const small = createStep({
  id: 'small',
  inputSchema: num,
  outputSchema: z.object({ label: z.string() }),
  execute: async ({ inputData }) => {
    await pace();
    return { label: `${inputData.n} is small` };
  },
});
const large = createStep({
  id: 'large',
  inputSchema: num,
  outputSchema: z.object({ label: z.string() }),
  execute: async ({ inputData }) => {
    await pace();
    return { label: `${inputData.n} is large` };
  },
});

export const branchWorkflow = createWorkflow({
  id: 'branch',
  description: 'Takes the small arm below 10, the large arm otherwise.',
  inputSchema: num,
  outputSchema: z.object({ small: z.object({ label: z.string() }).optional(), large: z.object({ label: z.string() }).optional() }),
})
  .branch([
    [async ({ inputData }) => inputData.n < 10, small],
    [async ({ inputData }) => inputData.n >= 10, large],
  ])
  .commit();

// ---- loop: increment until 5 ----------------------------------------------------------------

export const loopWorkflow = createWorkflow({
  id: 'loop',
  description: 'Increments n until it reaches 5 (do-until).',
  inputSchema: num,
  outputSchema: num,
})
  .dountil(add('increment', 1), async ({ inputData }) => inputData.n >= 5)
  .commit();

// ---- foreach: square each item, two at a time -----------------------------------------------

const square = createStep({
  id: 'square',
  inputSchema: z.number(),
  outputSchema: z.number(),
  execute: async ({ inputData }) => {
    await pace();
    return inputData * inputData;
  },
});

export const foreachWorkflow = createWorkflow({
  id: 'foreach',
  description: 'Squares each item of the input, two at a time.',
  inputSchema: z.array(z.number()),
  outputSchema: z.array(z.number()),
})
  .foreach(square, { concurrency: 2 })
  .commit();

// ---- sleep: a timed wait between two steps --------------------------------------------------

export const sleepWorkflow = createWorkflow({
  id: 'sleep',
  description: `A step, a ${SLEEP_MS} ms sleep, a step.`,
  inputSchema: num,
  outputSchema: num,
})
  .then(add('before-sleep', 1))
  .sleep(SLEEP_MS)
  .then(add('after-sleep', 100))
  .commit();

// ---- suspend / resume: an approval gate -----------------------------------------------------

const prepare = add('prepare', 1);

const approve = createStep({
  id: 'approve',
  description: 'Suspends until resumed with { approved: true }.',
  inputSchema: num,
  outputSchema: z.object({ n: z.number(), approvedBy: z.string() }),
  resumeSchema: z.object({ approved: z.boolean(), by: z.string().default('someone') }),
  suspendSchema: z.object({ question: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData?.approved !== true) return suspend({ question: `approve n = ${inputData.n}?` });
    return { n: inputData.n, approvedBy: resumeData.by };
  },
});

const finish = createStep({
  id: 'finish',
  inputSchema: z.object({ n: z.number(), approvedBy: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async ({ inputData }) => {
    await pace();
    return { summary: `n = ${inputData.n}, approved by ${inputData.approvedBy}` };
  },
});

export const approvalWorkflow = createWorkflow({
  id: 'approval',
  description: 'Suspends for approval, then finishes on resume.',
  inputSchema: num,
  outputSchema: z.object({ summary: z.string() }),
})
  .then(prepare)
  .then(approve)
  .then(finish)
  .commit();

export const workflows = {
  linear: linearWorkflow,
  parallel: parallelWorkflow,
  branch: branchWorkflow,
  loop: loopWorkflow,
  foreach: foreachWorkflow,
  sleep: sleepWorkflow,
  approval: approvalWorkflow,
};
