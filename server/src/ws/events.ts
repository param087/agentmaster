import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { onServerEvent } from '../bus.js';
import type { SessionManager } from '../session/manager.js';
import type { ServerEvent } from '../status/types.js';

const HEARTBEAT_MS = 30_000;

export interface WsHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

/**
 * `/ws/events` — the dashboard's control channel.
 *
 * Every connection gets a full snapshot first, then a live tail of the bus, so
 * a tab that connects mid-flight is never missing state.
 */
export function createEventsWs(manager: SessionManager): WsHandler {
  const wss = new WebSocketServer({ noServer: true });

  const send = (ws: WebSocket, event: ServerEvent): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
  };

  wss.on('connection', (ws: WebSocket) => {
    let isAlive = true;
    ws.on('pong', () => {
      isAlive = true;
    });

    send(ws, { t: 'snapshot', sessions: manager.list() });

    const unsubscribe = onServerEvent((event) => send(ws, event));

    // A half-open TCP connection looks OPEN forever; without this the bus keeps
    // fanning out into a socket nobody is reading.
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
