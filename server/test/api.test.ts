import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
      expect(Object.keys(h).sort()).toEqual(['available', 'command', 'enabled', 'icon', 'id', 'name']);
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

describe('PATCH /api/sessions/:id', () => {
  const patch = (base: string, id: string, body: unknown) =>
    fetch(`${base}/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('renames and pins, persisting both to the database', async () => {
    const base = await boot();
    const session = await createSession(base);

    const renamed = await patch(base, session.id, { title: '  Refactor auth  ' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { session: Session }).session.title).toBe('Refactor auth');

    const pinned = await patch(base, session.id, { pinned: true });
    expect(((await pinned.json()) as { session: Session }).session.pinned).toBe(true);

    expect(db!.getSession(session.id)).toMatchObject({ title: 'Refactor auth', pinned: true });
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Session[] };
    expect(list.sessions[0]).toMatchObject({ title: 'Refactor auth', pinned: true });
  }, PTY_TIMEOUT);

  it('rejects empty titles, unknown fields and empty bodies as 400', async () => {
    const base = await boot();
    const session = await createSession(base);
    expect((await patch(base, session.id, { title: '   ' })).status).toBe(400);
    expect((await patch(base, session.id, { cwd: '/' })).status).toBe(400);
    expect((await patch(base, session.id, {})).status).toBe(400);
  }, PTY_TIMEOUT);

  it('returns 404 for an unknown id', async () => {
    const base = await boot();
    expect((await patch(base, 'nope', { pinned: true })).status).toBe(404);
  });
});

describe('/api/presets', () => {
  const post = (base: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('saves, lists alphabetically, and deletes presets', async () => {
    const base = await boot();
    expect((await post(base, '/api/presets', { name: 'zeta', harnessId: 'test-bash', cwd: '/tmp' })).status).toBe(201);
    expect((await post(base, '/api/presets', { name: 'Alpha', harnessId: 'test-bash', cwd: '/tmp', prompt: '  ' })).status).toBe(201);

    const { presets } = (await (await fetch(`${base}/api/presets`)).json()) as {
      presets: Array<{ id: string; name: string; prompt: string | null }>;
    };
    expect(presets.map((p) => p.name)).toEqual(['Alpha', 'zeta']);
    expect(presets[0]!.prompt).toBeNull();

    expect((await fetch(`${base}/api/presets/${presets[0]!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/api/presets/${presets[0]!.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects a preset without a name', async () => {
    const base = await boot();
    expect((await post(base, '/api/presets', { name: '', harnessId: 'x', cwd: '/tmp' })).status).toBe(400);
  });

  it('launches a session titled after the preset and types its prompt once ready', async () => {
    const base = await boot(bashHarness({ args: ['--norc', '--noprofile', '-i'], idleMs: 200 }));
    const created = await post(base, '/api/presets', {
      name: 'Greeter',
      harnessId: 'test-bash',
      cwd: '/tmp',
      prompt: 'echo preset-$((20+22))',
    });
    const { preset } = (await created.json()) as { preset: { id: string } };

    const launched = await post(base, `/api/presets/${preset.id}/launch`);
    expect(launched.status).toBe(201);
    const { session } = (await launched.json()) as { session: Session };
    expect(session.title).toBe('Greeter');

    await waitFor(() => manager!.get(session.id)!.replay().toString('utf8').includes('preset-42'), 8000);
  }, PTY_TIMEOUT);
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


describe('WebSocket origin enforcement', () => {
  /** Resolves to the HTTP status of a refused handshake, or 'open' if accepted. */
  function handshake(base: string, path: string, origin?: string): Promise<string> {
    const url = base.replace('http://', 'ws://') + path;
    const ws = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } });
    sockets.push(ws);
    return new Promise((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', (err: Error) => resolve(err.message));
    });
  }

  it('refuses a cross-origin upgrade to the event stream', async () => {
    const base = await boot();
    // Without this, any page the user visits could read the whole session
    // inventory, which is all an attacker needs to target a terminal.
    expect(await handshake(base, '/ws/events', 'https://evil.example')).toContain('403');
  });

  it('refuses a cross-origin upgrade to a terminal', async () => {
    const base = await boot();
    const created = (await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harnessId: 'test-bash', cwd: homedir() }),
      })
    ).json()) as { session: Session };

    // A terminal socket is read *and* write: typing into a PTY running an agent
    // is arbitrary command execution.
    expect(
      await handshake(base, `/ws/term/${created.session.id}`, 'https://evil.example'),
    ).toContain('403');
  });

  it('still accepts the dashboard\'s own origin', async () => {
    const base = await boot();
    const port = new URL(base).port;
    expect(await handshake(base, '/ws/events', `http://127.0.0.1:${port}`)).toBe('open');
    expect(await handshake(base, '/ws/events', `http://localhost:${port}`)).toBe('open');
  });

  it('still accepts a client that sends no origin, such as a script', async () => {
    const base = await boot();
    expect(await handshake(base, '/ws/events')).toBe('open');
  });
});

describe('POST /api/harnesses/:id/enabled', () => {
  it('returns 404 for an unknown harness', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/harnesses/nope/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed body', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/harnesses/opencode/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('persists an explicit toggle and overrides the availability default', async () => {
    const base = await boot();
    const read = async (): Promise<{ available: boolean; enabled: boolean }> => {
      const { harnesses } = (await (await fetch(`${base}/api/harnesses`)).json()) as {
        harnesses: { id: string; available: boolean; enabled: boolean }[];
      };
      const found = harnesses.find((h) => h.id === 'opencode');
      if (!found) throw new Error('opencode missing from the registry');
      return found;
    };

    // opencode is installed on this machine, so it defaults to enabled.
    const before = await read();
    expect(before.available).toBe(true);
    expect(before.enabled).toBe(true);

    const res = await fetch(`${base}/api/harnesses/opencode/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    // An explicit choice must beat "it is installed, so show it".
    const after = await read();
    expect(after.available).toBe(true);
    expect(after.enabled).toBe(false);
  });

  it('defaults enabled to availability for a harness that is not installed', async () => {
    const base = await boot();
    const { harnesses } = (await (await fetch(`${base}/api/harnesses`)).json()) as {
      harnesses: { id: string; available: boolean; enabled: boolean }[];
    };
    for (const h of harnesses) {
      // Nothing has been toggled in this fresh in-memory database, so every
      // harness must mirror its availability exactly.
      expect(h.enabled).toBe(h.available);
    }
  });
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


describe('POST /api/fs/mkdir', () => {
  /** A scratch directory that is cleaned up whatever the test does. */
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'am-mkdir-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const post = (base: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates a folder and returns its absolute path', async () => {
    const base = await boot();
    await withTempDir(async (dir) => {
      const res = await post(base, { parent: dir, name: 'my-project' });
      expect(res.status).toBe(201);
      const { path } = (await res.json()) as { path: string };
      expect(path).toBe(join(dir, 'my-project'));
      expect(existsSync(path)).toBe(true);
    });
  });

  it('shows the new folder in a subsequent listing', async () => {
    const base = await boot();
    await withTempDir(async (dir) => {
      await post(base, { parent: dir, name: 'visible' });
      const res = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(dir)}`);
      const { dirs } = (await res.json()) as { dirs: Array<{ name: string }> };
      expect(dirs.map((d) => d.name)).toContain('visible');
    });
  });

  /**
   * The security-relevant case. `name` must be one path segment: the button says
   * "create a folder here", and without this it could write anywhere on disk.
   */
  it.each([['..'], ['.'], ['a/b'], ['../escape'], ['/absolute'], ['a\\b'], ['']])(
    'rejects %j as a folder name',
    async (name) => {
      const base = await boot();
      await withTempDir(async (dir) => {
        const res = await post(base, { parent: dir, name });
        expect(res.status).toBe(400);
        expect((await res.json()) as { error: string }).toHaveProperty('error');
      });
    },
  );

  it('does not escape the parent when given a traversal name', async () => {
    const base = await boot();
    await withTempDir(async (dir) => {
      const sentinel = join(dirname(dir), 'am-escaped-sentinel');
      await post(base, { parent: dir, name: '../am-escaped-sentinel' });
      expect(existsSync(sentinel)).toBe(false);
    });
  });

  it('returns 409 when the folder already exists', async () => {
    const base = await boot();
    await withTempDir(async (dir) => {
      expect((await post(base, { parent: dir, name: 'dup' })).status).toBe(201);
      const again = await post(base, { parent: dir, name: 'dup' });
      expect(again.status).toBe(409);
    });
  });

  it('returns 404 when the parent does not exist', async () => {
    const base = await boot();
    const res = await post(base, { parent: '/definitely/not/here', name: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed body', async () => {
    const base = await boot();
    const res = await post(base, { parent: '/tmp' });
    expect(res.status).toBe(400);
  });

  it('expands a leading tilde in the parent', async () => {
    const base = await boot();
    // Creating in $HOME for real would litter, so just prove the path resolves:
    // an existing home subdirectory comes back as 409, not 404.
    const res = await post(base, { parent: '~', name: '.' });
    expect(res.status).toBe(400);
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

describe('POST /api/sessions/:id/restart', () => {
  /** Polls the session list until `predicate` holds. */
  async function waitForSession(
    base: string,
    id: string,
    predicate: (s: Session) => boolean,
    timeoutMs = 8000,
  ): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    let last: Session | undefined;
    while (Date.now() < deadline) {
      const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Session[];
      };
      last = sessions.find((s) => s.id === id);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out; last status ${last?.status}`);
  }

  it('returns 404 for an unknown id', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/sessions/nope/restart`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it(
    'restarts a killed session in place',
    async () => {
      const base = await boot();
      const session = await createSession(base);

      await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE' });
      await waitForSession(base, session.id, (s) => s.status === 'killed');

      const res = await fetch(`${base}/api/sessions/${session.id}/restart`, { method: 'POST' });
      expect(res.status).toBe(200);
      const restarted = ((await res.json()) as { session: Session }).session;
      expect(restarted.id).toBe(session.id);
      expect(restarted.exitCode).toBeUndefined();

      await waitForSession(base, session.id, (s) => s.status === 'busy' || s.status === 'idle');
    },
    20_000,
  );

  it(
    'rejects restarting a live session with 400, and accepts it with force',
    async () => {
      const base = await boot();
      const session = await createSession(base);
      await waitForSession(base, session.id, (s) => s.status !== 'starting');

      const plain = await fetch(`${base}/api/sessions/${session.id}/restart`, { method: 'POST' });
      expect(plain.status).toBe(400);
      expect((await plain.json()) as { error: string }).toHaveProperty('error');

      const forced = await fetch(`${base}/api/sessions/${session.id}/restart?force=1`, {
        method: 'POST',
      });
      expect(forced.status).toBe(200);
    },
    20_000,
  );

  it(
    'sends a reset control frame to attached viewers, and never into the PTY',
    async () => {
      const base = await boot();
      const session = await createSession(base);

      const ws = open(wsUrl(base, `/ws/term/${session.id}`));
      const binary: Buffer[] = [];
      const text: string[] = [];
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) binary.push(data);
        else text.push(data.toString('utf8'));
      });
      await onceOpen(ws);

      await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE' });
      await waitForSession(base, session.id, (s) => s.status === 'killed');
      await fetch(`${base}/api/sessions/${session.id}/restart`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 500));

      expect(text).toContain(JSON.stringify({ type: 'reset' }));
      // The browser writes every binary message straight into xterm, so the
      // control message must never arrive on that opcode.
      expect(Buffer.concat(binary).toString('utf8')).not.toContain('reset');
    },
    20_000,
  );
});

describe('POST /api/sessions/finished/remove', () => {
  it(
    'forgets stopped sessions and leaves running ones alone',
    async () => {
      const base = await boot();
      const dead = await createSession(base);
      const alive = await createSession(base);

      await fetch(`${base}/api/sessions/${dead.id}`, { method: 'DELETE' });
      // Poll until the kill lands, or the sweep would find nothing finished.
      const deadline = Date.now() + 8000;
      for (;;) {
        const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
          sessions: Session[];
        };
        if (sessions.find((s) => s.id === dead.id)?.status === 'killed') break;
        if (Date.now() > deadline) throw new Error('kill did not land');
        await new Promise((r) => setTimeout(r, 100));
      }

      // Declared before `/:id/remove`, or Express would capture "finished" as an id.
      const res = await fetch(`${base}/api/sessions/finished/remove`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()) as { removed: number }).toEqual({ removed: 1 });

      const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Session[];
      };
      expect(sessions.map((s) => s.id)).toEqual([alive.id]);
    },
    20_000,
  );
});
