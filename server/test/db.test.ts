import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function seed(id: string, createdAt: number) {
  db.insertSession({
    id,
    harnessId: 'opencode',
    cwd: '/tmp/proj',
    title: `title-${id}`,
    createdAt,
  });
}

describe('migrations', () => {
  function readUserVersion(file: string): number {
    const raw = new Database(file, { readonly: true });
    const v = raw.pragma('user_version', { simple: true }) as number;
    raw.close();
    return v;
  }

  it('applies migration 001 and is idempotent across re-opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmaster-db-'));
    const file = join(dir, 'db.sqlite');
    try {
      const first = openDb(file);
      first.insertSession({
        id: 's1',
        harnessId: 'opencode',
        cwd: '/tmp',
        title: 't',
        createdAt: 1,
      });
      first.close();
      expect(readUserVersion(file)).toBe(1);

      // second open must not re-apply (would throw "table already exists")
      const second = openDb(file);
      expect(second.getSession('s1')?.title).toBe('t');
      second.close();
      expect(readUserVersion(file)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a usable schema for in-memory databases', () => {
    seed('mem', 5);
    expect(db.getSession('mem')?.id).toBe('mem');
  });
});

describe('sessions', () => {
  it('round-trips all fields with camelCase mapping', () => {
    db.insertSession({
      id: 's1',
      harnessId: 'claude',
      cwd: '/home/me/code',
      title: 'my session',
      createdAt: 1000,
    });
    expect(db.getSession('s1')).toEqual({
      id: 's1',
      harnessId: 'claude',
      cwd: '/home/me/code',
      title: 'my session',
      createdAt: 1000,
      exitedAt: null,
      exitCode: null,
    });
  });

  it('returns undefined for an unknown id', () => {
    expect(db.getSession('nope')).toBeUndefined();
  });

  it('markExited sets exitedAt and exitCode', () => {
    seed('s1', 1000);
    db.markExited('s1', 137, 2000);
    const row = db.getSession('s1');
    expect(row?.exitedAt).toBe(2000);
    expect(row?.exitCode).toBe(137);
  });

  it('markExited defaults at to now', () => {
    seed('s1', 1000);
    const before = Date.now();
    db.markExited('s1', 0);
    const row = db.getSession('s1');
    expect(row?.exitedAt).toBeGreaterThanOrEqual(before);
    expect(row?.exitCode).toBe(0);
  });

  it('listSessions returns newest first and respects limit', () => {
    seed('a', 100);
    seed('b', 300);
    seed('c', 200);
    expect(db.listSessions().map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(db.listSessions(2).map((r) => r.id)).toEqual(['b', 'c']);
  });
});

describe('events', () => {
  it('lists events oldest-first with status and waitKind', () => {
    seed('s1', 1000);
    db.insertEvent('s1', 'waiting_input', 'permission', 3000);
    db.insertEvent('s1', 'starting', null, 1000);
    db.insertEvent('s1', 'busy', undefined, 2000);
    const rows = db.listEvents('s1');
    expect(rows.map((r) => [r.status, r.waitKind, r.at])).toEqual([
      ['starting', null, 1000],
      ['busy', null, 2000],
      ['waiting_input', 'permission', 3000],
    ]);
    expect(rows[0]?.sessionId).toBe('s1');
    expect(typeof rows[0]?.id).toBe('number');
  });

  it('insertEvent defaults at to now', () => {
    seed('s1', 1000);
    const before = Date.now();
    db.insertEvent('s1', 'idle');
    expect(db.listEvents('s1')[0]?.at).toBeGreaterThanOrEqual(before);
  });

  it('listEvents respects limit', () => {
    seed('s1', 1000);
    db.insertEvent('s1', 'busy', null, 1);
    db.insertEvent('s1', 'idle', null, 2);
    expect(db.listEvents('s1', 1).map((r) => r.status)).toEqual(['busy']);
  });

  it('throws when inserting an event for a nonexistent session', () => {
    expect(() => db.insertEvent('ghost', 'busy')).toThrow(/FOREIGN KEY/i);
  });
});

describe('closeOrphanedSessions', () => {
  it('closes only open rows and leaves exited rows untouched', () => {
    seed('open1', 100);
    seed('open2', 200);
    seed('done', 300);
    db.markExited('done', 42, 350);

    const n = db.closeOrphanedSessions(9000);
    expect(n).toBe(2);

    expect(db.getSession('open1')?.exitedAt).toBe(9000);
    expect(db.getSession('open1')?.exitCode).toBeNull();
    expect(db.getSession('open2')?.exitedAt).toBe(9000);

    const done = db.getSession('done');
    expect(done?.exitedAt).toBe(350);
    expect(done?.exitCode).toBe(42);

    expect(db.closeOrphanedSessions(9999)).toBe(0);
  });
});

describe('removeSession', () => {
  it('deletes the session and cascades to its events', () => {
    seed('s1', 1000);
    seed('s2', 1000);
    db.insertEvent('s1', 'busy', null, 1);
    db.insertEvent('s1', 'idle', null, 2);
    db.insertEvent('s2', 'busy', null, 1);

    db.removeSession('s1');

    expect(db.getSession('s1')).toBeUndefined();
    expect(db.listEvents('s1')).toEqual([]);
    // sibling session untouched
    expect(db.listEvents('s2')).toHaveLength(1);
  });
});
