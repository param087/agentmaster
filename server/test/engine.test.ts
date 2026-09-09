import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Harness } from '../src/config/harnesses.js';
import { StatusEngine, type StatusSnapshot } from '../src/status/engine.js';

/**
 * NOTE ON TIMERS
 *
 * `vi.useFakeTimers()` cannot be used here: `@xterm/headless` schedules its
 * parse loop on the global `setTimeout`, so faking it globally makes
 * `ScreenModel.write()` never resolve (verified — the await deadlocks).
 *
 * The engine therefore takes `now` / `setTimeout` / `clearTimeout` as options,
 * and these tests drive a deterministic in-test clock. Real `setTimeout` stays
 * untouched, so `await onData(...)` resolves normally.
 */
class FakeClock {
  private t = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.t;

  readonly setTimeout = ((fn: () => void, ms = 0): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clearTimeout = ((id: number | undefined): void => {
    if (id !== undefined) this.timers.delete(id);
  }) as unknown as typeof clearTimeout;

  /** Advances the clock, firing every timer due along the way, in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.t = timer.at;
      timer.fn();
    }
    this.t = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

const harness: Harness = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  args: [],
  waitingInput: [
    {
      re: /Do you want to proceed/,
      kind: 'permission',
      actions: [{ label: 'Yes', keys: '1\r' }],
    },
  ],
  idleMs: 2500,
  finishedAfterBusyMs: 20000,
};

let engine: StatusEngine | undefined;

function makeEngine(h: Harness = harness): {
  engine: StatusEngine;
  clock: FakeClock;
  seen: StatusSnapshot[];
} {
  const clock = new FakeClock();
  const e = new StatusEngine(h, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  engine = e;
  const seen: StatusSnapshot[] = [];
  e.on('status', (s: StatusSnapshot) => seen.push(s));
  return { engine: e, clock, seen };
}

afterEach(() => {
  engine?.dispose();
  engine = undefined;
});

describe('StatusEngine', () => {
  it('starts in "starting" and emits nothing', () => {
    const { engine: e, seen } = makeEngine();
    expect(e.current.status).toBe('starting');
    expect(e.current.at).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('emits exactly one busy on first data', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('hello');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('busy');
    expect(e.current.status).toBe('busy');
  });

  it('emits busy only once across three consecutive writes', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('a');
    await e.onData('b');
    await e.onData('c');
    expect(seen.filter((s) => s.status === 'busy')).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('transitions to waiting_input when a rule matches at idle', async () => {
    const { engine: e, clock, seen } = makeEngine();
    await e.onData('Do you want to proceed?\r\n❯ 1. Yes\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
    expect(e.current.actions?.[0]?.label).toBe('Yes');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input']);
  });

  it('transitions to idle (not finished) when no rule matches', async () => {
    const { engine: e, clock } = makeEngine();
    await e.onData('just some log output\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
    expect(e.current.finished).toBeFalsy();
    expect(e.current.waitKind).toBeUndefined();
  });

  it('marks idle as finished after a long busy stretch', async () => {
    const { engine: e, clock } = makeEngine();
    for (let i = 0; i < 11; i++) {
      await e.onData(`working ${i}\r\n`);
      clock.advance(2000); // below idleMs, so the timer never fires
    }
    expect(e.current.status).toBe('busy');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
    expect(e.current.finished).toBe(true);
  });

  it('honours waiting rule order — first match wins', async () => {
    const { engine: e, clock } = makeEngine({
      ...harness,
      waitingInput: [
        { re: /proceed/, kind: 'permission', actions: [{ label: 'First', keys: '1\r' }] },
        { re: /proceed/, kind: 'question', actions: [{ label: 'Second', keys: '2\r' }] },
      ],
    });
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
    expect(e.current.actions?.[0]?.label).toBe('First');
  });

  it('stays busy while the busyMarker is on screen, and transitions once it clears', async () => {
    const { engine: e, clock, seen } = makeEngine({
      ...harness,
      busyMarker: /esc to interrupt/,
    });

    await e.onData('\r\x1b[K ⠋ Thinking… (3s · esc to interrupt)');
    clock.advance(2500);
    expect(e.current.status).toBe('busy');
    expect(seen.map((s) => s.status)).toEqual(['busy']);

    // marker still there: the re-armed timer must also refuse to transition
    clock.advance(2500);
    expect(e.current.status).toBe('busy');
    expect(seen).toHaveLength(1);

    // spinner line erased and replaced by a prompt -> transition happens
    await e.onData('\r\x1b[KDo you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
  });

  it('returns to busy when output arrives after waiting_input', async () => {
    const { engine: e, clock, seen } = makeEngine();
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');

    await e.onData('\x1b[2J\x1b[Hcontinuing\r\n');
    expect(e.current.status).toBe('busy');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input', 'busy']);
  });

  it('maps exit codes to exited / error', async () => {
    const zero = makeEngine();
    await zero.engine.onData('x');
    zero.engine.onExit(0);
    expect(zero.engine.current.status).toBe('exited');
    expect(zero.engine.current.exitCode).toBe(0);
    zero.engine.dispose();

    const one = makeEngine();
    await one.engine.onData('x');
    one.engine.onExit(1);
    expect(one.engine.current.status).toBe('error');
    expect(one.engine.current.exitCode).toBe(1);
    one.engine.dispose();

    const nul = makeEngine();
    await nul.engine.onData('x');
    nul.engine.onExit(null);
    expect(nul.engine.current.status).toBe('exited');
  });

  it('ignores data arriving after exit', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('x');
    e.onExit(0);
    await e.onData('late flushed bytes');
    expect(e.current.status).toBe('exited');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'exited']);
  });

  it('cancels the idle timer on exit', async () => {
    const { engine: e, clock, seen } = makeEngine();
    await e.onData('x');
    e.onExit(0);
    expect(clock.pending).toBe(0);
    clock.advance(60000);
    expect(seen).toHaveLength(2);
    expect(e.current.status).toBe('exited');
  });

  it('falls back to idle for a harness with no waiting rules', async () => {
    const { engine: e, clock, seen } = makeEngine({ ...harness, waitingInput: [] });
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'idle']);
  });

  it('detects a permission prompt through a realistic spinner sequence', async () => {
    const { engine: e, clock } = makeEngine({ ...harness, busyMarker: /esc to interrupt/ });

    for (const secs of [3, 4, 5]) {
      await e.onData(`\r\x1b[K ⠋ Thinking… (${secs}s · esc to interrupt)`);
    }
    await e.onData('\r\x1b[KDo you want to proceed?\r\n❯ 1. Yes\r\n');

    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
    expect(e.current.actions?.[0]?.keys).toBe('1\r');
  });

  it('uses real global timers by default', async () => {
    const e = new StatusEngine({ ...harness, idleMs: 1 });
    engine = e;
    const seen: StatusSnapshot[] = [];
    e.on('status', (s: StatusSnapshot) => seen.push(s));
    await e.onData('plain output');
    await vi.waitFor(() => expect(e.current.status).toBe('idle'));
    expect(seen.map((s) => s.status)).toEqual(['busy', 'idle']);
  });
});
