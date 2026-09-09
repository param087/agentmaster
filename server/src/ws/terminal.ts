import { WebSocket, WebSocketServer } from 'ws';

import type { SessionManager } from '../session/manager.js';
import type { SessionViewer } from '../session/session.js';
import type { WsHandler } from './events.js';

/** `/ws/term/<id>` → `<id>`. */
export function sessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/ws\/term\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function parseDimension(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : undefined;
}

/**
 * `/ws/term/:id` — a raw byte pipe between the browser's xterm.js and the PTY.
 *
 * Nothing on this path decodes, buffers by line, or rewrites anything: full
 * fidelity is exactly what makes arrow keys, `⇧Tab` and Ctrl-C work.
 */
export function createTerminalWs(manager: SessionManager): WsHandler {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, url: URL) => {
    const id = sessionIdFromPath(url.pathname);
    const session = id ? manager.get(id) : undefined;
    if (!session) {
      ws.close(4004, 'unknown session');
      return;
    }

    const cols = parseDimension(url.searchParams.get('cols'));
    const rows = parseDimension(url.searchParams.get('rows'));
    // Only on an explicit request: the PTY is deliberately fixed at 120x32 so
    // two browsers viewing the same session cannot fight over its geometry.
    if (cols !== undefined && rows !== undefined) session.resize(cols, rows);

    const viewer: SessionViewer = {
      send(data: Buffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
      },
    };

    // Order is load-bearing: `attach` does not replay, so scrollback must go out
    // before the first live chunk can, or the two interleave.
    viewer.send(session.replay());
    session.attach(viewer);

    ws.on('message', (data, isBinary) => {
      void isBinary;
      if (Buffer.isBuffer(data)) return session.write(data);
      if (Array.isArray(data)) return session.write(Buffer.concat(data));
      session.write(Buffer.from(data as ArrayBuffer));
    });

    // A leaked viewer means the session writes into a dead socket forever.
    const detach = (): void => session.detach(viewer);
    ws.on('close', detach);
    ws.on('error', detach);
  });

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
