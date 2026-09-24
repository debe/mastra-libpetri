import type { Clock } from 'libpetri';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '@mastra/core/mastra';
import {
  createStep as mastraCreateStep,
  createWorkflow as mastraCreateWorkflow,
  Workflow,
  type DefaultEngineType,
  type Step,
} from '@mastra/core/workflows';
import {
  init,
  PETRI_ENGINE_TYPE,
  PetriExecutionEngine,
  type PetriEngineType,
  type PetriStep,
} from '../../src/mastra/index.js';
import * as root from '../../src/index.js';

// ---------------------------------------------------------------------------------------------
// One workflow shape, built with Mastra's factories and with init()'s. The default engine is the
// oracle for the runtime half.
// ---------------------------------------------------------------------------------------------

const num = z.object({ n: z.number() });
const seen = z.object({ seen: z.array(z.string()).optional() });

const aParams = {
  id: 'a' as const,
  inputSchema: num,
  outputSchema: num,
  stateSchema: seen,
  execute: async ({ inputData, state, setState }: {
    inputData: { n: number };
    state: { seen?: string[] | undefined };
    setState: (s: { seen?: string[] | undefined }) => Promise<void>;
  }) => {
    await setState({ ...state, seen: [...(state.seen ?? []), 'a'] });
    return { n: inputData.n + 1 };
  },
};
const bParams = {
  id: 'b' as const,
  inputSchema: num,
  outputSchema: num,
  stateSchema: seen,
  execute: async ({ inputData, state, setState }: {
    inputData: { n: number };
    state: { seen?: string[] | undefined };
    setState: (s: { seen?: string[] | undefined }) => Promise<void>;
  }) => {
    await setState({ ...state, seen: [...(state.seen ?? []), 'b'] });
    return { n: inputData.n * 10 };
  },
};

function defaultLinear() {
  return mastraCreateWorkflow({ id: 'linear', inputSchema: num, outputSchema: num, stateSchema: seen })
    .then(mastraCreateStep(aParams))
    .then(mastraCreateStep(bParams))
    .commit();
}

function petriLinear(options: Parameters<typeof init>[0] = {}, workflowOptions: object = {}) {
  const { createWorkflow, createStep } = init(options);
  return createWorkflow({ id: 'linear', inputSchema: num, outputSchema: num, stateSchema: seen, options: workflowOptions })
    .then(createStep(aParams))
    .then(createStep(bParams))
    .commit();
}

/** The engine Mastra's `Workflow` holds; `executionEngine` is `protected` on the class. */
function engineOf(workflow: object): unknown {
  return (workflow as { executionEngine?: unknown }).executionEngine;
}

type StepView = { status?: unknown; output?: unknown };

describe('init() — runtime', () => {
  it('an init()-built workflow runs on the petri engine, end to end, and agrees with the default engine', async () => {
    const petri = petriLinear();
    expect(engineOf(petri)).toBeInstanceOf(PetriExecutionEngine);
    expect(engineOf(defaultLinear())).not.toBeInstanceOf(PetriExecutionEngine);

    const execute = vi.spyOn(engineOf(petri) as PetriExecutionEngine, 'execute');
    const got = await (await petri.createRun()).start({ inputData: { n: 1 }, outputOptions: { includeState: true } });
    const want = await (await defaultLinear().createRun()).start({ inputData: { n: 1 }, outputOptions: { includeState: true } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(got.status).toBe('success');
    expect(got.status).toBe(want.status);
    if (got.status !== 'success' || want.status !== 'success') throw new Error('unreachable');
    expect(got.result).toEqual({ n: 20 });
    expect(got.result).toEqual(want.result);
    expect(got.state).toEqual(want.state);
    const outputs = (steps: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, (s as StepView).status === undefined ? s : [(s as StepView).status, (s as StepView).output]]));
    expect(outputs(got.steps)).toEqual(outputs(want.steps));
  });

  it("hands the engine the workflow's own options, the object Mastra gives its default engine", async () => {
    const onFinish = vi.fn();
    const petri = petriLinear({}, { validateInputs: false, onFinish });
    const engine = engineOf(petri) as PetriExecutionEngine;
    expect(engine.options).toBe(petri.options);
    expect(engine.options.validateInputs).toBe(false);

    await (await petri.createRun()).start({ inputData: { n: 1 } });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0]).toMatchObject({ status: 'success', result: { n: 20 } });
  });

  it('builds a fresh engine per workflow', () => {
    const { createWorkflow } = init({ iterationBound: 7 });
    const one = createWorkflow({ id: 'one', inputSchema: num, outputSchema: num });
    const two = createWorkflow({ id: 'two', inputSchema: num, outputSchema: num });
    expect(engineOf(one)).toBeInstanceOf(PetriExecutionEngine);
    expect(engineOf(one)).not.toBe(engineOf(two));
    expect(one).toBeInstanceOf(Workflow);
  });

  /** `.dountil` that stops once n reaches 3: three iterations, within a bound of 5. */
  function counting(options: Parameters<typeof init>[0]) {
    const { createWorkflow, createStep } = init(options);
    const inc = createStep({ id: 'inc', inputSchema: num, outputSchema: num, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
    return createWorkflow({ id: 'counting', inputSchema: num, outputSchema: num })
      .dountil(inc, async ({ inputData }) => inputData.n >= 3)
      .commit();
  }

  it("forwards init()'s iterationBound into the engine: a .dountil with a bound of 5 runs to its condition", async () => {
    const got = await (await counting({ iterationBound: 5 }).createRun()).start({ inputData: { n: 0 } });
    expect(got.status).toBe('success');
    if (got.status !== 'success') throw new Error('unreachable');
    expect(got.result).toEqual({ n: 3 });
  });

  it('without an iterationBound the same .dountil is refused: start() rejects (docs/divergences.md row 13)', async () => {
    const run = await counting({}).createRun();
    await expect(run.start({ inputData: { n: 0 } })).rejects.toThrow(/iterationBound/);
  });

  it("forwards createWorkflow({ mastra }) into the engine: step code sees that Mastra", async () => {
    const { createWorkflow, createStep } = init();
    const mastra = new Mastra({ logger: false });
    const seenBy: unknown[] = [];
    const s = createStep({
      id: 's',
      inputSchema: num,
      outputSchema: num,
      execute: async ({ inputData, mastra: m }) => {
        seenBy.push(m);
        return inputData;
      },
    });
    const wf = createWorkflow({ id: 'with-mastra', inputSchema: num, outputSchema: num, mastra }).then(s).commit();
    expect((engineOf(wf) as PetriExecutionEngine).mastra).toBe(mastra);
    const got = await (await wf.createRun()).start({ inputData: { n: 1 } });
    expect(got.status).toBe('success');
    expect(seenBy).toEqual([mastra]);
  });

  it("marks the workflow's engineType, so Mastra refuses restart() by name instead of running it", async () => {
    const petri = petriLinear();
    expect(petri.engineType).toBe(PETRI_ENGINE_TYPE);
    const run = await petri.createRun();
    await expect(run.restart()).rejects.toThrow(`restart() is not supported on ${PETRI_ENGINE_TYPE} workflows`);
  });

  it('refuses the two parameters that would pick another engine, instead of dropping them', () => {
    const { createWorkflow } = init();
    const loose = createWorkflow as unknown as (p: object) => unknown;
    expect(() => loose({ id: 'x', inputSchema: num, outputSchema: num, executionEngine: new PetriExecutionEngine() })).toThrow(
      /'executionEngine' is set by init\(\)/,
    );
    expect(() => loose({ id: 'x', inputSchema: num, outputSchema: num, schedule: { cron: '* * * * *' } })).toThrow(
      /'schedule' selects Mastra's evented engine/,
    );
  });

  /** The nested pair on either engine, registered with a `Mastra` or not. */
  async function nested(engine: 'default' | 'petri', register: boolean) {
    const { createWorkflow, createStep } = engine === 'petri' ? init() : { createWorkflow: mastraCreateWorkflow, createStep: mastraCreateStep };
    const make = createWorkflow as typeof mastraCreateWorkflow;
    const step = createStep as typeof mastraCreateStep;
    const inner = make({ id: 'inner', inputSchema: num, outputSchema: num }).then(step(aParams)).commit();
    const outer = make({ id: 'outer', inputSchema: num, outputSchema: num })
      .then(engine === 'petri' ? (init().createStep(inner as never) as never) : inner)
      .then(step(bParams))
      .commit();
    if (register) new Mastra({ workflows: { outer, inner }, logger: false });
    return (await outer.createRun()).start({ inputData: { n: 1 } });
  }

  it('createStep(workflow) returns the same workflow object, so Mastra still nests it', () => {
    const { createWorkflow, createStep } = init();
    const inner = createWorkflow({ id: 'inner', inputSchema: num, outputSchema: num }).then(createStep(aParams)).commit();
    const asStep = createStep(inner);
    expect(asStep).toBe(inner);
    expect((asStep as { component?: unknown }).component).toBe('WORKFLOW');
  });

  it('a nested petri workflow runs, registered with Mastra, and agrees with the default engine', async () => {
    const got = await nested('petri', true);
    const want = await nested('default', true);
    expect(want.status).toBe('success');
    expect(got.status).toBe(want.status);
    if (got.status !== 'success' || want.status !== 'success') throw new Error('unreachable');
    expect(got.result).toEqual({ n: 20 });
    expect(got.result).toEqual(want.result);
  });

  it('a nested petri workflow runs unregistered too, and agrees with the default engine', async () => {
    const got = await nested('petri', false);
    const want = await nested('default', false);
    expect(want.status).toBe('success');
    expect(got.status).toBe(want.status);
    if (got.status !== 'success' || want.status !== 'success') throw new Error('unreachable');
    expect(got.result).toEqual(want.result);
  });

  it('createStep delegates every other source to Mastra, and cloneStep is Mastra\'s', () => {
    const { createStep, cloneStep } = init();
    const step = createStep(aParams);
    const reference = mastraCreateStep(aParams);
    expect(Object.keys(step).sort()).toEqual(Object.keys(reference).sort());
    expect(step.id).toBe('a');
    const clone = cloneStep(step, { id: 'a2' });
    expect(clone.id).toBe('a2');
    expect(clone.execute).toBe(step.execute);
  });

  it('the package root and the ./mastra entry export the same factory', () => {
    expect(root.init).toBe(init);
    expect(root.PetriExecutionEngine).toBe(PetriExecutionEngine);
  });
});

// ---------------------------------------------------------------------------------------------
// The brand. Every `@ts-expect-error` below is a claim the typecheck (`npm run check`) enforces:
// if the brand stops rejecting a mix, the directive is unused and the check fails. These bodies
// are never run — they are compile-time only.
// ---------------------------------------------------------------------------------------------

describe('init() — the PetriEngineType brand', () => {
  const { createWorkflow, createStep } = init();
  const petriStep = createStep(aParams);
  const defaultStep = mastraCreateStep(aParams);
  const petriWf = () => createWorkflow({ id: 'p', inputSchema: num, outputSchema: num, stateSchema: seen });
  const defaultWf = () => mastraCreateWorkflow({ id: 'd', inputSchema: num, outputSchema: num, stateSchema: seen });
  const arrayOut = z.array(num);

  it('brands steps and workflows with PetriEngineType, and leaves Mastra\'s own unbranded', () => {
    expectTypeOf(petriStep).toEqualTypeOf<
      PetriStep<'a', { seen?: string[] | undefined }, { n: number }, { n: number }, unknown, unknown, unknown>
    >();
    expectTypeOf(defaultStep).toEqualTypeOf<
      Step<'a', { seen?: string[] | undefined }, { n: number }, { n: number }, unknown, unknown, DefaultEngineType, unknown>
    >();
    expectTypeOf(petriWf()).toExtend<Workflow<PetriEngineType, any, 'p', any, any, any, any, any>>();
    expectTypeOf<PetriEngineType>().not.toEqualTypeOf<DefaultEngineType>();
    // Incomparable both ways — the property the two-directional rejection rests on.
    expectTypeOf<DefaultEngineType>().not.toExtend<PetriEngineType>();
    expectTypeOf<PetriEngineType>().not.toExtend<DefaultEngineType>();
  });

  it('accepts petri steps in a petri workflow, and keeps Mastra\'s inference', () => {
    const wf = petriWf().then(petriStep).then(createStep(bParams)).commit();
    expectTypeOf(wf).toExtend<Workflow<PetriEngineType, any, 'p', { seen?: string[] | undefined }, { n: number }, { n: number }, { n: number }, unknown>>();
  });

  it('rejects a default-engine step in a petri workflow, in every builder method', () => {
    const typeOnly = () => {
      // @ts-expect-error — a step built by Mastra's createStep is not a petri step
      petriWf().then(defaultStep);
      // @ts-expect-error — nor inside .parallel()
      petriWf().parallel([defaultStep]);
      // @ts-expect-error — nor as a .branch() arm
      petriWf().branch([[async () => true, defaultStep]]);
      // @ts-expect-error — nor as a .dowhile() body
      petriWf().dowhile(defaultStep, async () => false);
      // @ts-expect-error — nor as a .dountil() body
      petriWf().dountil(defaultStep, async () => true);
      // @ts-expect-error — nor as a .foreach() body
      createWorkflow({ id: 'f', inputSchema: arrayOut, outputSchema: arrayOut }).foreach(defaultStep);
      // @ts-expect-error — nor in createWorkflow({ steps })
      createWorkflow({ id: 's', inputSchema: num, outputSchema: num, steps: [defaultStep] });
      // @ts-expect-error — nor a default-engine workflow nested in a petri one
      petriWf().then(defaultWf().then(defaultStep).commit());
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('rejects a petri step in a default-engine workflow, in every builder method', () => {
    const typeOnly = () => {
      // @ts-expect-error — the reverse: a petri step on Mastra's engine
      defaultWf().then(petriStep);
      // @ts-expect-error — nor inside .parallel()
      defaultWf().parallel([petriStep]);
      // @ts-expect-error — nor as a .branch() arm
      defaultWf().branch([[async () => true, petriStep]]);
      // @ts-expect-error — nor as a .dowhile() body
      defaultWf().dowhile(petriStep, async () => false);
      // @ts-expect-error — nor as a .foreach() body
      mastraCreateWorkflow({ id: 'f', inputSchema: arrayOut, outputSchema: arrayOut }).foreach(petriStep);
      // @ts-expect-error — nor a petri workflow wrapped as a step, nested in a default one
      defaultWf().then(createStep(petriWf().then(petriStep).commit()));
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('nests a petri workflow through createStep(workflow), and names why .then(workflow) is refused', () => {
    const inner = createWorkflow({ id: 'inner', inputSchema: num, outputSchema: num }).then(createStep(aParams)).commit();
    expectTypeOf(createStep(inner)).toEqualTypeOf<PetriStep<'inner', unknown, { n: number }, { n: number }, any, any, unknown>>();
    const typeOnly = () => {
      createWorkflow({ id: 'outer', inputSchema: num, outputSchema: num }).then(createStep(inner)).commit();
      // @ts-expect-error — Mastra types Workflow.execute's `engine` as DefaultEngineType, so a workflow
      // is a default-engine step until createStep(workflow) re-brands it (divergence: nesting syntax).
      createWorkflow({ id: 'outer', inputSchema: num, outputSchema: num }).then(inner);
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('keeps Mastra-facing options in Mastra\'s words', () => {
    expectTypeOf<Parameters<typeof init>[0]>().toEqualTypeOf<
      { readonly iterationBound?: number; readonly concurrency?: number; readonly clock?: Clock } | undefined
    >();
    const typeOnly = () => {
      // @ts-expect-error — the engine is init()'s to set
      createWorkflow({ id: 'x', inputSchema: num, outputSchema: num, executionEngine: new PetriExecutionEngine() });
      // @ts-expect-error — `schedule` selects Mastra's evented engine
      createWorkflow({ id: 'x', inputSchema: num, outputSchema: num, schedule: { cron: '* * * * *' } });
    };
    expect(typeof typeOnly).toBe('function');
  });
});
