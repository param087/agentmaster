import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import type { SessionManager } from '../session/manager.js';
import type { PtySession, SessionViewer } from '../session/session.js';
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
 * Control messages the browser may send as a *text* frame.
 *
 * Only `focus` exists today. Anything else — including malformed JSON — is
 * ignored silently: a browser from a newer build must not be able to kill an
 * otherwise healthy terminal connection.
 */
const controlMessageSchema = z.object({
  type: z.literal('focus'),
  focused: z.boolean(),
});

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function handleControl(text: string, session: PtySession, viewer: SessionViewer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const message = controlMessageSchema.safeParse(parsed);
  if (!message.success) return;
  session.setFocused(viewer, message.data.focused);
}

/**
 * `/ws/term/:id` — a byte pipe between the browser's xterm.js and the PTY.
 *
 * Nothing on the *binary* path decodes, buffers by line, or rewrites anything:
 * full fidelity is exactly what makes arrow keys, `⇧Tab` and Ctrl-C work. Text
 * frames are control messages and never reach the PTY.
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
      // Text frame, deliberately: the browser writes every *binary* message
      // straight into xterm, so control must ride a different opcode or it
      // would be rendered as garbage in the user's terminal.
      sendControl(message) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message), { binary: false });
      },
    };

    // Order is load-bearing: `attach` does not replay, so scrollback must go out
    // before the first live chunk can, or the two interleave.
    viewer.send(session.replay());
    session.attach(viewer);

    // The opcode is the whole protocol, and it is load-bearing:
    //
    //   binary -> keystrokes, forwarded verbatim into the PTY. Verbatim is what
    //             makes arrow keys, ⇧Tab and Ctrl-C work.
    //   text   -> a JSON control message, handled here and NEVER written to the
    //             PTY. A bug in this direction would inject `{"type":"focus"}`
    //             into the user's live session.
    //
    // Nothing falls through: an unparseable or unknown control message is
    // dropped, not forwarded and not fatal.
    ws.on('message', (data, isBinary) => {
      const bytes = toBuffer(data);
      if (isBinary) {
        session.write(bytes);
        return;
      }
      handleControl(bytes.toString('utf8'), session, viewer);
    });

    // A leaked viewer means the session writes into a dead socket forever.
    // `detach` clears the focused set too, so a closed tab stops counting as
    // eyes on the session.
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
