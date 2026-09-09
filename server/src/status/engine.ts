import { EventEmitter } from 'node:events';

import type { Harness } from '../config/harnesses.js';
import { ScreenModel } from './screen-model.js';
import type { QuickAction, SessionStatus, WaitKind } from './types.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_TAIL_LINES = 30;

export interface StatusSnapshot {
  status: SessionStatus;
  waitKind?: WaitKind;
  actions?: QuickAction[];
  /** Only meaningful on `idle`: the session was busy for a long stretch first. */
  finished?: boolean;
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
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Infers a session's status from its PTY output.
 *
 * ```
 * starting --(first output)--> busy
 * busy --(idleMs of silence)--> waiting_input (a rule matches) | idle
 * waiting_input|idle --(any output)--> busy
 * any --(exit)--> exited (0/null) | error
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

  private timer: TimerHandle | undefined;
  private busySince: number | undefined;
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

    if (this.snapshot.status !== 'busy') this.busySince = this.now();
    this.transition({ status: 'busy' });
    this.armIdleTimer();
  }

  onExit(exitCode: number | null): void {
    this.clearIdleTimer();
    const status: SessionStatus = exitCode === null || exitCode === 0 ? 'exited' : 'error';
    const next: Omit<StatusSnapshot, 'at'> = { status };
    if (exitCode !== null) next.exitCode = exitCode;
    this.transition(next);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.screen.dispose();
  }

  private isTerminal(): boolean {
    return this.snapshot.status === 'exited' || this.snapshot.status === 'error';
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

  /** Synchronous by design — the screen is already current when this runs. */
  private onIdleTimeout(): void {
    this.timer = undefined;
    if (this.disposed || this.isTerminal()) return;

    const tail = this.screen.tail(this.tailLines);

    // Quiet but still working (e.g. Claude's "esc to interrupt" footer).
    if (this.harness.busyMarker?.test(tail)) {
      this.armIdleTimer();
      return;
    }

    for (const rule of this.harness.waitingInput) {
      if (!rule.re.test(tail)) continue;
      const next: Omit<StatusSnapshot, 'at'> = { status: 'waiting_input', waitKind: rule.kind };
      if (rule.actions) next.actions = rule.actions;
      this.transition(next);
      return;
    }

    const finished =
      this.busySince !== undefined &&
      this.now() - this.busySince > this.harness.finishedAfterBusyMs;
    this.transition({ status: 'idle', finished });
  }

  private transition(next: Omit<StatusSnapshot, 'at'>): void {
    const prev = this.snapshot;
    if (
      prev.status === next.status &&
      prev.waitKind === next.waitKind &&
      Boolean(prev.finished) === Boolean(next.finished) &&
      prev.exitCode === next.exitCode
    ) {
      return;
    }
    this.snapshot = { ...next, at: this.now() };
    this.emit('status', this.snapshot);
  }
}
