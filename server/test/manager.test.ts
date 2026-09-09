import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { onServerEvent } from '../src/bus.js';
import type { Harness } from '../src/config/harnesses.js';
import { openDb, type Db } from '../src/db/index.js';
import { SessionManager } from '../src/session/manager.js';
import type { PtySession, SessionViewer } from '../src/session/session.js';
import type { ServerEvent, SessionStatus } from '../src/status/types.js';

/**
 * NOTE ON TIMERS
 *
 * As in engine.test.ts, `vi.useFakeTimers()` is forbidden: `@xterm/headless`
 * schedules its parse loop on the global `setTimeout`, so faking it deadlocks
 * `ScreenModel.write()` and therefore every PTY data path. These tests use real
 * timers with short (`idleMs: 300`) harness settings and bounded polling.
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `predicate` until it is true or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('waitFor timed out');
}

function waitForStatus(session: PtySession, status: SessionStatus, timeoutMs = 5000): Promise<void> {
  if (session.info.status === status) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('status', onStatus);
      reject(new Error(`timed out waiting for status "${status}", last was "${session.info.status}"`));
    }, timeoutMs);
    function onStatus(): void {
      if (session.info.status !== status) return;
      clearTimeout(timer);
      session.off('status', onStatus);
      resolve();
    }
    session.on('status', onStatus);
  });
}

class CollectingViewer implements SessionViewer {
  readonly chunks: Buffer[] = [];
  send(data: Buffer): void {
    this.chunks.push(data);
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

let db: Db | undefined;
let manager: SessionManager | undefined;
let unsubscribes: Array<() => void> = [];

function newManager(harness: Harness = bashHarness(), opts: { now?: () => number } = {}): SessionManager {
  db = openDb(':memory:');
  manager = new SessionManager(db, {
    harnessLookup: (id) => (id === harness.id ? harness : undefined),
    harnessIds: () => [harness.id, 'other-harness'],
    ...opts,
  });
  return manager;
}

function collectEvents(): ServerEvent[] {
  const events: ServerEvent[] = [];
  unsubscribes.push(onServerEvent((e) => events.push(e)));
  return events;
}

afterEach(() => {
  for (const un of unsubscribes) un();
  unsubscribes = [];
  manager?.dispose();
  manager = undefined;
  db?.close();
  db = undefined;
});

describe('SessionManager.create', () => {
  it('returns wire info with harnessId, cwd, title and starting status', () => {
    const m = newManager();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });

    expect(info.harnessId).toBe('test-bash');
    expect(info.harnessName).toBe('Test Bash');
    expect(info.cwd).toBe(tmpdir());
    expect(info.title).toBe(basename(tmpdir()));
    expect(info.status).toBe('starting');
    expect(info.id).toBeTruthy();
    expect(info.pid).toBeGreaterThan(0);
  });

  it('defaults the title to the basename of cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmaster-'));
    try {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: dir });
      expect(info.title).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses an explicit title when given', () => {
    const m = newManager();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir(), title: 'My Session' });
    expect(info.title).toBe('My Session');
  });

  it('throws listing valid ids for an unknown harnessId', () => {
    const m = newManager();
    expect(() => m.create({ harnessId: 'nope', cwd: tmpdir() })).toThrow(/nope/);
    expect(() => m.create({ harnessId: 'nope', cwd: tmpdir() })).toThrow(/test-bash/);
  });

  it('throws a clear error for a nonexistent cwd', () => {
    const m = newManager();
    expect(() =>
      m.create({ harnessId: 'test-bash', cwd: '/definitely/not/a/real/dir' }),
    ).toThrow(/\/definitely\/not\/a\/real\/dir/);
  });
});

describe('PtySession output fan-out', () => {
  it(
    'writes output to the ring buffer',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      await waitFor(() => session.replay().toString('utf8').includes('hello'));
      expect(session.replay().toString('utf8')).toContain('hello');
    },
    PTY_TIMEOUT,
  );

  it(
    'delivers bytes to an attached viewer',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;
      const viewer = new CollectingViewer();
      session.attach(viewer);

      await waitFor(() => viewer.text().includes('hello'));
      expect(viewer.text()).toContain('hello');
    },
    PTY_TIMEOUT,
  );

  it(
    'drops a viewer that throws without breaking the others',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      let badCalls = 0;
      const bad: SessionViewer = {
        send() {
          badCalls += 1;
          throw new Error('socket closed');
        },
      };
      const good = new CollectingViewer();
      session.attach(bad);
      session.attach(good);

      await waitFor(() => good.text().includes('hello'));
      session.write('echo more\n');
      await sleep(300);

      expect(badCalls).toBe(1);
      expect(good.chunks.length).toBeGreaterThan(0);
    },
    PTY_TIMEOUT,
  );
});

describe('PtySession status', () => {
  it(
    'reaches busy then idle',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      const seen: SessionStatus[] = [];
      session.on('status', () => seen.push(session.info.status));

      await waitForStatus(session, 'idle');
      expect(seen).toContain('busy');
      expect(seen).toContain('idle');
      expect(session.info.statusChangedAt).toBeGreaterThan(0);
    },
    PTY_TIMEOUT,
  );

  it(
    'round-trips a write through the pty',
    async () => {
      const m = newManager(bashHarness({ args: [] }));
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      await sleep(300);
      session.write('echo roundtrip\n');

      await waitFor(() => session.replay().toString('utf8').includes('roundtrip'));
      expect(session.replay().toString('utf8')).toContain('roundtrip');
    },
    PTY_TIMEOUT,
  );

  it(
    'reports killed, not exited, when the user kills the session',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      const exited = new Promise<number | null>((resolve) => session.once('exit', resolve));
      await sleep(200);
      session.kill();
      await exited;
      await waitFor(() => session.info.status === 'killed');

      // SIGTERM commonly yields exit code 0; only intent distinguishes the two.
      expect(session.info.status).toBe('killed');
    },
    PTY_TIMEOUT,
  );

  it(
    'reports exited for a harness that ends on its own with code 0',
    async () => {
      const m = newManager(bashHarness({ args: ['-c', 'exit 0'] }));
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      await waitFor(() => session.info.status === 'exited');
      expect(session.info.status).toBe('exited');
      expect(session.info.exitCode).toBe(0);
    },
    PTY_TIMEOUT,
  );

  it(
    'reports error for a non-zero exit',
    async () => {
      const m = newManager(bashHarness({ args: ['-c', 'exit 3'] }));
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      await waitFor(() => session.info.status === 'error');
      expect(session.info.status).toBe('error');
      expect(session.info.exitCode).toBe(3);
    },
    PTY_TIMEOUT,
  );
});

describe('done acknowledgement', () => {
  it(
    'flips a done session to idle when a viewer focuses it',
    async () => {
      // finishedAfterBusyMs: 0 makes any busy stretch count as a finished task.
      // Output must span real time: `done` is measured from the first byte to the
      // last, so a single `echo` has a zero-length busy stretch by definition.
      const m = newManager(
        bashHarness({
          finishedAfterBusyMs: 0,
          args: ['-c', 'echo a; sleep 0.2; echo b; sleep 30'],
        }),
      );
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      await waitForStatus(session, 'done');
      expect(session.info.status).toBe('done');

      // UPDATED SEMANTICS: attaching is not looking. A socket open in a
      // background tab must leave the session green.
      const viewer = new CollectingViewer();
      session.attach(viewer);
      expect(session.info.status).toBe('done');
      expect(session.focusedCount).toBe(0);

      session.setFocused(viewer, true);
      expect(session.focusedCount).toBe(1);
      expect(session.info.status).toBe('idle');
    },
    PTY_TIMEOUT,
  );

  it(
    'never emits done while a viewer is focused, emitting exactly one idle',
    async () => {
      // Output must span real time: `done` is measured from the first byte to the
      // last, so a single `echo` has a zero-length busy stretch by definition.
      const m = newManager(
        bashHarness({
          finishedAfterBusyMs: 0,
          args: ['-c', 'echo a; sleep 0.2; echo b; sleep 30'],
        }),
      );
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;
      const viewer = new CollectingViewer();
      session.attach(viewer);
      session.setFocused(viewer, true);

      const seen: SessionStatus[] = [];
      session.on('status', (s: { status: SessionStatus }) => seen.push(s.status));

      await waitForStatus(session, 'idle');
      await sleep(300);

      expect(seen).not.toContain('done');
      expect(seen.filter((s) => s === 'idle')).toHaveLength(1);
      expect(session.info.status).toBe('idle');
    },
    PTY_TIMEOUT,
  );

  it(
    'still goes done for a session watched only by a background tab',
    async () => {
      // The bug this whole change exists to fix: attached ≠ looking at it.
      const m = newManager(
        bashHarness({
          finishedAfterBusyMs: 0,
          args: ['-c', 'echo a; sleep 0.2; echo b; sleep 30'],
        }),
      );
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;
      const viewer = new CollectingViewer();
      session.attach(viewer);
      session.setFocused(viewer, false);

      await waitForStatus(session, 'done');
      expect(session.info.status).toBe('done');
      expect(session.viewerCount).toBe(1);
      expect(session.focusedCount).toBe(0);
    },
    PTY_TIMEOUT,
  );

  it('drops a viewer from both sets on detach', () => {
    const m = newManager();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const session = m.get(info.id)!;
    const viewer = new CollectingViewer();

    session.attach(viewer);
    session.setFocused(viewer, true);
    expect(session.viewerCount).toBe(1);
    expect(session.focusedCount).toBe(1);

    session.detach(viewer);
    expect(session.viewerCount).toBe(0);
    expect(session.focusedCount).toBe(0);
  });

  it('ignores focus from a viewer that never attached', () => {
    const m = newManager();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const session = m.get(info.id)!;

    session.setFocused(new CollectingViewer(), true);
    expect(session.focusedCount).toBe(0);
  });
});

describe('SessionManager lifecycle', () => {
  it('lists sessions newest first and killAll empties the list', () => {
    const m = newManager();
    const a = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const b = m.create({ harnessId: 'test-bash', cwd: tmpdir() });

    const ids = m.list().map((s) => s.id);
    expect(ids).toEqual([b.id, a.id]);

    m.killAll();
    expect(m.list()).toEqual([]);
  });

  it('emits session:created and session:removed on the bus', async () => {
    const m = newManager();
    const events = collectEvents();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });

    expect(events.some((e) => e.t === 'session:created' && e.session.id === info.id)).toBe(true);

    m.remove(info.id);
    expect(events.some((e) => e.t === 'session:removed' && e.id === info.id)).toBe(true);
    expect(m.get(info.id)).toBeUndefined();
  });
});

describe('notifications', () => {
  it('emits a notify event on a waiting_input transition', () => {
    const m = newManager();
    const events = collectEvents();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const session = m.get(info.id)!;

    session.emit('status', { status: 'waiting_input', waitKind: 'permission', at: Date.now() });

    const notify = events.find((e) => e.t === 'notify');
    expect(notify).toBeDefined();
    if (notify?.t !== 'notify') throw new Error('unreachable');
    expect(notify.kind).toBe('waiting');
    expect(notify.title).toContain('Test Bash');
    expect(notify.body).toContain('permission');
  });

  it('words a generic turn-end as "your turn", under the same waiting kind', () => {
    const m = newManager();
    const events = collectEvents();
    const cwd = tmpdir();
    const info = m.create({ harnessId: 'test-bash', cwd });
    const session = m.get(info.id)!;

    session.emit('status', { status: 'waiting_input', waitKind: 'turn', at: Date.now() });

    const notify = events.find((e) => e.t === 'notify');
    if (notify?.t !== 'notify') throw new Error('expected a notify event');
    // Still `waiting`, so both flavours of amber share one cooldown window.
    expect(notify.kind).toBe('waiting');
    expect(notify.title).toBe('Test Bash finished');
    expect(notify.body).toBe(`${basename(cwd)} · your turn`);
  });

  it('suppresses a second notify of the same kind within the cooldown window', () => {
    let clock = 1_000_000;
    const m = newManager(bashHarness(), { now: () => clock });
    const events = collectEvents();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const session = m.get(info.id)!;

    const waiting = { status: 'waiting_input' as const, waitKind: 'permission' as const, at: 0 };
    session.emit('status', waiting);
    clock += 10_000;
    session.emit('status', waiting);

    expect(events.filter((e) => e.t === 'notify').length).toBe(1);

    clock += 30_001;
    session.emit('status', waiting);
    expect(events.filter((e) => e.t === 'notify').length).toBe(2);
  });

  it('does not share the cooldown across kinds or sessions', () => {
    let clock = 1_000_000;
    const m = newManager(bashHarness(), { now: () => clock });
    const events = collectEvents();
    const a = m.get(m.create({ harnessId: 'test-bash', cwd: tmpdir() }).id)!;
    const b = m.get(m.create({ harnessId: 'test-bash', cwd: tmpdir() }).id)!;

    a.emit('status', { status: 'waiting_input', waitKind: 'question', at: 0 });
    a.emit('status', { status: 'done', at: 0 });
    b.emit('status', { status: 'waiting_input', waitKind: 'question', at: 0 });

    const kinds = events.filter((e) => e.t === 'notify').map((e) => (e.t === 'notify' ? e.kind : ''));
    expect(kinds).toEqual(['waiting', 'done', 'waiting']);
    clock += 0;
  });

  it('includes the exit code in an error notification', () => {
    const m = newManager();
    const events = collectEvents();
    const session = m.get(m.create({ harnessId: 'test-bash', cwd: tmpdir() }).id)!;

    session.emit('status', { status: 'error', exitCode: 137, at: Date.now() });

    const notify = events.find((e) => e.t === 'notify');
    if (notify?.t !== 'notify') throw new Error('expected a notify event');
    expect(notify.kind).toBe('error');
    expect(notify.body).toContain('137');
  });

  it('does not notify for plain idle', () => {
    const m = newManager();
    const events = collectEvents();
    const session = m.get(m.create({ harnessId: 'test-bash', cwd: tmpdir() }).id)!;

    session.emit('status', { status: 'idle', at: Date.now() });
    expect(events.filter((e) => e.t === 'notify')).toEqual([]);
  });

  it('does not notify for a killed session — the user just clicked the button', () => {
    const m = newManager();
    const events = collectEvents();
    const session = m.get(m.create({ harnessId: 'test-bash', cwd: tmpdir() }).id)!;

    session.emit('status', { status: 'killed', exitCode: 0, at: Date.now() });
    expect(events.filter((e) => e.t === 'notify')).toEqual([]);
  });

  it('persists done and killed to the events table', () => {
    const m = newManager();
    const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
    const session = m.get(info.id)!;

    session.emit('status', { status: 'done', at: 1 });
    session.emit('status', { status: 'killed', exitCode: 0, at: 2 });

    const statuses = db!.listEvents(info.id).map((e) => e.status);
    expect(statuses).toContain('done');
    expect(statuses).toContain('killed');
  });
});

describe('persistence', () => {
  it(
    'writes a session row and status events, and marks exit',
    async () => {
      const m = newManager();
      const info = m.create({ harnessId: 'test-bash', cwd: tmpdir() });
      const session = m.get(info.id)!;

      expect(db!.getSession(info.id)).toBeDefined();

      await waitForStatus(session, 'idle');
      const exited = new Promise<void>((resolve) => session.once('exit', () => resolve()));
      session.kill();
      await exited;
      await sleep(50);

      const events = db!.listEvents(info.id);
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((e) => e.status)).toContain('busy');
      expect(db!.getSession(info.id)?.exitedAt).not.toBeNull();
    },
    PTY_TIMEOUT,
  );

  it('closes orphaned sessions from a previous run on construction', () => {
    const scratch = openDb(':memory:');
    scratch.insertSession({
      id: 'stale',
      harnessId: 'test-bash',
      cwd: tmpdir(),
      title: 'stale',
      createdAt: Date.now(),
    });
    expect(scratch.getSession('stale')?.exitedAt).toBeNull();

    const m = new SessionManager(scratch, { harnessLookup: () => undefined });
    expect(scratch.getSession('stale')?.exitedAt).not.toBeNull();

    m.dispose();
    scratch.close();
  });
});
