/**
 * Reading `compensate` off a step ([ADR 0017], M7b W1 surface): the compensator the petri
 * `createStep` attached under `STEP_RESOURCES`, described into `StepDescription.compensate` with the
 * parent's options; and every one of the five refusals by name, at `createStep` where the step can
 * see the problem and in the adapter against the step flow — a carrier attached by hand stands in for
 * one that slipped past the factory.
 *
 * Each case names the mutation that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createStep as mastraCreateStep, createWorkflow as mastraCreateWorkflow } from '@mastra/core/workflows';
import { createTool } from '@mastra/core/tools';
import type { StepDescription } from '../../src/compiler/types.js';
import { adaptExecutionGraph, adaptStepFlow, COMPENSATE_REFUSALS, init, UnsupportedWorkflowError } from '../../src/mastra/index.js';
import type { ExecutionGraph, StepFlowEntry } from '../../src/mastra/index.js';
import { attachResources, compensatorOf, isParamsStep, resourcesOf } from '../../src/mastra/resources.js';

const { createWorkflow, createStep, cloneStep, limit, race, pipeline } = init({ iterationBound: 3 });

const num = z.object({ n: z.number() });
const mk = (id: string, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: num, outputSchema: num, ...extra, execute: async ({ inputData }) => ({ n: inputData.n + 1 }) });
/** A compensator over `num`. */
const undo = (id: string, extra: Record<string, unknown> = {}) =>
  createStep({ id, inputSchema: num, outputSchema: z.void(), ...extra, execute: async () => undefined });
const wf = (id = 'w') => createWorkflow({ id, inputSchema: num, outputSchema: z.any() });

type Graph = { buildExecutionGraph(): unknown };
const graphOf = (w: Graph) => w.buildExecutionGraph() as ExecutionGraph;
const adaptWf = (w: Graph, retryConfig?: { attempts?: number; delay?: number }) =>
  adaptExecutionGraph(graphOf(w), { iterationBound: 3, ...(retryConfig ? { retryConfig } : {}) });
const refusal = (fn: () => unknown): UnsupportedWorkflowError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedWorkflowError);
    return error as UnsupportedWorkflowError;
  }
  throw new Error('expected a refusal');
};
/** What `createStep` throws: a TypeError naming the step and the refusal. */
const thrown = (fn: () => unknown): TypeError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return error as TypeError;
  }
  throw new Error('expected createStep to throw');
};

const tool = createTool({ id: 'double', description: 'doubles n', inputSchema: num, outputSchema: num, execute: async (input) => ({ n: input.n * 2 }) });
const agent = new Agent({ id: 'stubby', name: 'stubby', instructions: 'be brief', model: {} as never });

/** No Petri vocabulary in a Mastra-facing message (CLAUDE.md, hard rules). */
const PETRI_WORDS = /\b(place|token|transition|ladder|net|marking|arc|firing)s?\b|wf\.comp|level\.\d/i;

describe('describing a compensator', () => {
  it('a top-level .then() step: the compensator described as a step', () => {
    // Breaks if: the adapter drops `compensate`, or init() does not attach it.
    const release = undo('release');
    const d = adaptWf(wf().then(mk('reserve', { compensate: release })).then(mk('charge')).commit());
    expect(d.entries[0]).toEqual({ kind: 'step', id: 'reserve', source: 'step', compensate: { kind: 'step', id: 'release', source: 'step' } });
    expect(d.entries[1]).toEqual({ kind: 'step', id: 'charge', source: 'step' });
  });

  it('with the parent\'s options: retries own ?? retryConfig.attempts, the delay, its own timeout and quotas', () => {
    // Breaks if: the compensator is described without the workflow's retryConfig, or its own
    // retries / timeout / uses are not read.
    const refunds = limit(1, { id: 'refunds' });
    const fallback = undo('fallback');
    const own = undo('own', { retries: 0, timeout: 40, uses: [refunds] });
    const d = adaptWf(
      wf().then(mk('a', { compensate: fallback })).then(mk('b', { compensate: own })).then(mk('c')).commit(),
      { attempts: 2, delay: 5 },
    );
    expect((d.entries[0] as StepDescription).compensate).toEqual({ kind: 'step', id: 'fallback', source: 'step', retries: 2, retryDelayMs: 5 });
    expect((d.entries[1] as StepDescription).compensate).toEqual({
      kind: 'step',
      id: 'own',
      source: 'step',
      timeoutMs: 40,
      quotas: [{ id: 'refunds', kind: 'limit', n: 1 }],
    });
  });

  it('a quota shared by a step and a compensator is one quota; a different object under its id collides', () => {
    // Breaks if: the compensator is adapted with a fresh quota map (a collision would pass).
    const pay = limit(1, { id: 'pay' });
    const ok = adaptWf(wf().then(mk('a', { uses: [pay], compensate: undo('u', { uses: [pay] }) })).then(mk('b')).commit());
    expect((ok.entries[0] as StepDescription).quotas).toEqual([{ id: 'pay', kind: 'limit', n: 1 }]);
    const other = limit(2, { id: 'pay' });
    const e = refusal(() => adaptWf(wf().then(mk('a', { uses: [pay], compensate: undo('u', { uses: [other] }) })).then(mk('b')).commit()));
    expect(e.reason).toMatch(/^quota-id-collision/);
  });

  it('a tool step and an agent step carry it on their options; Mastra never sees the key', () => {
    // Breaks if: `compensate` is not stripped from the options copy (Mastra spreads it into the call
    // and the serialized graph), or not attached to it.
    const toolStep = createStep(tool, { compensate: undo('undo-double') });
    const agentStep = createStep(agent, { retries: 1, compensate: createStep({ id: 'undo-stubby', inputSchema: z.object({ text: z.string() }), outputSchema: z.void(), execute: async () => undefined }) });
    const opts = (s: object) => (s as { __toolOptions?: object; __agentOptions?: object }).__toolOptions ?? (s as { __agentOptions?: object }).__agentOptions;
    expect(Object.keys(opts(toolStep)!)).not.toContain('compensate');
    expect(Object.keys(opts(agentStep)!)).not.toContain('compensate');
    expect(compensatorOf(toolStep)).toBeDefined();
    const t = adaptWf(wf().then(toolStep).then(mk('next')).commit());
    expect(t.entries[0]).toEqual({ kind: 'step', id: 'double', source: 'tool', compensate: { kind: 'step', id: 'undo-double', source: 'step' } });
    const a = adaptExecutionGraph(
      graphOf(createWorkflow({ id: 'w', inputSchema: z.object({ prompt: z.string() }), outputSchema: z.any() }).then(agentStep).then(mk('next') as never).commit()),
    );
    expect(a.entries[0]).toEqual({ kind: 'step', id: 'stubby', source: 'agent', retries: 1, compensate: { kind: 'step', id: 'undo-stubby', source: 'step' } });
  });

  it('a params step never carries the key on the Step or in its serialized graph', () => {
    // Breaks if: init() passes `compensate` into the Step (Mastra would persist the compensator's
    // schemas with every snapshot, and a changed one would trip workflow-changed).
    const release = undo('release');
    const reserve = mk('reserve', { compensate: release });
    expect(Object.keys(reserve)).not.toContain('compensate');
    expect(Object.getOwnPropertyDescriptor(reserve, 'compensate')).toBeUndefined();
    expect(compensatorOf(reserve)).toBe(release);
    const w = wf().then(reserve).then(mk('charge')).commit();
    expect(JSON.stringify((w as unknown as { serializedStepGraph: unknown }).serializedStepGraph)).not.toMatch(/compensate|release/);
  });

  it('cloneStep keeps the compensator, and a clone of a compensator is one', () => {
    // Breaks if: the petri cloneStep drops the compensator, or does not mark a params clone.
    const release = undo('release');
    const reserve = mk('reserve', { compensate: release });
    const again = cloneStep(reserve, { id: 'reserve-2' });
    expect(compensatorOf(again)).toBe(release);
    const release2 = cloneStep(release, { id: 'release-2' });
    expect(isParamsStep(release2)).toBe(true);
    const d = adaptWf(wf().then(mk('a', { compensate: release })).then(mk('b', { compensate: release2 })).then(mk('c')).commit());
    expect((d.entries[1] as StepDescription).compensate?.id).toBe('release-2');
  });

  it('`compensate: undefined` is no key: the step describes exactly as one without it', () => {
    // Breaks if: an explicit undefined attaches an empty compensator or resources.
    const s = mk('a', { compensate: undefined });
    expect(resourcesOf(s)).toBeUndefined();
    expect(adaptWf(wf().then(s).then(mk('b')).commit()).entries[0]).toEqual({ kind: 'step', id: 'a', source: 'step' });
  });

  it('a checkpoint before the first compensated step is accepted', () => {
    // Breaks if: compensate-checkpoint counts entries before k_1.
    const d = adaptWf(wf().then(mk('a', { metadata: { checkpoint: true } })).then(mk('b', { compensate: undo('u') })).then(mk('c')).commit());
    expect(d.checkpoints).toEqual([0]);
  });
});

describe('the five refusals', () => {
  it('the names are the contract\'s five, and every message is in Mastra\'s words', () => {
    expect([...COMPENSATE_REFUSALS]).toEqual(['compensate-position', 'compensate-value', 'compensate-ids', 'compensate-suspend', 'compensate-checkpoint']);
  });

  describe('compensate-position', () => {
    const release = () => undo('release');
    const positions: readonly [string, () => Graph][] = [
      ['a .parallel() arm', () => wf().parallel([mk('p1', { compensate: release() }), mk('p2')]).map(async () => ({ n: 1 })).then(mk('z')).commit()],
      ['a .branch() arm', () => wf().branch([[async () => true, mk('b1', { compensate: release() })]]).map(async () => ({ n: 1 })).then(mk('z')).commit()],
      ['a race arm', () => wf().parallel(...race([mk('r1', { compensate: release() }), mk('r2')], { id: 'r' })).map(async () => ({ n: 1 })).then(mk('z')).commit()],
      ['a .dowhile() body', () => wf().dowhile(mk('lw', { compensate: release() }), async () => false).then(mk('z')).commit()],
      [
        'a .foreach() body',
        () => createWorkflow({ id: 'w', inputSchema: z.array(num), outputSchema: z.any() }).foreach(mk('fe', { compensate: release() })).map(async () => ({ n: 1 })).then(mk('z')).commit(),
      ],
      [
        'a pipeline stage',
        () =>
          createWorkflow({ id: 'w', inputSchema: z.array(num), outputSchema: z.any() })
            .foreach(...pipeline([mk('s1', { compensate: release() }), mk('s2')], { id: 'pl' }))
            .map(async () => ({ n: 1 }))
            .then(mk('z'))
            .commit(),
      ],
    ];
    for (const [where, build] of positions) {
      it(`on ${where}`, () => {
        // Breaks if: adaptSingleStep describes a compensator off the top level.
        const e = refusal(() => adaptWf(build()));
        expect(e.reason).toMatch(/^compensate-position: step '\w+' carries compensate, but only a step added with \.then\(\) at the top level/);
        expect(e.reason).not.toMatch(PETRI_WORDS);
      });
    }

    it('on the last top-level entry', () => {
      // Breaks if: refuseCompensateShapes skips the last-entry check (the compensator would be dead).
      const e = refusal(() => adaptWf(wf().then(mk('a')).then(mk('z', { compensate: release() })).commit()));
      expect(e.entryId).toBe('z');
      expect(e.reason).toMatch(/^compensate-position: step 'z' carries compensate, but it is the last step of the workflow/);
      // ...and on a workflow of one step.
      expect(refusal(() => adaptWf(wf().then(mk('only', { compensate: release() })).commit())).reason).toMatch(/^compensate-position/);
    });

    it('on a declarative .tool() / .agent() whose options never passed through the petri createStep', () => {
      // Breaks if: refuseUnattachedResources ignores `compensate` (the step would silently undo nothing).
      const asked = { compensate: release() };
      const t = refusal(() => adaptWf(wf().tool(tool, asked as never).then(mk('z')).commit()));
      expect(t.entryType).toBe('tool');
      expect(t.reason).toMatch(/^compensate-position: this tool's options carries compensate, but it never passed through the petri createStep/);
      expect(t.reason).toMatch(/init\(\)\.createStep\(tool, \{ compensate \}\)/);
      const a = refusal(() =>
        adaptExecutionGraph(graphOf(mastraCreateWorkflow({ id: 'w', inputSchema: z.object({ prompt: z.string() }), outputSchema: z.any() }).agent(agent, asked as never).commit())),
      );
      expect(a.reason).toMatch(/^compensate-position: this agent's options carries compensate/);
      // Mastra's own createStep(tool, options) keeps the options as __toolOptions, key and all.
      const m = refusal(() => adaptWf(wf().then(mastraCreateStep(tool, asked as never) as never).then(mk('z') as never).commit()));
      expect(m.reason).toMatch(/^compensate-position: this tool's options carries compensate/);
    });

    it('on a hand-built step object', () => {
      const entries = [
        { type: 'step', step: { id: 'h', compensate: release() } },
        { type: 'step', step: { id: 'z' } },
      ] as unknown as StepFlowEntry[];
      expect(refusal(() => adaptStepFlow(entries, { workflowId: 'w' })).reason).toMatch(/^compensate-position: this step carries compensate/);
    });
  });

  describe('compensate-value', () => {
    const plain = mastraCreateStep({ id: 'plain-undo', inputSchema: num, outputSchema: z.void(), execute: async () => undefined });
    const child = createWorkflow({ id: 'child-undo', inputSchema: num, outputSchema: z.any() }).then(mk('c1')).commit();
    const cases: readonly [string, () => unknown, RegExp][] = [
      ['a step from Mastra\'s own createStep', () => plain, /its compensate, 'plain-undo', was not built by init\(\)\.createStep from a params object/],
      ['a nested workflow', () => child, /its compensate is the workflow 'child-undo'; a nested workflow cannot undo a step yet/],
      ['a tool step', () => createStep(tool), /its compensate is the tool step 'double'; an agent or tool cannot undo a step/],
      ['an agent step', () => createStep(agent), /its compensate is the agent step 'stubby'/],
      ['a hand-made object', () => ({ id: 'fake', execute: async () => undefined }), /its compensate, 'fake', was not built by init\(\)\.createStep/],
      ['null', () => null, /its compensate is null, not a step/],
      ['a function', () => async () => undefined, /its compensate is a function, not a step/],
      ['a step that carries its own compensate', () => mk('nested-undo', { compensate: undo('deeper') }), /its compensate, 'nested-undo', has a compensate of its own/],
    ];
    for (const [what, value, why] of cases) {
      it(`${what}: at createStep, and in the adapter against a hand-attached carrier`, () => {
        // Breaks if: compensateProblem accepts it (init and the adapter share it, so both break).
        const e = thrown(() => mk('reserve', { compensate: value() }));
        expect(e.message).toMatch(new RegExp(`^createStep\\('reserve'\\): compensate-value: ${why.source}`));
        expect(e.message).not.toMatch(PETRI_WORDS);
        const forged = mk('reserve');
        attachResources(forged, { compensate: value() as object });
        const r = refusal(() => adaptWf(wf().then(forged).then(mk('z')).commit()));
        expect(r.entryId).toBe('reserve');
        expect(r.reason).toMatch(new RegExp(`^compensate-value: ${why.source}`));
      });
    }

    it('a petri cloneStep of Mastra\'s own step, and a processor step, are no params-form steps', () => {
      // Breaks if: the petri cloneStep marks every clone, or createStep marks every non-agent/tool Step
      // (a default-engine or processor step would pass as a compensator).
      const plainClone = cloneStep(plain as never, { id: 'plain-clone' });
      const processor = createStep({ id: 'trim', processInput: async ({ messages }: { messages: unknown[] }) => messages } as never);
      expect((processor as { id: string }).id).toBe('processor:trim');
      for (const [value, id] of [[plainClone, 'plain-clone'], [processor, 'processor:trim']] as const) {
        expect(isParamsStep(value)).toBe(false);
        expect(thrown(() => mk('reserve', { compensate: value })).message).toMatch(
          new RegExp(`^createStep\\('reserve'\\): compensate-value: its compensate, '${id}', was not built by init\\(\\)\\.createStep from a params object`),
        );
      }
    });

    it('a processor carrying compensate is named by its Step id', () => {
      // Breaks if: init() names the source's id ('trim') rather than the Step's ('processor:trim').
      const source = { id: 'trim', processInput: async ({ messages }: { messages: unknown[] }) => messages, compensate: null };
      expect(thrown(() => createStep(source as never)).message).toMatch(/^createStep\('processor:trim'\): compensate-value: its compensate is null/);
      const own = { id: 'trim', processInput: async ({ messages }: { messages: unknown[] }) => messages, compensate: undo('processor:trim') };
      expect(thrown(() => createStep(own as never)).message).toMatch(/^createStep\('processor:trim'\): compensate-ids: its compensate has the step's own id/);
    });

    it('the forward step itself (only an attach by hand can make one)', () => {
      // Breaks if: compensateProblem drops the identity check (the step would undo itself with its own output).
      const self = mk('self');
      attachResources(self, { compensate: self });
      expect(refusal(() => adaptWf(wf().then(self).then(mk('z')).commit())).reason).toMatch(/^compensate-value: its compensate is the step itself/);
    });
  });

  describe('compensate-ids', () => {
    it('the compensator has the step\'s own id: at createStep', () => {
      // Breaks if: compensateProblem drops the own-id check.
      const e = thrown(() => mk('reserve', { compensate: undo('reserve') }));
      expect(e.message).toMatch(/^createStep\('reserve'\): compensate-ids: its compensate has the step's own id 'reserve'/);
    });

    it('the compensator has the id of a step of the workflow', () => {
      // Breaks if: the graph ids skip arms (or entries).
      const e = refusal(() => adaptWf(wf().then(mk('a', { compensate: undo('p1') })).parallel([mk('p1'), mk('p2')]).then(mk('z') as never).commit()));
      expect(e.entryId).toBe('a');
      expect(e.reason).toMatch(/^compensate-ids: its compensate has the id 'p1', which a step of this workflow already has/);
      const top = refusal(() => adaptWf(wf().then(mk('a', { compensate: undo('z') })).then(mk('z')).commit()));
      expect(top.reason).toMatch(/^compensate-ids: its compensate has the id 'z'/);
      // A pipeline stage is recorded in this run, too.
      const stage = refusal(() =>
        adaptWf(
          createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() })
            .then(mk('a', { compensate: undo('s1') }))
            .map(async () => [{ n: 1 }])
            .foreach(...pipeline([mk('s1'), mk('s2')], { id: 'pl' }))
            .then(mk('z') as never)
            .commit(),
        ),
      );
      expect(stage.reason).toMatch(/^compensate-ids: its compensate has the id 's1'/);
    });

    describe('every id Mastra records a step result under is counted', () => {
      const arr = () => createWorkflow({ id: 'w', inputSchema: num, outputSchema: z.any() });
      // [where, the colliding id, the workflow with a compensator of that id on 'a']
      const cases: readonly [string, string, (u: string) => Graph][] = [
        // An unnamed loop or foreach is described under its body's id; a named one under its name,
        // while Mastra still records the body under the body's id (handlers/entry.ts:810-812).
        ['a .dowhile() body', 'lw', (u) => wf().then(mk('a', { compensate: undo(u) })).dowhile(mk('lw'), async () => false).then(mk('z')).commit()],
        // Breaks if: the graph ids skip a loop body.
        ['a named .dowhile() body', 'lw', (u) => wf().then(mk('a', { compensate: undo(u) })).dowhile(mk('lw'), async () => false, { id: 'again' }).then(mk('z')).commit()],
        [
          'a .foreach() body',
          'fe',
          (u) => arr().then(mk('a', { compensate: undo(u) })).map(async () => [{ n: 1 }]).foreach(mk('fe')).map(async () => ({ n: 1 })).then(mk('z')).commit(),
        ],
        // Breaks if: the graph ids skip a .foreach() body that is not a pipeline.
        [
          'a named .foreach() body',
          'fe',
          (u) => arr().then(mk('a', { compensate: undo(u) })).map(async () => [{ n: 1 }]).foreach(mk('fe'), { id: 'each' }).map(async () => ({ n: 1 })).then(mk('z')).commit(),
        ],
        // Breaks if: the graph ids skip a .branch() arm (the parallel case does not reach it).
        ['a .branch() arm', 'b1', (u) => wf().then(mk('a', { compensate: undo(u) })).branch([[async () => true, mk('b1')]]).map(async () => ({ n: 1 })).then(mk('z')).commit()],
        // Breaks if: the graph ids skip a mapping entry's id (Mastra records a mapping under it, handlers/entry.ts:776).
        ['an explicit .map() id', 'shape', (u) => wf().then(mk('a', { compensate: undo(u) })).map(async () => ({ n: 1 }), { id: 'shape' }).then(mk('z')).commit()],
      ];
      for (const [where, u, build] of cases) {
        it(`${where}`, () => {
          const e = refusal(() => adaptWf(build(u)));
          expect(e.entryId).toBe('a');
          expect(e.reason).toMatch(new RegExp(`^compensate-ids: its compensate has the id '${u}', which a step of this workflow already has`));
          // ...and the same workflow with a fresh compensator id adapts.
          expect(() => adaptWf(build(`${u}-undo`))).not.toThrow();
        });
      }
    });

    it('two compensators with one id — one compensator object on two steps', () => {
      // Breaks if: compensator ids are not checked against each other.
      const release = undo('release');
      const e = refusal(() => adaptWf(wf().then(mk('a', { compensate: release })).then(mk('b', { compensate: release })).then(mk('z')).commit()));
      expect(e.entryId).toBe('b');
      expect(e.reason).toMatch(/^compensate-ids: its compensate has the id 'release', as step 'a''s does/);
    });

    it('a compensated step used twice', () => {
      // Breaks if: the forward step's own id is not counted against the graph.
      const reserve = mk('reserve', { compensate: undo('release') });
      const e = refusal(() => adaptWf(wf().then(reserve).then(mk('b')).then(reserve).then(mk('z')).commit()));
      expect(e.reason).toMatch(/^compensate-ids: step 'reserve' carries compensate and its id appears more than once/);
      expect(e.reason).toContain(
        "cloneStep(step, { id, compensate: cloneStep(compensator, { id }) }), where step is 'reserve' and compensator is its compensate 'release'",
      );
      // ...also when the second use is an arm.
      const arm = refusal(() => adaptWf(wf().then(reserve).parallel([mk('reserve'), mk('p2')]).then(mk('z') as never).commit()));
      expect(arm.reason).toMatch(/^compensate-ids: step 'reserve'/);
    });
  });

  describe('reusing a compensated step: the remedy the refusal names works', () => {
    const release = () => undo('release');

    it('a plain clone keeps the compensator, so its id collides, and the message says what to pass', () => {
      // Breaks if: the message stops naming cloneStep's compensate (the remedy would be a dead end again).
      const reserve = mk('reserve', { compensate: release() });
      const again = cloneStep(reserve, { id: 'reserve-2' });
      const e = refusal(() => adaptWf(wf().then(reserve).then(again).then(mk('z')).commit()));
      expect(e.entryId).toBe('reserve-2');
      expect(e.reason).toMatch(/^compensate-ids: its compensate has the id 'release', as step 'reserve''s does/);
      expect(e.reason).toContain("or to cloneStep(step, { id, compensate }) when 'reserve-2' is itself a copy");
      expect(e.reason).not.toMatch(PETRI_WORDS);
    });

    it('cloneStep(step, { id, compensate: cloneStep(compensator, { id }) }) adapts, each use with its own undo', () => {
      // Breaks if: the petri cloneStep ignores `compensate` (the clone keeps 'release' and collides).
      const rel = release();
      const reserve = mk('reserve', { compensate: rel });
      const again = cloneStep(reserve, { id: 'reserve-2', compensate: cloneStep(rel, { id: 'release-2' }) });
      expect(compensatorOf(reserve)).toBe(rel);
      expect(compensatorOf(again)).not.toBe(rel);
      const d = adaptWf(wf().then(reserve).then(again).then(mk('z')).commit());
      expect((d.entries[0] as StepDescription).compensate?.id).toBe('release');
      expect((d.entries[1] as StepDescription).compensate?.id).toBe('release-2');
    });

    it('the clone keeps uses and timeout when its compensator is replaced', () => {
      // Breaks if: replacing the compensator drops the original's other resources.
      const q = limit(1, { id: 'q' });
      const reserve = mk('reserve', { uses: [q], timeout: 50, compensate: release() });
      const again = cloneStep(reserve, { id: 'reserve-2', compensate: undo('release-2') });
      expect(resourcesOf(again)).toEqual({ quotas: [q], timeoutMs: 50, compensate: compensatorOf(again) });
    });

    it('cloneStep judges its compensate as createStep does', () => {
      // Breaks if: cloneStep attaches a compensate unchecked (refused only later, against no createStep).
      const reserve = mk('reserve', { compensate: release() });
      const plain = mastraCreateStep({ id: 'plain-undo', inputSchema: num, outputSchema: z.void(), execute: async () => undefined });
      expect(thrown(() => cloneStep(reserve, { id: 'r2', compensate: plain as never })).message).toMatch(
        /^cloneStep\('r2'\): compensate-value: its compensate, 'plain-undo', was not built by init\(\)\.createStep/,
      );
      expect(thrown(() => cloneStep(reserve, { id: 'r2', compensate: undo('r2') })).message).toMatch(/^cloneStep\('r2'\): compensate-ids: its compensate has the step's own id 'r2'/);
      const marked = mk('marked', { metadata: { checkpoint: true } });
      expect(thrown(() => cloneStep(marked, { id: 'm2', compensate: undo('u') })).message).toMatch(/^cloneStep\('m2'\): compensate-checkpoint: it carries both/);
      // A clone given a compensate is itself no compensator.
      const undone = cloneStep(undo('u0'), { id: 'u1', compensate: undo('u2') as never });
      expect(thrown(() => mk('x', { compensate: undone })).message).toMatch(/compensate-value: its compensate, 'u1', has a compensate of its own/);
    });
  });

  describe('compensate-suspend', () => {
    for (const key of ['suspendSchema', 'resumeSchema'] as const) {
      it(`a compensator declaring ${key}: at createStep, and in the adapter`, () => {
        // Breaks if: compensateProblem ignores the schema (an undo would suspend a failed run).
        const suspending = undo('release', { [key]: z.object({ ok: z.boolean() }) });
        const e = thrown(() => mk('reserve', { compensate: suspending }));
        expect(e.message).toMatch(new RegExp(`^createStep\\('reserve'\\): compensate-suspend: its compensate, 'release', declares ${key}`));
        const forged = mk('reserve');
        attachResources(forged, { compensate: suspending });
        expect(refusal(() => adaptWf(wf().then(forged).then(mk('z')).commit())).reason).toMatch(/^compensate-suspend/);
      });
    }
  });

  describe('compensate-checkpoint', () => {
    it('on an entry after the first compensated step', () => {
      // Breaks if: refuseCompensateShapes skips checkpoints at or after k_1.
      const e = refusal(() => adaptWf(wf().then(mk('a', { compensate: undo('u') })).then(mk('b', { metadata: { checkpoint: true } })).then(mk('z')).commit()));
      expect(e.entryId).toBe('b');
      expect(e.reason).toMatch(/^compensate-checkpoint: it is marked metadata\.checkpoint, at or after step 'a', which carries compensate/);
      expect(e.reason).not.toMatch(PETRI_WORDS);
      // On a block's own options, and on the last entry too.
      const block = refusal(() =>
        adaptWf(wf().then(mk('a', { compensate: undo('u') })).parallel([mk('p1')], { metadata: { checkpoint: true } } as never).then(mk('z') as never).commit()),
      );
      expect(block.reason).toMatch(/^compensate-checkpoint/);
      const last = refusal(() => adaptWf(wf().then(mk('a', { compensate: undo('u') })).then(mk('z', { metadata: { checkpoint: true } })).commit()));
      expect(last.entryId).toBe('z');
      expect(last.reason).toMatch(/^compensate-checkpoint/);
    });

    it('on the compensated step itself: at createStep, and in the adapter', () => {
      // Breaks if: compensateProblem ignores the forward step's own mark.
      const e = thrown(() => mk('a', { metadata: { checkpoint: true }, compensate: undo('u') }));
      expect(e.message).toMatch(/^createStep\('a'\): compensate-checkpoint: it carries both compensate and metadata\.checkpoint/);
      const t = thrown(() => createStep(tool, { metadata: { checkpoint: true }, compensate: undo('u') }));
      expect(t.message).toMatch(/^createStep\('double'\): compensate-checkpoint/);
      const forged = mk('a', { metadata: { checkpoint: true } });
      attachResources(forged, { compensate: undo('u') });
      expect(refusal(() => adaptWf(wf().then(forged).then(mk('z')).commit())).reason).toMatch(/^compensate-checkpoint: it carries both/);
    });

    it('on the compensator, which is never an entry', () => {
      // Breaks if: a compensator's checkpoint mark is silently ignored.
      const e = thrown(() => mk('a', { compensate: undo('u', { metadata: { checkpoint: true } }) }));
      expect(e.message).toMatch(/^createStep\('a'\): compensate-checkpoint: its compensate, 'u', carries metadata\.checkpoint/);
    });

    it('on the compensator, any value but false or undefined marks it', () => {
      // Breaks if: a compensator counts as marked only on `true` (the 'yes' below would pass unread).
      for (const value of ['yes', 1, null, {}]) {
        const e = thrown(() => mk('a', { compensate: undo('u', { metadata: { checkpoint: value } }) }));
        expect(e.message).toMatch(/^createStep\('a'\): compensate-checkpoint: its compensate, 'u', carries metadata\.checkpoint/);
      }
      for (const value of [false, undefined]) {
        expect(() => mk('a', { compensate: undo('u', { metadata: { checkpoint: value } }) })).not.toThrow();
      }
    });
  });
});
