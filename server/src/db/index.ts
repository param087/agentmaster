import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { SessionStatus, WaitKind } from '../status/types.js';

export interface SessionRow {
  id: string;
  harnessId: string;
  cwd: string;
  title: string;
  createdAt: number;
  exitedAt: number | null;
  exitCode: number | null;
}

export interface EventRow {
  id: number;
  sessionId: string;
  at: number;
  status: SessionStatus;
  waitKind: WaitKind | null;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: number;
  lastOkAt: number | null;
  failures: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export interface Db {
  insertSession(row: Omit<SessionRow, 'exitedAt' | 'exitCode'>): void;
  markExited(id: string, exitCode: number | null, at?: number): void;
  /**
   * Marks a restarted session as running again, keeping its original
   * `created_at` and its full event history.
   */
  reopenSession(id: string): void;
  insertEvent(
    sessionId: string,
    status: SessionStatus,
    waitKind?: WaitKind | null,
    at?: number,
  ): void;
  getSession(id: string): SessionRow | undefined;
  listSessions(limit?: number): SessionRow[];
  listEvents(sessionId: string, limit?: number): EventRow[];
  closeOrphanedSessions(at?: number): number;
  removeSession(id: string): void;

  /** Upsert by endpoint: re-subscribing refreshes the keys and clears failures. */
  savePushSubscription(sub: PushSubscriptionInput, at?: number): void;
  deletePushSubscription(endpoint: string): void;
  listPushSubscriptions(): PushSubscriptionRow[];
  /** Bumps the consecutive failure count, or resets it and stamps `last_ok_at`. */
  recordPushResult(endpoint: string, ok: boolean, at?: number): void;

  close(): void;
}

const MEMORY = ':memory:';
const DEFAULT_SESSION_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 500;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface SessionRecord {
  id: string;
  harness_id: string;
  cwd: string;
  title: string;
  created_at: number;
  exited_at: number | null;
  exit_code: number | null;
}

interface EventRecord {
  id: number;
  session_id: string;
  at: number;
  status: string;
  wait_kind: string | null;
}

interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
}

function toPushSubscriptionRow(r: PushSubscriptionRecord): PushSubscriptionRow {
  return {
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastOkAt: r.last_ok_at,
    failures: r.failures,
  };
}

function defaultDbPath(): string {
  return join(homedir(), '.agentmaster', 'db.sqlite');
}

function toSessionRow(r: SessionRecord): SessionRow {
  return {
    id: r.id,
    harnessId: r.harness_id,
    cwd: r.cwd,
    title: r.title,
    createdAt: r.created_at,
    exitedAt: r.exited_at,
    exitCode: r.exit_code,
  };
}

function toEventRow(r: EventRecord): EventRow {  return {
    id: r.id,
    sessionId: r.session_id,
    at: r.at,
    status: r.status as SessionStatus,
    waitKind: (r.wait_kind as WaitKind | null) ?? null,
  };
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const match = /^(\d+)_(.*)\.sql$/.exec(file);
      if (!match?.[1]) {
        throw new Error(`Malformed migration filename: ${file} (expected NNN_name.sql)`);
      }
      return {
        version: Number.parseInt(match[1], 10),
        name: file,
        sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  const pending = loadMigrations().filter((m) => m.version > current);
  if (pending.length === 0) return;

  for (const migration of pending) {
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
    });
    run();
  }

  const highest = pending[pending.length - 1]!.version;
  sqlite.pragma(`user_version = ${highest}`);
}

export function openDb(path?: string): Db {
  const file = path ?? defaultDbPath();
  const inMemory = file === MEMORY;

  if (!inMemory) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const sqlite = new Database(file);
  if (!inMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  migrate(sqlite);

  const stmts = {
    insertSession: sqlite.prepare(
      `INSERT INTO sessions (id, harness_id, cwd, title, created_at, exited_at, exit_code)
       VALUES (@id, @harnessId, @cwd, @title, @createdAt, NULL, NULL)`,
    ),
    markExited: sqlite.prepare(
      `UPDATE sessions SET exited_at = ?, exit_code = ? WHERE id = ?`,
    ),
    reopenSession: sqlite.prepare(
      `UPDATE sessions SET exited_at = NULL, exit_code = NULL WHERE id = ?`,
    ),
    insertEvent: sqlite.prepare(
      `INSERT INTO events (session_id, at, status, wait_kind) VALUES (?, ?, ?, ?)`,
    ),
    getSession: sqlite.prepare(`SELECT * FROM sessions WHERE id = ?`),
    listSessions: sqlite.prepare(
      `SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ),
    listEvents: sqlite.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY at ASC, id ASC LIMIT ?`,
    ),
    closeOrphaned: sqlite.prepare(
      `UPDATE sessions SET exited_at = ?, exit_code = NULL WHERE exited_at IS NULL`,
    ),
    removeSession: sqlite.prepare(`DELETE FROM sessions WHERE id = ?`),
    savePushSubscription: sqlite.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_ok_at, failures)
       VALUES (@endpoint, @p256dh, @auth, @userAgent, @createdAt, NULL, 0)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         failures = 0`,
    ),
    deletePushSubscription: sqlite.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
    listPushSubscriptions: sqlite.prepare(
      `SELECT * FROM push_subscriptions ORDER BY created_at ASC, endpoint ASC`,
    ),
    pushOk: sqlite.prepare(
      `UPDATE push_subscriptions SET failures = 0, last_ok_at = ? WHERE endpoint = ?`,
    ),
    pushFail: sqlite.prepare(
      `UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?`,
    ),
  };

  return {
    insertSession(row) {
      stmts.insertSession.run(row);
    },
    markExited(id, exitCode, at = Date.now()) {
      stmts.markExited.run(at, exitCode, id);
    },
    reopenSession(id) {
      stmts.reopenSession.run(id);
    },
    insertEvent(sessionId, status, waitKind = null, at = Date.now()) {
      stmts.insertEvent.run(sessionId, at, status, waitKind ?? null);
    },
    getSession(id) {
      const record = stmts.getSession.get(id) as SessionRecord | undefined;
      return record ? toSessionRow(record) : undefined;
    },
    listSessions(limit = DEFAULT_SESSION_LIMIT) {
      return (stmts.listSessions.all(limit) as SessionRecord[]).map(toSessionRow);
    },
    listEvents(sessionId, limit = DEFAULT_EVENT_LIMIT) {
      return (stmts.listEvents.all(sessionId, limit) as EventRecord[]).map(toEventRow);
    },
    closeOrphanedSessions(at = Date.now()) {
      return stmts.closeOrphaned.run(at).changes;
    },
    removeSession(id) {
      stmts.removeSession.run(id);
    },
    savePushSubscription(sub, at = Date.now()) {
      stmts.savePushSubscription.run({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        userAgent: sub.userAgent ?? null,
        createdAt: at,
      });
    },
    deletePushSubscription(endpoint) {
      stmts.deletePushSubscription.run(endpoint);
    },
    listPushSubscriptions() {
      return (stmts.listPushSubscriptions.all() as PushSubscriptionRecord[]).map(
        toPushSubscriptionRow,
      );
    },
    recordPushResult(endpoint, ok, at = Date.now()) {
      if (ok) stmts.pushOk.run(at, endpoint);
      else stmts.pushFail.run(endpoint);
    },
    close() {
      sqlite.close();
    },
  };
}
