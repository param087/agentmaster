import { EventEmitter } from 'node:events';

import type { Harness } from '../config/harnesses.js';
import { ScreenModel } from './screen-model.js';
import type { QuickAction, SessionStatus, WaitKind } from './types.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/**
 * Minimum output span before a submitted turn counts as finished. Filters out
 * the keystroke echo that precedes the harness actually starting work.
 */
const MIN_TURN_OUTPUT_MS = 500;

/**
 * Hysteresis before *leaving* `waiting_input`.
 *
 * opencode repaints its selection widget while it is up, which read as
 * `waiting_input → busy → waiting_input` five times in thirty seconds: the
 * sidebar dot flickers and the attention queue churns. Entering
 * `waiting_input` stays immediate — latency there is the whole product.
 */
const LEAVE_WAITING_DELAY_MS = 1000;

const DEFAULT_TAIL_LINES = 30;

export interface StatusSnapshot {
  status: SessionStatus;
  waitKind?: WaitKind;
  actions?: QuickAction[];
  /** Source text of the waiting rule that fired. Only set on `waiting_input`. */
  matchedRule?: string;
  exitCode?: number;
  /** Timestamp of the transition. */
  at: number;
}

export interface StatusEngineOptions {
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  screen?: ScreenModel;
  cols?: number;
  rows?: number;
  tailLines?: number;
  /** Hysteresis before leaving `waiting_input`. Injectable for tests. */
  leaveWaitingDelayMs?: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Whether a snapshot represents an *unread* outstanding turn, i.e. one that
 * looking at the session clears.
 *
 * Deliberately excludes a rule-matched `waiting_input`: the harness is blocked
 * on a menu that is still on screen, and viewing it does not answer it.
 */
export function isAcknowledgeable(snapshot: StatusSnapshot): boolean {
  if (snapshot.status === 'done') return true;
  return snapshot.status === 'waiting_input' && snapshot.waitKind === 'turn';
}

/**
 * Infers a session's status from its PTY output.
 *
 * ```
 * starting --(first output)--> busy
 * busy --(idleMs of silence)--> waiting_input (a rule matches -> modally blocked)
 *                             | waiting_input/turn (you submitted, it answered)
 *                             | done (ran autonomously > finishedAfterBusyMs)
 *                             | idle
 * waiting_input --(output, after LEAVE_WAITING_DELAY_MS)--> busy
 * idle|done --(any output)--> busy
 * done|waiting_input/turn --(acknowledge)--> idle
 * any --(exit)--> killed (user) | error (non-zero) | exited
 * ```
 *
 * Detection runs against the *rendered* screen (see {@link ScreenModel}), never
 * the raw byte stream, so overwritten spinner frames do not linger.
 *
 * Emits `'status'` with a {@link StatusSnapshot}, and only when the snapshot
 * actually changes — a burst of output produces exactly one `busy` event.
 */
export class StatusEngine extends EventEmitter {
  private readonly harness: Harness;
  private readonly screen: ScreenModel;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly unschedule: typeof clearTimeout;
  private readonly tailLines: number;
  private readonly leaveWaitingDelayMs: number;

  private timer: TimerHandle | undefined;
  /** Deferred `waiting_input → busy`, see {@link LEAVE_WAITING_DELAY_MS}. */
  private leaveWaitingTimer: TimerHandle | undefined;
  private busySince: number | undefined;
  private lastDataAt: number | undefined;
  /** Set when the user submits a line; cleared once the turn settles. */
  private submitted = false;
  private snapshot: StatusSnapshot;
  private disposed = false;

  constructor(harness: Harness, opts: StatusEngineOptions = {}) {
    super();
    this.harness = harness;
    this.screen = opts.screen ?? new ScreenModel(opts.cols ?? DEFAULT_COLS, opts.rows ?? DEFAULT_ROWS);
    this.now = opts.now ?? Date.now;
    this.schedule = opts.setTimeout ?? setTimeout;
    this.unschedule = opts.clearTimeout ?? clearTimeout;
    this.tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;
    this.leaveWaitingDelayMs = opts.leaveWaitingDelayMs ?? LEAVE_WAITING_DELAY_MS;
    this.snapshot = { status: 'starting', at: this.now() };
  }

  /** The last emitted snapshot. */
  get current(): StatusSnapshot {
    return this.snapshot;
  }

  /**
   * Feeds a chunk of PTY output in. The screen write is awaited first so the
   * idle timer, when it later fires, reads an up-to-date screen synchronously.
   */
  async onData(chunk: string | Uint8Array): Promise<void> {
    if (this.disposed) return;
    await this.screen.write(chunk);
    // Re-check: the process may have exited (or the engine been disposed) while
    // the write was in flight. Late-flushed bytes must not resurrect a session.
    if (this.disposed || this.isTerminal()) return;

    this.lastDataAt = this.now();

    // Leaving `waiting_input` is deferred: a modal harness repainting its own
    // menu is not work. Entering it is not — that stays immediate.
    if (this.snapshot.status === 'waiting_input') {
      if (this.leaveWaitingTimer === undefined) {
        this.busySince = this.now();
        this.leaveWaitingTimer = this.schedule(
          () => this.onLeaveWaitingTimeout(),
          this.leaveWaitingDelayMs,
        );
      }
      this.armIdleTimer();
      return;
    }

    if (this.snapshot.status !== 'busy') this.busySince = this.now();
    this.transition({ status: 'busy' });
    this.armIdleTimer();
  }

  /**
   * Records user input so a completed turn can be told apart from idleness.
   *
   * Only a submit (CR/LF) counts. Ordinary keystrokes echo back as output, so
   * treating every byte as a submit would turn a single typed character into a
   * green "done" two and a half seconds later.
   */
  onInput(data: string | Uint8Array): void {
    if (this.disposed || this.isTerminal()) return;
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    if (text.includes('\r') || text.includes('\n')) this.submitted = true;
  }

  /**
   * Marks an outstanding turn as seen, dropping it back to `idle`.
   *
   * Acknowledgeable states are exactly the two that mean "you have not looked
   * yet": `done`, and `waiting_input` with `waitKind: 'turn'`.
   *
   * `waiting_input` with `permission` / `menu` / `question` is deliberately NOT
   * acknowledgeable: the harness is modally blocked and the menu is still on
   * screen, so clearing it would hide a genuinely stuck session.
   *
   * A no-op (and silent) everywhere else, so callers can fire it
   * unconditionally when a viewer focuses a session.
   */
  acknowledge(): void {
    if (this.disposed) return;
    if (!isAcknowledgeable(this.snapshot)) return;
    // The turn has been seen, so it stops counting as outstanding. Without this
    // any later stray output would turn the session amber again.
    this.submitted = false;
    this.transition({ status: 'idle' });
  }

  /**
   * Records process exit.
   *
   * `opts.killed` carries *intent* and is never inferred from `exitCode`: a
   * SIGTERM'd process very often reports code 0, so reading the code would
   * silently relabel every user-initiated kill as a clean exit.
   */
  onExit(exitCode: number | null, opts?: { killed?: boolean }): void {
    this.clearIdleTimer();
    this.clearLeaveWaitingTimer();
    let status: SessionStatus;
    if (opts?.killed) status = 'killed';
    else if (exitCode !== null && exitCode !== 0) status = 'error';
    else status = 'exited';
    const next: Omit<StatusSnapshot, 'at'> = { status };
    if (exitCode !== null) next.exitCode = exitCode;
    this.transition(next);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.clearLeaveWaitingTimer();
    this.screen.dispose();
  }

  private isTerminal(): boolean {
    const s = this.snapshot.status;
    return s === 'exited' || s === 'error' || s === 'killed';
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.timer = this.schedule(() => this.onIdleTimeout(), this.harness.idleMs);
  }

  private clearIdleTimer(): void {
    if (this.timer === undefined) return;
    this.unschedule(this.timer);
    this.timer = undefined;
  }

  private clearLeaveWaitingTimer(): void {
    if (this.leaveWaitingTimer === undefined) return;
    this.unschedule(this.leaveWaitingTimer);
    this.leaveWaitingTimer = undefined;
  }

  /** First rule whose regex matches the rendered tail, in declaration order. */
  private matchWaitingRule(tail: string): Omit<StatusSnapshot, 'at'> | undefined {
    for (const rule of this.harness.waitingInput) {
      if (!rule.re.test(tail)) continue;
      const next: Omit<StatusSnapshot, 'at'> = {
        status: 'waiting_input',
        waitKind: rule.kind,
        matchedRule: rule.re.source,
      };
      if (rule.actions) next.actions = rule.actions;
      return next;
    }
    return undefined;
  }

  /**
   * The deferred `waiting_input → busy`. If the same modal state is still on
   * screen the output was a repaint, so the transition is dropped entirely.
   */
  private onLeaveWaitingTimeout(): void {
    this.leaveWaitingTimer = undefined;
    if (this.disposed || this.isTerminal()) return;
    if (this.snapshot.status !== 'waiting_input') return;

    const match = this.matchWaitingRule(this.screen.tail(this.tailLines));
    if (match && match.waitKind === this.snapshot.waitKind) return;

    this.transition({ status: 'busy' });
  }

  /** Synchronous by design — the screen is already current when this runs. */
  private onIdleTimeout(): void {
    this.timer = undefined;
    if (this.disposed || this.isTerminal()) return;

    const tail = this.screen.tail(this.tailLines);

    // Quiet but still working (e.g. Claude's "esc to interrupt" footer).
    // The deferred leave-waiting timer is deliberately left running: the marker
    // says the harness really is working, so that transition should land.
    if (this.harness.busyMarker?.test(tail)) {
      this.armIdleTimer();
      return;
    }

    // This evaluation supersedes any deferred `busy`: whatever it decides is
    // the settled state, and cancelling here is what swallows a menu repaint.
    this.clearLeaveWaitingTimer();

    const match = this.matchWaitingRule(tail);
    if (match) {
      this.transition(match);
      return;
    }

    // No rule matched, so nothing modal is on screen. What is left is the
    // ordinary shape of an agent CLI: it ended its turn. That is amber — "your
    // move" — for *every* harness, including ones with no rules at all, which
    // is exactly why this path is regex-free.
    //
    // Duration alone is a poor signal: a three-second answer is just as
    // finished as a three-minute one. What distinguishes "it did something for
    // you" from "it is just sitting there" is whether you submitted anything.
    //
    //   you pressed Enter and it then produced a real stretch of output
    //       -> waiting_input / turn   (amber, your move)
    //   it worked autonomously for longer than finishedAfterBusyMs
    //       -> done                   (green, e.g. `claude -p "do X"` from args)
    //   otherwise                     -> idle
    //
    // MIN_TURN_OUTPUT_MS guards the gap between your keystrokes echoing back
    // and the harness actually starting work: opencode echoes in ~50ms and can
    // then think silently for well over idleMs, which would otherwise settle as
    // a premature turn-end — and notify you mid-thought.
    //
    // `submitted` is deliberately NOT cleared here. The turn stays outstanding
    // until it is acknowledged, so the echo gap resolves to idle and the real
    // completion that follows still lands on amber.
    //
    // `matchedRule` stays undefined, which is how the UI tells a generic
    // turn-end apart from a rule match. Likewise there are no `actions`: with
    // no rule there is nothing harness-specific to offer.
    const span =
      this.busySince !== undefined && this.lastDataAt !== undefined
        ? this.lastDataAt - this.busySince
        : 0;
    if (this.submitted && span >= MIN_TURN_OUTPUT_MS) {
      this.transition({ status: 'waiting_input', waitKind: 'turn' });
      return;
    }
    this.transition({ status: span > this.harness.finishedAfterBusyMs ? 'done' : 'idle' });
  }

  private transition(next: Omit<StatusSnapshot, 'at'>): void {
    const prev = this.snapshot;
    if (
      prev.status === next.status &&
      prev.waitKind === next.waitKind &&
      prev.matchedRule === next.matchedRule &&
      prev.exitCode === next.exitCode
    ) {
      return;
    }
    this.snapshot = { ...next, at: this.now() };
    this.emit('status', this.snapshot);
  }
}
