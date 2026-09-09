import express, { type ErrorRequestHandler, type Express } from 'express';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_HARNESSES_PATH, loadHarnesses, watchHarnesses } from './config/harnesses.js';
import { fsRouter } from './routes/fs.js';
import { harnessesRouter } from './routes/harnesses.js';
import { pushRouter } from './routes/push.js';
import { sessionsRouter } from './routes/sessions.js';
import { getSessions, type SessionManager } from './session/manager.js';
import { createEventsWs } from './ws/events.js';
import { createTerminalWs } from './ws/terminal.js';

const DEFAULT_PORT = 7180;
/** Locked decision: localhost-only, no auth. Never bind 0.0.0.0. */
const HOST = '127.0.0.1';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = resolve(packageRoot, '..', 'web', 'dist');

export interface CreateServerOptions {
  manager?: SessionManager;
}

export interface AppServer {
  app: Express;
  server: Server;
  close: () => Promise<void>;
}

/** Turns any thrown error into `{error}` with a sane status; never leaks a stack. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status: unknown }).status) || 500
      : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) process.stderr.write(`[http] ${status} ${message}\n`);
  res.status(status).json({ error: message });
};

/**
 * Builds the HTTP + WebSocket server without listening.
 *
 * The manager is injectable so tests can run against an in-memory DB and a fake
 * harness registry instead of the process-wide singleton.
 */
export function createServer(opts: CreateServerOptions = {}): AppServer {
  const manager = opts.manager ?? getSessions();

  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/harnesses', harnessesRouter());
  app.use('/api/sessions', sessionsRouter(manager));
  app.use('/api/fs', fsRouter());
  app.use('/api/push', pushRouter(manager.database));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Only in a built tree: during development Vite serves the frontend and
  // proxies /api and /ws here, so web/dist does not exist.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (_req, res) => {
      res.sendFile(join(WEB_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);

  const server = createHttpServer(app);
  const events = createEventsWs(manager);
  const terminal = createTerminalWs(manager);

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/ws/events') return events.handleUpgrade(req, socket, head);
    if (pathname.startsWith('/ws/term/')) return terminal.handleUpgrade(req, socket, head);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  });

  const close = async (): Promise<void> => {
    events.close();
    terminal.close();
    await new Promise<void>((done) => server.close(() => done()));
  };

  return { app, server, close };
}

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const manager = getSessions();

  let harnessCount = 0;
  try {
    harnessCount = loadHarnesses().length;
  } catch (error) {
    process.stderr.write(
      `[harnesses] failed to load: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const { server, close } = createServer({ manager });
  await new Promise<void>((ready) => server.listen(port, HOST, ready));
  process.stdout.write(`agentmaster listening on http://${HOST}:${port} (${harnessCount} harnesses)\n`);

  // Pick up edits to harnesses.yaml without a restart — restarting would kill
  // every running session, which makes tuning a detection rule painful.
  // A bad edit is logged and the previous config is kept.
  const unwatch = watchHarnesses(DEFAULT_HARNESSES_PATH, (harnesses) => {
    process.stdout.write(`[harnesses] reloaded (${harnesses.length} harnesses)\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[shutdown] ${signal}: killing sessions\n`);
    unwatch();
    manager.killAll();
    void close().then(() => process.exit(0));
  };
  // `SessionManager` installs its own SIGINT/SIGTERM handlers that call
  // `process.exit(0)` immediately; prepending ours guarantees the HTTP server
  // gets a chance to close first.
  process.prependListener('SIGINT', () => shutdown('SIGINT'));
  process.prependListener('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
