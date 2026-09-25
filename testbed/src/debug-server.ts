import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { DebugProtocolHandler, type DebugCommand, type DebugSessionRegistry } from 'libpetri/debug';
import { WebSocketServer } from 'ws';

/**
 * Serves the libpetri debug UI against one process's `DebugSessionRegistry`:
 *
 * - `GET /debug/petri/ui/` — the UI, a single HTML file built by libpetri's `debug-ui` (its Vite
 *   base path is `/debug/petri/ui/`, and it opens its WebSocket at `/debug/petri` on the same host);
 * - `WS /debug/petri` — libpetri's debug protocol: one JSON command per message in, one JSON
 *   response per message out, through `DebugProtocolHandler`;
 * - `GET /debug/petri/sessions` — the registry as JSON, for scripts.
 *
 * It lives beside the engine because the registry is in-process: the engine registers sessions in
 * it and this server reads them. Nothing here is part of the package ([ADR 0008]).
 */
export function startDebugServer(registry: DebugSessionRegistry, options: { port: number; uiHtmlPath: string }): Server {
  const handler = new DebugProtocolHandler(registry);
  const html = (): string | undefined => {
    try {
      return readFileSync(options.uiHtmlPath, 'utf8');
    } catch {
      return undefined;
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/debug/petri/ui') {
      res.writeHead(302, { location: `/debug/petri/ui/${url.search}` }).end();
      return;
    }
    if (url.pathname === '/debug/petri/ui/' || url.pathname === '/debug/petri/ui/index.html') {
      const page = html();
      if (page === undefined) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(`debug UI not found at ${options.uiHtmlPath}; run scripts/bootstrap-testbed.sh`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
      return;
    }
    if (url.pathname === '/debug/petri/sessions') {
      const sessions = registry.listSessions(Number(url.searchParams.get('limit') ?? 50)).map((s) => ({
        sessionId: s.sessionId,
        netName: s.netName,
        active: s.active,
        eventCount: s.eventStore.eventCount(),
        startTime: s.startTime,
        endTime: s.endTime ?? null,
        tags: registry.tagsFor(s.sessionId),
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sessions));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/debug/petri') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = randomUUID();
      handler.clientConnected(clientId, (response) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
      });
      ws.on('message', (data) => {
        let command: DebugCommand;
        try {
          command = JSON.parse(String(data)) as DebugCommand;
        } catch {
          ws.send(JSON.stringify({ type: 'error', code: 'BAD_COMMAND', message: 'not JSON', sessionId: null }));
          return;
        }
        handler.handleCommand(clientId, command);
      });
      ws.on('close', () => handler.clientDisconnected(clientId));
    });
  });

  server.listen(options.port, () => {
    console.log(`[testbed] libpetri debug UI on http://localhost:${options.port}/debug/petri/ui/`);
  });
  return server;
}
