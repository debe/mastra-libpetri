import { DebugSessionRegistry } from 'libpetri/debug';
import { init } from 'mastra-libpetri/mastra';

/**
 * The one debug registry of this process. The engine registers a session per run segment in it
 * (`<runId>`, `<runId>~resume-<n>`), and the debug server serves it to the libpetri debug UI.
 * Kept on `globalThis` so a module evaluated twice (a bundler's dev reload) shares one.
 */
const key = Symbol.for('mastra-libpetri.testbed.debugRegistry');
const holder = globalThis as unknown as Record<symbol, DebugSessionRegistry | undefined>;
export const debugRegistry: DebugSessionRegistry = (holder[key] ??= new DebugSessionRegistry(200));

/**
 * Mastra's factories, bound to the petri engine. `iterationBound` is required by any workflow with a
 * loop (`docs/divergences.md` row 13); `debug` tees every run into the registry above.
 */
export const { createWorkflow, createStep } = init({ debug: debugRegistry, iterationBound: 50 });
