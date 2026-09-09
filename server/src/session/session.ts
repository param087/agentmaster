import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import * as pty from 'node-pty';

import type { Harness } from '../config/harnesses.js';
import { StatusEngine, type StatusSnapshot } from '../status/engine.js';
import type { Session } from '../status/types.js';
import { RingBuffer } from './ring-buffer.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const SIGKILL_GRACE_MS = 3000;

/**
 * Anything that can receive raw terminal bytes. Structural on purpose: a `ws`
 * WebSocket satisfies it, and so does a plain array-collecting object in tests.
 */
export interface SessionViewer {
  send(data: Buffer): void;
}

export interface SessionOptions {
  id: string;
  harness: Harness;
  cwd: string;
  title: string;
  cols?: number;
  rows?: number;
  scrollbackBytes?: number;
}

/**
 * Builds the child environment.
 *
 * `NODE_OPTIONS` is deliberately removed: it leaks the parent's loader and
 * debugger flags (`--import tsx`, `--inspect`) into the harness, which breaks
 * CLIs that are themselves Node programs.
 */
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    COLORTERM: 'truecolor',
  };
  delete env['NODE_OPTIONS'];
  return env;
}

function assertDirectory(cwd: string): void {
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`);
  }
}

/**
 * One PTY-backed harness process.
 *
 * Every chunk of output fans out three ways and is never parsed or rewritten:
 *
 * 1. broadcast verbatim to attached viewers (full keystroke/render fidelity),
 * 2. appended to a ring buffer (replayed when a browser attaches),
 * 3. fed to the {@link StatusEngine} (drives status, attention, notifications).
 *
 * Because nothing here is harness-specific, one implementation covers every
 * CLI; all per-harness knowledge lives in `harnesses.yaml`.
 *
 * Emits `'status'` ({@link StatusSnapshot}) and `'exit'` (`number | null`).
 */
export class PtySession extends EventEmitter {
  readonly id: string;
  readonly info: Session;

  private readonly harness: Harness;
  private readonly pty: pty.IPty;
  private readonly ringBuffer: RingBuffer;
  private readonly engine: StatusEngine;
  private readonly viewers = new Set<SessionViewer>();

  private killTimer: NodeJS.Timeout | undefined;
  private exited = false;
  private disposed = false;
  /** Intent, not inference: SIGTERM'd children routinely report exit code 0. */
  private killedByUser = false;
  /** Re-entrancy guard for acknowledging a `done` that arrived mid-emit. */
  private acknowledging = false;

  constructor(opts: SessionOptions) {
    super();
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;

    assertDirectory(opts.cwd);

    this.id = opts.id;
    this.harness = opts.harness;
    this.ringBuffer = new RingBuffer(opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES);
    this.engine = new StatusEngine(opts.harness, { cols, rows });

    // A bare command name is handed to the PTY untouched so the child's PATH
    // resolves it; an explicit path is used as-is.
    const command = opts.harness.command;
    try {
      this.pty = pty.spawn(command, opts.harness.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: opts.cwd,
        env: childEnv(),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Failed to spawn harness "${opts.harness.id}" (${command}) in ${opts.cwd}: ${reason}`,
        { cause },
      );
    }

    const now = Date.now();
    this.info = {
      id: opts.id,
      harnessId: opts.harness.id,
      harnessName: opts.harness.name,
      cwd: opts.cwd,
      title: opts.title,
      status: 'starting',
      pid: this.pty.pid,
      createdAt: now,
      statusChangedAt: now,
    };

    this.engine.on('status', (snapshot: StatusSnapshot) => this.onStatus(snapshot));
    this.pty.onData((chunk) => this.onData(chunk));
    this.pty.onExit(({ exitCode }) => this.onExit(exitCode));
  }

  /** Bytes waiting to be replayed to a newly attached browser. */
  replay(): Buffer {
    return this.ringBuffer.read();
  }

  write(data: string | Buffer): void {
    if (this.exited || this.disposed) return;
    this.pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  /**
   * Adds a viewer. Replay is the caller's job — attach order is theirs to pick.
   *
   * Opening a session counts as looking at it, so any pending `done` is
   * acknowledged and the session drops back to `idle`.
   */
  attach(viewer: SessionViewer): void {
    this.viewers.add(viewer);
    this.engine.acknowledge();
  }

  /** Number of attached viewers. Exposed so leaked detaches are directly testable. */
  get viewerCount(): number {
    return this.viewers.size;
  }

  detach(viewer: SessionViewer): void {
    this.viewers.delete(viewer);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.disposed) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // The child may have died between the check and the call; nothing to do.
    }
  }

  /** SIGTERM, escalating to SIGKILL if the process is still alive 3s later. */
  kill(): void {
    if (this.exited || this.disposed) return;
    this.killedByUser = true;
    try {
      this.pty.kill('SIGTERM');
    } catch {
      return;
    }
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.exited) return;
      this.killedByUser = true;
      try {
        this.pty.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, SIGKILL_GRACE_MS);
    // A live 3s timer would keep the process (and Vitest) alive on its own.
    this.killTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearKillTimer();
    this.viewers.clear();
    this.engine.dispose();
    if (!this.exited) {
      try {
        this.pty.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.removeAllListeners();
  }

  private clearKillTimer(): void {
    if (!this.killTimer) return;
    clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  private onData(chunk: string): void {
    // node-pty defaults to utf8 encoding, so chunks arrive as strings. Encode
    // once and share the same Buffer with all three consumers.
    const bytes = Buffer.from(chunk, 'utf8');
    this.broadcast(bytes);
    this.ringBuffer.push(bytes);
    // Never `ringBuffer.read()` here: it copies up to 2 MB per chunk.
    void this.engine.onData(bytes);
  }

  private broadcast(bytes: Buffer): void {
    for (const viewer of this.viewers) {
      try {
        viewer.send(bytes);
      } catch {
        // A dead socket must not stall the fan-out for everyone else.
        this.viewers.delete(viewer);
      }
    }
  }

  private onExit(exitCode: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clearKillTimer();
    this.info.exitCode = exitCode ?? undefined;
    this.engine.onExit(exitCode, { killed: this.killedByUser });
    this.emit('exit', exitCode);
  }

  private onStatus(snapshot: StatusSnapshot): void {
    // `done` means "finished, and you haven't looked yet". If someone is
    // already watching, they *have* looked: swallow the transition rather than
    // flashing green at a viewer who is staring straight at the output.
    //
    // `acknowledge()` re-enters this listener synchronously with the `idle`
    // snapshot; the guard makes that inner call the one that publishes, and the
    // outer `done` frame returns without emitting anything.
    if (snapshot.status === 'done' && this.viewers.size > 0 && !this.acknowledging) {
      this.acknowledging = true;
      try {
        this.engine.acknowledge();
      } finally {
        this.acknowledging = false;
      }
      return;
    }

    this.info.status = snapshot.status;
    this.info.waitKind = snapshot.waitKind;
    this.info.actions = snapshot.actions;
    this.info.matchedRule = snapshot.matchedRule;
    this.info.statusChangedAt = snapshot.at;
    if (snapshot.status === 'busy') {
      this.info.busySince ??= snapshot.at;
    } else if (snapshot.status !== 'waiting_input') {
      this.info.busySince = undefined;
    }
    if (snapshot.exitCode !== undefined) this.info.exitCode = snapshot.exitCode;
    this.emit('status', snapshot);
  }

  /** The harness this session was spawned from. */
  get harnessRef(): Harness {
    return this.harness;
  }
}
