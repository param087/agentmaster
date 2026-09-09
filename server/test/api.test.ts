import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import type { Harness } from '../src/config/harnesses.js';
import { openDb, type Db } from '../src/db/index.js';
import { createServer, type AppServer } from '../src/index.js';
import { SessionManager } from '../src/session/manager.js';
import type { Session, ServerEvent } from '../src/status/types.js';

/**
 * NOTE ON TIMERS
 *
 * As in engine.test.ts, `vi.useFakeTimers()` is forbidden: `@xterm/headless`
 * schedules its parse loop on the global `setTimeout`, so faking it deadlocks
 * every PTY data path. Real timers plus bounded polling only.
 */

const PTY_TIMEOUT = 10_000;

function bashHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: 'test-bash',
    name: 'Test Bash',
    command: '/bin/bash',
    args: ['-c', 'echo hello; sleep 30'],
    waitingInput: [],
    idleMs: 300,
    finishedAfterBusyMs: 20_000,
    ...overrides,
  };
}

let db: Db | undefined;
let manager: SessionManager | undefined;
let app: AppServer | undefined;
const sockets: WebSocket[] = [];

/** Boots a real server on an ephemeral port with an isolated, in-memory manager. */
async function boot(harness: Harness = bashHarness()): Promise<string> {
  db = openDb(':memory:');
  manager = new SessionManager(db, {
    harnessLookup: (id) => (id === harness.id ? harness : undefined),
    harnessIds: () => [harness.id],
    installProcessHandlers: false,
  });
  app = createServer({ manager });
  await new Promise<void>((ready) => app!.server.listen(0, '127.0.0.1', ready));
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function wsUrl(base: string, path: string): string {
  return `${base.replace('http://', 'ws://')}${path}`;
}

function open(url: string): WebSocket {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return ws;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolves when `predicate` holds, rejecting at the deadline. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('waitFor timed out');
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

async function createSession(base: string, cwd = process.cwd()): Promise<Session> {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harnessId: 'test-bash', cwd }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { session: Session }).session;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  manager?.killAll();
  manager?.dispose();
  await app?.close();
  db?.close();
  app = undefined;
  manager = undefined;
  db = undefined;
});

describe('GET /api/harnesses', () => {
  it('returns the registry without leaking compiled RegExps', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/harnesses`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { harnesses: Array<Record<string, unknown>> };
    expect(Array.isArray(body.harnesses)).toBe(true);
    expect(body.harnesses.length).toBeGreaterThan(0);

    for (const h of body.harnesses) {
      expect(Object.keys(h).sort()).toEqual(['command', 'id', 'name']);
      expect(h['re']).toBeUndefined();
    }
    // A RegExp serialises to `{}`; round-tripping proves none survived.
    expect(JSON.stringify(body)).not.toContain('{}');
    expect(JSON.stringify(body)).not.toContain('waitingInput');
    expect(JSON.stringify(body)).not.toContain('busyMarker');
  });
});

describe('POST /api/sessions', () => {
  it(
    'creates a session that then appears in the list',
    async () => {
      const base = await boot();
      const session = await createSession(base);

      expect(session.id).toBeTruthy();
      expect(session.harnessId).toBe('test-bash');
      expect(session.pid).toBeGreaterThan(0);

      const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Session[];
      };
      expect(list.sessions.map((s) => s.id)).toContain(session.id);
    },
    PTY_TIMEOUT,
  );

  it('rejects a body with no cwd as 400', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harnessId: 'test-bash' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('rejects an unknown harnessId as 400', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harnessId: 'nope', cwd: process.cwd() }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('nope');
  });

  it('rejects a nonexistent cwd as 400', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harnessId: 'test-bash', cwd: '/definitely/not/here' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not exist/i);
  });
});

describe('DELETE /api/sessions/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/sessions/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it(
    'kills a real session but keeps it listed',
    async () => {
      const base = await boot();
      const session = await createSession(base);

      const res = await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Session[];
      };
      expect(list.sessions.map((s) => s.id)).toContain(session.id);
    },
    PTY_TIMEOUT,
  );
});

describe('GET /api/fs/ls', () => {
  it('defaults to the home directory and lists only directories', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/fs/ls`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      dirs: Array<{ name: string; path: string }>;
    };
    expect(body.path).toBe(homedir());
    expect(body.parent).toBe(dirname(homedir()));
    for (const dir of body.dirs) {
      expect(dir.name.startsWith('.')).toBe(false);
      expect(dir.path).toBe(`${homedir()}/${dir.name}`);
    }
    const names = body.dirs.map((d) => d.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  });

  it('expands a leading tilde', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent('~')}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(homedir());
  });

  it('reports null parent at the filesystem root', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/fs/ls?path=/`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { parent: string | null }).parent).toBeNull();
  });

  it('returns 404 for a nonexistent path', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/fs/ls?path=/definitely/not/here`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });
});

describe('/ws/events', () => {
  it(
    'sends a snapshot first, then live session events',
    async () => {
      const base = await boot();
      const ws = open(wsUrl(base, '/ws/events'));
      const messages: ServerEvent[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as ServerEvent));
      await onceOpen(ws);

      await waitFor(() => messages.length >= 1);
      const first = messages[0];
      expect(first?.t).toBe('snapshot');

      const session = await createSession(base);
      await waitFor(() => messages.some((m) => m.t === 'session:created'));

      const created = messages.find((m) => m.t === 'session:created');
      expect(created && 'session' in created ? created.session.id : undefined).toBe(session.id);
    },
    PTY_TIMEOUT,
  );
});

describe('/ws/term/:id', () => {
  it('closes with 4004 for an unknown session', async () => {
    const base = await boot();
    const ws = open(wsUrl(base, '/ws/term/nope'));
    const code = await new Promise<number>((resolve) => ws.once('close', resolve));
    expect(code).toBe(4004);
  });

  it(
    'delivers a replay frame and then live output',
    async () => {
      const base = await boot();
      const session = await createSession(base);
      // Let the harness produce some scrollback before attaching.
      await sleep(400);

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      const frames: Buffer[] = [];
      ws.on('message', (raw) => frames.push(Buffer.from(raw as Buffer)));
      await onceOpen(ws);

      await waitFor(() => Buffer.concat(frames).toString('utf8').includes('hello'));
      expect(frames.length).toBeGreaterThan(0);
      expect(Buffer.concat(frames).toString('utf8')).toContain('hello');
    },
    PTY_TIMEOUT,
  );

  it(
    'round trips keystrokes: browser -> PTY -> browser',
    async () => {
      const base = await boot(bashHarness({ args: [] }));
      const session = await createSession(base);

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      const frames: Buffer[] = [];
      ws.on('message', (raw) => frames.push(Buffer.from(raw as Buffer)));
      await onceOpen(ws);

      // Give the interactive shell time to print its prompt.
      await sleep(500);
      ws.send(Buffer.from('echo roundtrip\n'));

      await waitFor(() => {
        const text = Buffer.concat(frames).toString('utf8');
        // The echoed command plus the shell's own output: at least two hits.
        return text.split('roundtrip').length > 2;
      }, 8000);
    },
    PTY_TIMEOUT,
  );

  it(
    'detaches the viewer when the socket closes',
    async () => {
      const base = await boot();
      const session = await createSession(base);
      const live = manager!.get(session.id)!;

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      await onceOpen(ws);
      await sleep(200);

      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.close();
      await closed;
      // The server-side 'close' handler runs on its own socket; give it a tick.
      await sleep(200);

      // A leaked viewer would still be in the fan-out set. Prove the session is
      // healthy afterwards: a fresh viewer receives output, and nothing throws.
      const seen: Buffer[] = [];
      const viewer = { send: (data: Buffer) => void seen.push(data) };
      live.attach(viewer);
      live.write('echo after\n');
      await waitFor(() => Buffer.concat(seen).length > 0, 4000);
      live.detach(viewer);
      expect(live.info.status).not.toBe('error');
    },
    PTY_TIMEOUT,
  );
});

describe('/ws/term/:id control frames', () => {
  it(
    'never writes a text control frame into the PTY',
    async () => {
      // A bug here would inject `{"type":"focus"}` into the user's live
      // session, so this is asserted against real PTY output, not a spy.
      const base = await boot(bashHarness({ args: ['-c', 'cat'] }));
      const session = await createSession(base);
      const live = manager!.get(session.id)!;

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      const frames: Buffer[] = [];
      ws.on('message', (raw) => frames.push(Buffer.from(raw as Buffer)));
      await onceOpen(ws);
      await sleep(300);

      // Text frames: valid control, malformed JSON, unknown type, wrong shape.
      ws.send(JSON.stringify({ type: 'focus', focused: true }));
      ws.send('{not json at all');
      ws.send(JSON.stringify({ type: 'teleport', focused: true }));
      ws.send(JSON.stringify({ type: 'focus', focused: 'yes' }));
      await sleep(300);

      // `cat` echoes everything it is written, so anything that reached the PTY
      // would be in the output. A marker proves the pipe is actually live.
      ws.send(Buffer.from('MARKER\n'));
      await waitFor(() => Buffer.concat(frames).toString('utf8').includes('MARKER'), 8000);

      const text = Buffer.concat(frames).toString('utf8');
      expect(text).not.toContain('focus');
      expect(text).not.toContain('type');
      expect(text).not.toContain('not json at all');
      expect(text).not.toContain('teleport');
      // The malformed and unknown frames were dropped, not fatal.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      // ...and the one valid control frame was still acted on.
      expect(live.focusedCount).toBe(1);
    },
    PTY_TIMEOUT,
  );

  it(
    'tracks focus state from text control frames',
    async () => {
      const base = await boot();
      const session = await createSession(base);
      const live = manager!.get(session.id)!;

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      await onceOpen(ws);
      await waitFor(() => live.viewerCount === 1);
      // Attached but not focused: a background tab is not a pair of eyes.
      expect(live.focusedCount).toBe(0);

      ws.send(JSON.stringify({ type: 'focus', focused: true }));
      await waitFor(() => live.focusedCount === 1);

      ws.send(JSON.stringify({ type: 'focus', focused: false }));
      await waitFor(() => live.focusedCount === 0);

      ws.send(JSON.stringify({ type: 'focus', focused: true }));
      await waitFor(() => live.focusedCount === 1);

      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.close();
      await closed;
      // Closing must clear BOTH sets, or a dead tab keeps swallowing notifications.
      await waitFor(() => live.viewerCount === 0 && live.focusedCount === 0);
    },
    PTY_TIMEOUT,
  );
});

describe('POST /api/sessions/:id/input and /remove', () => {
  it(
    'writes keys over HTTP and then forgets the session',
    async () => {
      const base = await boot(bashHarness({ args: [] }));
      const session = await createSession(base);

      const bad = await fetch(`${base}/api/sessions/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(`${base}/api/sessions/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: 'echo viahttp\n' }),
      });
      expect(ok.status).toBe(204);

      await waitFor(() =>
        manager!.get(session.id)!.replay().toString('utf8').includes('viahttp'),
      );

      const removed = await fetch(`${base}/api/sessions/${session.id}/remove`, {
        method: 'POST',
      });
      expect(removed.status).toBe(204);

      const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Session[];
      };
      expect(list.sessions.map((s) => s.id)).not.toContain(session.id);
    },
    PTY_TIMEOUT,
  );
});
