import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Harness } from '../src/config/harnesses.js';
import { openDb, type Db } from '../src/db/index.js';
import { SessionManager } from '../src/session/manager.js';
import { hasTmuxSession, tmuxAvailable, tmuxSessionName } from '../src/session/tmux.js';

const TIMEOUT = 30_000;
const available = tmuxAvailable();

const harness: Harness = {
  id: 'tmux-bash',
  name: 'tmux bash',
  command: '/bin/bash',
  args: ['--norc', '--noprofile', '-i'],
  waitingInput: [],
  idleMs: 300,
  finishedAfterBusyMs: 20_000,
};

let dir = '';
let dbFile = '';
const managers: SessionManager[] = [];
const dbs: Db[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error('waitFor timed out');
}

/** A manager as a fresh server process would build it: same database file. */
function boot(): SessionManager {
  const db = openDb(dbFile);
  dbs.push(db);
  const m = new SessionManager(db, {
    backend: 'tmux',
    harnessLookup: (id) => (id === harness.id ? harness : undefined),
    harnessIds: () => [harness.id],
    installProcessHandlers: false,
    push: () => Promise.resolve(),
  });
  managers.push(m);
  return m;
}

/** Simulates the server stopping: release sessions, close the database. */
function stop(m: SessionManager): void {
  m.dispose();
  dbs.splice(dbs.indexOf(m.database), 1);
  m.database.close();
}

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-L', process.env['AGENTMASTER_TMUX_SOCKET']!, ...args], { encoding: 'utf8' });

describe.skipIf(!available)('tmux backend', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-tmux-'));
    process.env['AGENTMASTER_TMUX_SOCKET'] = `am-test-${process.pid}`;
    process.env['AGENTMASTER_STATE_DIR'] = dir;
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.killAll();
    for (const db of dbs.splice(0)) db.close();
  });

  afterAll(() => {
    try {
      tmux('kill-server');
    } catch {
      // No server left: fine.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the agent running across a server restart and re-attaches with history', async () => {
    dbFile = join(dir, 'restart.sqlite');
    const first = boot();
    const info = first.create({ harnessId: harness.id, cwd: tmpdir() });
    const s1 = first.get(info.id)!;
    await waitFor(() => s1.replay().toString('utf8').includes('$'));
    s1.write('echo before-$((40+2))\r');
    await waitFor(() => s1.replay().toString('utf8').includes('before-42'));

    stop(first);
    expect(hasTmuxSession(info.id)).toBe(true);

    const second = boot();
    const s2 = second.get(info.id);
    expect(s2).toBeDefined();
    expect(s2!.info.title).toBe(info.title);
    // Earlier output is back — from tmux history or the repaint on attach.
    await waitFor(() => s2!.replay().toString('utf8').includes('before-42'));

    s2!.write('echo after-$((50+5))\r');
    await waitFor(() => s2!.replay().toString('utf8').includes('after-55'));
    expect(s2!.info.status).not.toBe('killed');
  }, TIMEOUT);

  it('survives two restarts in a row', async () => {
    dbFile = join(dir, 'twice.sqlite');
    const first = boot();
    const info = first.create({ harnessId: harness.id, cwd: tmpdir() });
    await waitFor(() => first.get(info.id)!.replay().length > 0);
    stop(first);
    const second = boot();
    expect(second.get(info.id)).toBeDefined();
    expect(second.database.getSession(info.id)?.exitedAt).toBeNull();
    stop(second);
    const third = boot();
    expect(third.get(info.id)).toBeDefined();
  }, TIMEOUT);

  it('restores scrollback that scrolled off the visible screen', async () => {
    dbFile = join(dir, 'history.sqlite');
    const first = boot();
    const info = first.create({ harnessId: harness.id, cwd: tmpdir() });
    const s1 = first.get(info.id)!;
    await waitFor(() => s1.replay().toString('utf8').includes('$'));
    s1.write('for i in $(seq 1 80); do echo hist-$i; done\r');
    await waitFor(() => s1.replay().toString('utf8').includes('hist-80'));
    stop(first);

    const second = boot();
    // hist-1 is far above a 32-row screen: only capture-pane can bring it back.
    expect(second.get(info.id)!.replay().toString('utf8')).toContain('hist-1\r\n');
  }, TIMEOUT);

  it('Delete ends the tmux session and erases the row, so it never comes back', async () => {
    dbFile = join(dir, 'delete.sqlite');
    const first = boot();
    const info = first.create({ harnessId: harness.id, cwd: tmpdir() });
    await waitFor(() => first.get(info.id)!.replay().length > 0);

    first.remove(info.id);
    expect(hasTmuxSession(info.id)).toBe(false);
    expect(first.database.getSession(info.id)).toBeUndefined();
    stop(first);

    const second = boot();
    expect(second.get(info.id)).toBeUndefined();
    expect(second.list()).toEqual([]);
  }, TIMEOUT);

  it('Kill stops the agent but keeps the session readable', async () => {
    dbFile = join(dir, 'kill.sqlite');
    const m = boot();
    const info = m.create({ harnessId: harness.id, cwd: tmpdir() });
    const s = m.get(info.id)!;
    await waitFor(() => s.replay().length > 0);

    m.kill(info.id);
    await waitFor(() => s.info.status === 'killed');
    expect(hasTmuxSession(info.id)).toBe(false);
    expect(m.database.getSession(info.id)?.exitedAt).not.toBeNull();
    expect(m.get(info.id)).toBeDefined();
  }, TIMEOUT);

  it('records the real exit code of an agent that ended while the server was down', async () => {
    dbFile = join(dir, 'exit.sqlite');
    const first = boot();
    const info = first.create({ harnessId: harness.id, cwd: tmpdir() });
    await waitFor(() => first.get(info.id)!.replay().toString('utf8').includes('$'));
    stop(first);

    expect(hasTmuxSession(info.id)).toBe(true);
    tmux('send-keys', '-t', `=${tmuxSessionName(info.id)}:`, 'exit 3', 'Enter');
    await waitFor(() => !hasTmuxSession(info.id));

    const second = boot();
    expect(second.get(info.id)).toBeUndefined();
    expect(second.database.getSession(info.id)).toMatchObject({ exitCode: 3 });
  }, TIMEOUT);

  it('reports the agent exit code when it ends while attached', async () => {
    dbFile = join(dir, 'live-exit.sqlite');
    const m = boot();
    const info = m.create({ harnessId: harness.id, cwd: tmpdir() });
    const s = m.get(info.id)!;
    await waitFor(() => s.replay().toString('utf8').includes('$'));
    s.write('exit 7\r');
    await waitFor(() => s.info.status === 'error');
    expect(s.info.exitCode).toBe(7);
  }, TIMEOUT);
});
