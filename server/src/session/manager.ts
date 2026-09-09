import { basename } from 'node:path';
import { nanoid } from 'nanoid';

import { emitServerEvent } from '../bus.js';
import { getHarness, loadHarnesses, type Harness } from '../config/harnesses.js';
import { openDb, type Db } from '../db/index.js';
import type { StatusSnapshot } from '../status/engine.js';
import type { Session } from '../status/types.js';
import { PtySession } from './session.js';

/** Per (sessionId, kind) suppression window for desktop notifications. */
const NOTIFY_COOLDOWN_MS = 30_000;

type NotifyKind = 'waiting' | 'done' | 'exited' | 'killed' | 'error';

export interface CreateSessionInput {
  harnessId: string;
  cwd: string;
  title?: string;
}

export interface SessionManagerOptions {
  /** Injectable for tests; defaults to the global YAML registry. */
  harnessLookup?: (id: string) => Harness | undefined;
  /** Valid ids, used only for the "unknown harness" error message. */
  harnessIds?: () => string[];
  /** Injectable clock, so the notification cooldown is testable without waiting 30s. */
  now?: () => number;
  notifyCooldownMs?: number;
  /** Set false in tests that must not touch process-level signal handlers. */
  installProcessHandlers?: boolean;
}

/**
 * Owns every live {@link PtySession} and mirrors their lifecycle onto the
 * event bus and SQLite.
 *
 * Notification *decisions* live here rather than in the browser: the server is
 * the only place that sees every transition for every session, so it is the
 * only place that can dedupe them coherently across tabs.
 */
export class SessionManager {
  private readonly db: Db;
  private readonly harnessLookup: (id: string) => Harness | undefined;
  private readonly harnessIds: () => string[];
  private readonly now: () => number;
  private readonly notifyCooldownMs: number;

  private readonly map = new Map<string, PtySession>();
  private readonly lastNotified = new Map<string, number>();
  private readonly onProcessExit = (): void => this.killAll();
  // Kill sessions but do NOT call process.exit here. This handler is registered
  // at construction, so exiting synchronously would preempt the HTTP server's
  // graceful shutdown. Whoever owns the process lifecycle decides when to exit.
  private readonly onSignal = (): void => {
    this.killAll();
  };
  private processHandlersInstalled = false;
  private disposed = false;

  constructor(db?: Db, opts: SessionManagerOptions = {}) {
    this.db = db ?? openDb();
    this.harnessLookup = opts.harnessLookup ?? getHarness;
    this.harnessIds = opts.harnessIds ?? (() => loadHarnesses().map((h) => h.id));
    this.now = opts.now ?? Date.now;
    this.notifyCooldownMs = opts.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS;

    // Any row still open belongs to a process from a previous run: sessions are
    // killed on server restart, so the record must say so too.
    this.db.closeOrphanedSessions();

    if (opts.installProcessHandlers !== false) {
      process.on('exit', this.onProcessExit);
      process.on('SIGINT', this.onSignal);
      process.on('SIGTERM', this.onSignal);
      this.processHandlersInstalled = true;
    }
  }

  create(input: CreateSessionInput): Session {
    const harness = this.harnessLookup(input.harnessId);
    if (!harness) {
      const valid = this.harnessIds().join(', ') || '(none configured)';
      throw new Error(`Unknown harness "${input.harnessId}". Valid ids: ${valid}`);
    }

    const id = nanoid();
    const title = input.title ?? basename(input.cwd) ?? input.cwd;
    // Constructed first: a bad cwd or a failed spawn must not leave a DB row.
    const session = new PtySession({ id, harness, cwd: input.cwd, title });

    this.map.set(id, session);
    this.db.insertSession({
      id,
      harnessId: harness.id,
      cwd: input.cwd,
      title,
      createdAt: session.info.createdAt,
    });

    session.on('status', (snapshot: StatusSnapshot) => this.onStatus(session, snapshot));
    session.on('exit', (code: number | null) => {
      this.db.markExited(id, code);
    });

    emitServerEvent({ t: 'session:created', session: session.info });
    return session.info;
  }

  get(id: string): PtySession | undefined {
    return this.map.get(id);
  }

  /** Wire info for every live session, newest first. */
  list(): Session[] {
    return [...this.map.values()]
      .map((s) => s.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  kill(id: string): void {
    this.map.get(id)?.kill();
  }

  /** Kills the session and forgets it entirely. */
  remove(id: string): void {
    const session = this.map.get(id);
    if (!session) return;
    this.map.delete(id);
    session.kill();
    session.dispose();
    this.clearNotifyState(id);
    emitServerEvent({ t: 'session:removed', id });
  }

  killAll(): void {
    for (const id of [...this.map.keys()]) this.remove(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killAll();
    if (this.processHandlersInstalled) {
      process.off('exit', this.onProcessExit);
      process.off('SIGINT', this.onSignal);
      process.off('SIGTERM', this.onSignal);
      this.processHandlersInstalled = false;
    }
  }

  private onStatus(session: PtySession, snapshot: StatusSnapshot): void {
    this.db.insertEvent(session.id, snapshot.status, snapshot.waitKind ?? null, snapshot.at);
    emitServerEvent({ t: 'session:updated', session: session.info });
    this.maybeNotify(session, snapshot);
  }

  private maybeNotify(session: PtySession, snapshot: StatusSnapshot): void {
    const decision = describeNotification(session, snapshot);
    if (!decision) return;

    const key = `${session.id}:${decision.kind}`;
    const last = this.lastNotified.get(key);
    const at = this.now();
    if (last !== undefined && at - last < this.notifyCooldownMs) return;
    this.lastNotified.set(key, at);

    emitServerEvent({ t: 'notify', id: session.id, ...decision });
  }

  private clearNotifyState(id: string): void {
    for (const key of [...this.lastNotified.keys()]) {
      if (key.startsWith(`${id}:`)) this.lastNotified.delete(key);
    }
  }
}

interface NotifyDecision {
  kind: NotifyKind;
  title: string;
  body: string;
}

function describeNotification(
  session: PtySession,
  snapshot: StatusSnapshot,
): NotifyDecision | undefined {
  const { harnessName, cwd } = session.info;
  const where = basename(cwd) || cwd;

  switch (snapshot.status) {
    // Both flavours of amber notify, under the same `waiting` kind (so they
    // share one cooldown window), but the wording has to differ: "needs you"
    // for a harness that is modally blocked, "your turn" for a turn-end where
    // nothing is stuck and the ball is simply in your court.
    case 'waiting_input':
      if (snapshot.waitKind === 'turn') {
        return {
          kind: 'waiting',
          title: `${harnessName} finished`,
          body: `${where} · your turn`,
        };
      }
      return {
        kind: 'waiting',
        title: `${harnessName} needs you`,
        body: `${where} · ${snapshot.waitKind ?? 'unknown'}`,
      };
    case 'done':
      return { kind: 'done', title: `${harnessName} finished`, body: where };
    case 'exited':
      return { kind: 'exited', title: `${harnessName} exited`, body: where };
    // 'killed' is deliberately absent: the user just clicked Kill, so telling
    // them it worked is pure noise.
    case 'error':
      return {
        kind: 'error',
        title: `${harnessName} failed`,
        body: `${where} · exit code ${snapshot.exitCode ?? 'unknown'}`,
      };
    default:
      return undefined;
  }
}

let singleton: SessionManager | undefined;

/**
 * The process-wide manager, constructed on first use.
 *
 * Construction opens `~/.agentmaster/db.sqlite` and installs signal handlers,
 * so it must not happen merely because a module was imported — tests import
 * `SessionManager` from here and would otherwise inherit both side effects.
 */
export function getSessions(): SessionManager {
  singleton ??= new SessionManager();
  return singleton;
}

/**
 * Ergonomic alias for {@link getSessions}: `sessions.create(...)` reads better
 * at call sites than `getSessions().create(...)`, and the proxy keeps the
 * construction lazy. Methods are bound to the real instance because private
 * fields cannot be read through a proxy receiver.
 */
export const sessions: SessionManager = new Proxy({} as SessionManager, {
  get(_target, prop) {
    const instance = getSessions() as unknown as Record<string | symbol, unknown>;
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
