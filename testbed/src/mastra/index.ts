import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { startDebugServer } from '../debug-server.js';
import { debugRegistry } from './petri.js';
import { workflows } from './workflows/index.js';

/**
 * The testbed app: a plain Mastra app whose workflows are built with `init({ debug })` from
 * `mastra-libpetri`, so every one of them runs on `PetriExecutionEngine`. `mastra dev` serves it with
 * Mastra Studio; the libpetri debug UI is served beside it, from this same process, because the debug
 * registry the engine writes to is in-process.
 *
 * Ports and paths come from `.testbed/.env`, written by `scripts/bootstrap-testbed.sh`.
 */
const env = process.env;

export const mastra = new Mastra({
  workflows,
  storage: new LibSQLStore({ id: 'testbed', url: env.TESTBED_DB_URL ?? 'file:./testbed.db' }),
  server: { port: Number(env.TESTBED_MASTRA_PORT ?? 4111) },
});

const started = Symbol.for('mastra-libpetri.testbed.debugServer');
const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
if (env.TESTBED_DEBUG_PORT && !holder[started]) {
  holder[started] = true;
  startDebugServer(debugRegistry, {
    port: Number(env.TESTBED_DEBUG_PORT),
    uiHtmlPath: env.TESTBED_DEBUG_UI_HTML ?? 'debug-ui/index.html',
  });
}
