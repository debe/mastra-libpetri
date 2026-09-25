# Testbed

A real Mastra app whose workflows run on `PetriExecutionEngine`. You drive it end to end in
Mastra Studio, and the libpetri debug UI shows each run's net and live marking. The sources live
here. The app is installed and run from the gitignored `.testbed/`.

| Path | What it is |
|---|---|
| `src/mastra/index.ts` | The `Mastra` instance: the workflows, LibSQL storage, and the server port. It also starts the debug server in the same process. |
| `src/mastra/petri.ts` | `init({ debug, iterationBound })` and the process's one `DebugSessionRegistry`. |
| `src/mastra/workflows/index.ts` | `linear`, `parallel`, `branch`, `loop` (do-until), `foreach` (concurrency 2), `sleep`, `approval` (suspend/resume). |
| `src/debug-server.ts` | `GET /debug/petri/ui/` serves libpetri's single-file debug UI. `WS /debug/petri` speaks its protocol through `DebugProtocolHandler`. `GET /debug/petri/sessions` returns the registry as JSON. |
| `scripts/drive.ts` | Runs every workflow through Mastra's HTTP API and checks each run segment got a debug session. |
| `scripts/record.sh` | Makes the agent-browser recordings (WebM + PNG) of both UIs. |

## Run it

```bash
scripts/bootstrap-testbed.sh          # builds typescript/, packs it, installs .testbed/, writes .env
cd .testbed && npm run dev            # mastra dev: Studio on :4111, debug UI on :4112, one process
# in another shell:
cd .testbed && npm run drive          # every workflow, over HTTP; prints status, wall time, sessions
```

- Studio: <http://localhost:4111/workflows>
- Debug UI: <http://localhost:4112/debug/petri/ui/>. Press **Refresh** to list new sessions. With
  Mode set to **Live**, picking an active session follows it.

After changing `typescript/src`, run `scripts/bootstrap-testbed.sh --refresh` and restart
`npm run dev`. `mastra dev` does not watch `node_modules`. `--check` prints the provenance, and
`--clean` removes `.testbed/`.

The pins are in the bootstrap script and `package.json`:

- `@mastra/core` 1.67.0, the same version as `scripts/mastra-pin`.
- The `mastra` CLI 1.30.0, released with core 1.67.0 on 2026-09-15.
- `@mastra/deployer` held at 1.67.0 by an override.
- `@mastra/libsql` 1.23.0.
- `libpetri` 7.0.0 (6.1.0 through M5).
- Ports: `TESTBED_MASTRA_PORT` (default 4111) and `TESTBED_DEBUG_PORT` (default 4112).

The package goes in as a packed tarball, not a symlink. A symlink would resolve a second
`@mastra/core` from `typescript/node_modules`. The testbed keeps no lockfile, because the
tarball's integrity changes with every build, so every direct dependency is pinned exactly.

Two environment variables pace the runs:

- `TESTBED_PACE_MS` (default 400) is each paced step's wait.
- `TESTBED_SLEEP_MS` (default 3000) is the `sleep` workflow's wait.

The recordings used `TESTBED_PACE_MS=1500 TESTBED_SLEEP_MS=6000 npm run dev`.

## Testbed figures, which are not conformance figures

These are wall times through a dev server. Each one includes an HTTP round trip, LibSQL writes,
Studio's own polling and the debug tee. They show the testbed works. They are **not comparable**
with conformance, differential or benchmark figures, and they are not reported beside them.

Provenance (`.testbed/PROVENANCE`):

```
mastra-libpetri 059a0c2+dirty dist=b9a5c80b532f
libpetri 6.1.0 (registry)
@mastra/core 1.67.0, mastra CLI 1.30.0
debug-ui /Users/db/repositories/libpetri/debug-ui/dist/index.html sha256=24300ff7e2ed (libpetri 3ac08d0)
node v26.8.1, bootstrapped 2026-09-25T10:44:44Z
```

`npm run drive` ran three passes against `TESTBED_PACE_MS=0 TESTBED_SLEEP_MS=0 npm run dev`
(macOS, 2026-09-25). The table gives milliseconds for `start-async` or `resume-async`, from the
client:

| workflow | pass 1 | pass 2 | pass 3 | net events in the session |
|---|---|---|---|---|
| linear | 26 | 11 | 12 | 24 |
| parallel (arms wait 300/900/1500 ms regardless of pace) | 1514 | 1512 | 1509 | 58 |
| branch | 27 | 7 | 7 | 41 |
| loop (5 iterations) | 23 | 16 | 12 | 205 |
| foreach (5 items, concurrency 2) | 14 | 15 | 11 | 139 |
| sleep (0 ms) | 11 | 8 | 8 | 29 |
| approval: start → suspended | 9 | 7 | 6 | 19 |
| approval: resume `{approved:false}` → suspended | 9 | 5 | 5 | 14 (`~resume-1`) |
| approval: resume `{approved:true}` → success | 10 | 7 | 7 | 19 (`~resume-2`) |

Every result matched the expected value: `{n:14}`, `{n:2703}`, `3 is small`, `{n:5}`,
`[1,4,9,16,25]`, `{n:102}`, and `n = 42, approved by drive`.
