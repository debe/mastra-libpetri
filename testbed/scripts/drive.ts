/**
 * Drives every testbed workflow through Mastra's own HTTP API against a running `npm run dev`,
 * then checks the debug server registered a session for each run segment.
 *
 *   npm run drive                 all workflows
 *   npm run drive -- sleep        one (or several) by id
 *   npm run drive -- --no-wait sleep   start without waiting (for a live recording)
 *
 * The wall times printed are TESTBED figures: a dev server over HTTP, LibSQL, paced steps. They are
 * not comparable with conformance or differential figures; quote .testbed/PROVENANCE beside them.
 */
const env = process.env;
const api = `http://localhost:${env.TESTBED_MASTRA_PORT ?? 4111}/api`;
const debug = `http://localhost:${env.TESTBED_DEBUG_PORT ?? 4112}/debug/petri`;

const inputs: Record<string, unknown> = {
  linear: { n: 1 },
  parallel: { n: 1 },
  branch: { n: 3 },
  loop: { n: 0 },
  foreach: [1, 2, 3, 4, 5],
  sleep: { n: 1 },
  approval: { n: 41 },
};

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

const args = process.argv.slice(2);
const noWait = args.includes('--no-wait');
const ids = args.filter((a) => !a.startsWith('--'));
const selected = ids.length > 0 ? ids : Object.keys(inputs);
const stamp = Date.now().toString(36);

for (const id of selected) {
  const runId = `${id}-${stamp}`;
  await post(`/workflows/${id}/create-run?runId=${runId}`, {});
  if (noWait) {
    // `start` (not `start-async`) returns as soon as the run is started.
    await post(`/workflows/${id}/start?runId=${runId}`, { inputData: inputs[id] });
    console.log(`${id.padEnd(9)} started ${runId}`);
    continue;
  }
  const [started, ms] = await timed(() => post(`/workflows/${id}/start-async?runId=${runId}`, { inputData: inputs[id] }));
  let line = `${id.padEnd(9)} ${String(started.status).padEnd(9)} ${ms.toFixed(0).padStart(6)} ms`;
  if (id === 'approval' && started.status === 'suspended') {
    const [again, ms1] = await timed(() => post(`/workflows/${id}/resume-async?runId=${runId}`, { step: 'approve', resumeData: { approved: false } }));
    const [done, ms2] = await timed(() => post(`/workflows/${id}/resume-async?runId=${runId}`, { step: 'approve', resumeData: { approved: true, by: 'drive' } }));
    line += ` | resume ${String(again.status)} ${ms1.toFixed(0)} ms | resume ${String(done.status)} ${ms2.toFixed(0)} ms -> ${JSON.stringify(done.result)}`;
  } else {
    line += ` -> ${JSON.stringify(started.result ?? started.error)}`;
  }
  const sessions = (await (await fetch(`${debug}/sessions`)).json()) as { sessionId: string; eventCount: number; active: boolean }[];
  const mine = sessions.filter((s) => s.sessionId === runId || s.sessionId.startsWith(`${runId}~`));
  line += ` | sessions ${mine.map((s) => `${s.sessionId.slice(runId.length) || '(start)'}:${s.eventCount}ev${s.active ? '*' : ''}`).join(' ')}`;
  console.log(line);
}

export {};
