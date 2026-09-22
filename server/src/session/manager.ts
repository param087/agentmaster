import { basename } from 'node:path';
import { nanoid } from 'nanoid';

import { emitServerEvent } from '../bus.js';
import { getHarness, loadHarnesses, type Harness } from '../config/harnesses.js';
import { openDb, type Db, type SessionMetaPatch } from '../db/index.js';
import { sendPush, type PushPayload } from '../push/sender.js';
import type { StatusSnapshot } from '../status/engine.js';
import {
  isTerminalStatus,
  type NotifyKind,
  type GeneralSettings,
  type NotifyPrefs,
  type Session,
} from '../status/types.js';
import { isMuted, shouldPush } from '../notify/policy.js';
import { readGitStatus } from '../git/status.js';
import { PtySession } from './session.js';
import { formatPrompt } from '../../../shared/prompt.js';

/** Per (sessionId, kind) suppression window for desktop notifications. */
const NOTIFY_COOLDOWN_MS = 30_000;


/**
 * Kinds that are worth a *phone* buzz by default.
 *
 * Desktop notifications are cheap and in context: you are already at the
 * machine, and dismissing one costs nothing. A pocket vibration is not — it
 * interrupts whatever you are doing, wherever you are. So the phone only hears
 * about genuinely blocking states: a session waiting on you, or one that
 * crashed. `done`/`exited`/`killed` are informational; they will still be on
 * the dashboard when you next look.
 *
 * Override with AGENTMASTER_PUSH_KINDS="waiting,error,done".
 */
const DEFAULT_PUSH_KINDS: readonly NotifyKind[] = ['waiting', 'error'];

const NOTIFY_PREFS_KEY = 'notify';
const GENERAL_SETTINGS_KEY = 'general';
/** How often stopped sessions are checked against the prune setting. */
const PRUNE_INTERVAL_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
/** Coalesces the git re-read after a burst of status changes. */
const GIT_REFRESH_DEBOUNCE_MS = 750;
/** Browsers render at most two notification buttons. */
const MAX_NOTIFICATION_ACTIONS = 2;
/** Preview lines appended to a waiting notification, so it reads without opening. */
const NOTIFICATION_PREVIEW_LINES = 2;
const NOTIFICATION_PREVIEW_CHARS = 160;

const ALL_NOTIFY_KINDS: readonly NotifyKind[] = [
  'waiting',
  'done',
  'exited',
  'killed',
  'error',
];

function isNotifyKind(value: string): value is NotifyKind {
  return (ALL_NOTIFY_KINDS as readonly string[]).includes(value);
}

/** Parses AGENTMASTER_PUSH_KINDS, falling back to the default set. */
export function resolvePushKinds(raw = process.env['AGENTMASTER_PUSH_KINDS']): Set<NotifyKind> {
  if (raw === undefined) return new Set(DEFAULT_PUSH_KINDS);
  const kinds = raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .filter(isNotifyKind);
  // An explicit empty value means "no push at all", which is a legitimate
  // choice, so it is honoured rather than silently reset to the default.
  return new Set(kinds);
}

export interface CreateSessionInput {
  harnessId: string;
  cwd: string;
  title?: string;
  /** Typed into the harness once it first settles (idle or waiting). */
  initialPrompt?: string;
}

/** Statuses meaning "the harness has drawn its UI and is ready for input". */
const READY_STATUSES = new Set(['idle', 'waiting_input', 'done']);
/** A harness that never settles still gets its prompt, rather than silently none. */
const INITIAL_PROMPT_DEADLINE_MS = 30_000;

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
  /**
   * Injectable Web Push sender, so tests never reach the network. Defaults to
   * the real one, which fans out to every stored subscription.
   */
  push?: (db: Db, payload: PushPayload) => Promise<unknown>;
  /** Overrides AGENTMASTER_PUSH_KINDS; mainly a test seam. */
  pushKinds?: Iterable<NotifyKind>;
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
  private readonly push: (db: Db, payload: PushPayload) => Promise<unknown>;
  private readonly pushKinds: Set<NotifyKind>;

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
  private readonly pruneTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(db?: Db, opts: SessionManagerOptions = {}) {
    this.db = db ?? openDb();
    this.harnessLookup = opts.harnessLookup ?? getHarness;
    this.harnessIds = opts.harnessIds ?? (() => loadHarnesses().map((h) => h.id));
    this.now = opts.now ?? Date.now;
    this.notifyCooldownMs = opts.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS;
    this.push = opts.push ?? sendPush;
    this.pushKinds = opts.pushKinds ? new Set(opts.pushKinds) : resolvePushKinds();

    // Any row still open belongs to a process from a previous run: sessions are
    // killed on server restart, so the record must say so too.
    this.db.closeOrphanedSessions();

    this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

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

    if (input.initialPrompt?.trim()) this.queueInitialPrompt(session, input.initialPrompt);
    this.refreshGit(session);

    emitServerEvent({ t: 'session:created', session: session.info });
    return session.info;
  }

  private queueInitialPrompt(session: PtySession, prompt: string): void {
    let sent = false;
    const deliver = (): void => {
      if (sent) return;
      sent = true;
      clearTimeout(deadline);
      session.off('status', onStatus);
      // Agent CLIs enable bracketed paste, so multi-line prompts arrive whole.
      session.write(formatPrompt(prompt, true));
    };
    const onStatus = (snapshot: StatusSnapshot): void => {
      if (READY_STATUSES.has(snapshot.status)) deliver();
    };
    const deadline = setTimeout(deliver, INITIAL_PROMPT_DEADLINE_MS);
    deadline.unref?.();
    session.on('status', onStatus);
    session.once('exit', () => {
      sent = true;
      clearTimeout(deadline);
      session.off('status', onStatus);
    });
  }

  get(id: string): PtySession | undefined {
    return this.map.get(id);
  }

  /**
   * The history database this manager writes to.
   *
   * Exposed so routes (push subscriptions) can share the manager's connection
   * instead of opening a second one — in tests that connection is `:memory:`,
   * and a second handle would see an entirely different, empty database.
   */
  get database(): Db {
    return this.db;
  }

  /** Wire info for every live session, newest first. */
  list(): Session[] {
    return [...this.map.values()]
      .map((s) => s.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Applies user edits (rename, pin). Returns the updated wire info, or
   * `undefined` for an unknown id. Whitespace-only titles are rejected by the
   * route; here a title is trimmed and stored as given.
   */
  update(id: string, patch: SessionMetaPatch): Session | undefined {
    const session = this.map.get(id);
    if (!session) return undefined;
    const clean: SessionMetaPatch = {};
    if (patch.title !== undefined) clean.title = patch.title.trim();
    if (patch.pinned !== undefined) clean.pinned = patch.pinned;
    if (patch.muted !== undefined) clean.muted = patch.muted;

    this.db.updateSessionMeta(id, clean);
    if (clean.title !== undefined) session.info.title = clean.title;
    if (clean.pinned !== undefined) session.info.pinned = clean.pinned;
    if (clean.muted !== undefined) session.info.muted = clean.muted;
    emitServerEvent({ t: 'session:updated', session: session.info });
    return session.info;
  }

  kill(id: string): void {
    this.map.get(id)?.kill();
  }

  /**
   * Re-spawns a stopped session in place, keeping its id and its history.
   *
   * `force` kills a still-running session first; without it a live session is
   * rejected, so a mis-click cannot destroy work in progress.
   *
   * Async because killing is: SIGTERM is a request, not an event. Respawning
   * before the old process is genuinely gone would leave two PTYs on one
   * session, with the orphan still writing into the ring buffer.
   */
  async restart(id: string, options: { force?: boolean } = {}): Promise<Session> {
    const session = this.map.get(id);
    if (!session) throw new Error(`Unknown session "${id}"`);

    if (!isTerminalStatus(session.info.status)) {
      if (!options.force) {
        throw new Error(
          `Session "${id}" is still running. Kill it first, or restart with force.`,
        );
      }
      session.kill();
      await session.waitForExit();
    }

    session.restart();
    // The row keeps its original created_at, so the event log reads as one
    // continuous history across restarts rather than losing the earlier run.
    this.db.reopenSession(id);
    this.db.insertEvent(id, 'starting');
    emitServerEvent({ t: 'session:updated', session: session.info });
    return session.info;
  }

  /** Kills the session and forgets it entirely. */
  remove(id: string): void {
    const session = this.map.get(id);
    if (!session) return;
    this.map.delete(id);
    const gitTimer = this.gitTimers.get(id);
    if (gitTimer) clearTimeout(gitTimer);
    this.gitTimers.delete(id);
    session.kill();
    session.dispose();
    this.clearNotifyState(id);
    emitServerEvent({ t: 'session:removed', id });
  }

  /** Forgets every stopped session, leaving running ones alone. */
  removeFinished(): number {
    const finished = [...this.map.values()].filter((s) => isTerminalStatus(s.info.status));
    for (const session of finished) this.remove(session.id);
    return finished.length;
  }

  killAll(): void {
    for (const id of [...this.map.keys()]) this.remove(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.pruneTimer);
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
    // A turn just ended: the moment files are most likely to have changed.
    if (snapshot.status !== 'busy') this.refreshGit(session);
  }

  private readonly gitTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Re-reads the git summary shortly after a change, coalescing bursts. Never
   * throws; a folder that is not a repository simply has no summary.
   */
  refreshGit(session: PtySession, delayMs = GIT_REFRESH_DEBOUNCE_MS): void {
    const pending = this.gitTimers.get(session.id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.gitTimers.delete(session.id);
      void readGitStatus(session.info.cwd).then((status) => {
        if (this.map.get(session.id) !== session) return;
        const next = status
          ? { branch: status.branch, dirty: status.files.length, ahead: status.ahead, behind: status.behind }
          : undefined;
        if (JSON.stringify(next) === JSON.stringify(session.info.git)) return;
        session.info.git = next;
        emitServerEvent({ t: 'session:updated', session: session.info });
      });
    }, delayMs);
    timer.unref?.();
    this.gitTimers.set(session.id, timer);
  }

  getGeneralSettings(): GeneralSettings {
    const stored = this.db.getSetting<Partial<GeneralSettings>>(GENERAL_SETTINGS_KEY);
    return { pruneAfterHours: stored?.pruneAfterHours ?? null };
  }

  setGeneralSettings(settings: GeneralSettings): GeneralSettings {
    this.db.setSetting(GENERAL_SETTINGS_KEY, settings);
    this.pruneStale();
    return this.getGeneralSettings();
  }

  /**
   * Forgets sessions that stopped longer ago than the prune setting. Running
   * sessions are never touched, however old. Returns how many were removed.
   */
  pruneStale(now = this.now()): number {
    const { pruneAfterHours } = this.getGeneralSettings();
    if (pruneAfterHours === null) return 0;
    const cutoff = now - pruneAfterHours * HOUR_MS;
    const stale = [...this.map.values()].filter(
      (s) => isTerminalStatus(s.info.status) && s.info.statusChangedAt < cutoff,
    );
    for (const session of stale) this.remove(session.id);
    return stale.length;
  }

  /** Rules as stored, falling back to AGENTMASTER_PUSH_KINDS for a fresh install. */
  getNotifyPrefs(): NotifyPrefs {
    const stored = this.db.getSetting<Partial<NotifyPrefs>>(NOTIFY_PREFS_KEY);
    return {
      pushKinds: stored?.pushKinds ?? [...this.pushKinds],
      quietHours: stored?.quietHours ?? null,
      mutedHarnesses: stored?.mutedHarnesses ?? [],
    };
  }

  setNotifyPrefs(prefs: NotifyPrefs): NotifyPrefs {
    this.db.setSetting(NOTIFY_PREFS_KEY, prefs);
    return this.getNotifyPrefs();
  }

  private maybeNotify(session: PtySession, snapshot: StatusSnapshot): void {
    const decision = describeNotification(session, snapshot);
    if (!decision) return;

    const prefs = this.getNotifyPrefs();
    const ctx = {
      kind: decision.kind,
      harnessId: session.info.harnessId,
      sessionMuted: session.info.muted === true,
    };
    if (isMuted(prefs, ctx)) return;

    const key = `${session.id}:${decision.kind}`;
    const last = this.lastNotified.get(key);
    const at = this.now();
    if (last !== undefined && at - last < this.notifyCooldownMs) return;
    this.lastNotified.set(key, at);

    emitServerEvent({ t: 'notify', id: session.id, ...decision });

    // Same decision, same cooldown, one extra transport. Deriving the push from
    // a second policy would let desktop and phone disagree about what is worth
    // interrupting for; the only difference allowed is which kinds reach the
    // phone at all.
    if (shouldPush(prefs, ctx, new Date(at))) {
      const actions = snapshot.actions?.slice(0, MAX_NOTIFICATION_ACTIONS);
      const payload: PushPayload = { id: session.id, ...decision };
      if (actions && actions.length > 0) payload.actions = actions;
      void this.push(this.db, payload).catch((error: unknown) => {
        process.stderr.write(
          `[push] send rejected: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
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

/** The last non-empty screen lines, clipped: what the harness is asking. */
function previewSnippet(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const lines = preview
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const tail = lines.slice(-NOTIFICATION_PREVIEW_LINES).join('\n');
  if (tail === '') return undefined;
  return tail.length > NOTIFICATION_PREVIEW_CHARS ? `${tail.slice(0, NOTIFICATION_PREVIEW_CHARS - 1)}…` : tail;
}

function describeNotification(
  session: PtySession,
  snapshot: StatusSnapshot,
): NotifyDecision | undefined {
  const decision = baseNotification(session, snapshot);
  if (!decision || decision.kind !== 'waiting') return decision;
  const snippet = previewSnippet(snapshot.preview);
  return snippet ? { ...decision, body: `${decision.body}\n${snippet}` } : decision;
}

function baseNotification(
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
