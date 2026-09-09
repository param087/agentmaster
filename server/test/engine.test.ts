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

  it('transitions to idle when no rule matches and the busy stretch was short', async () => {
    const { engine: e, clock } = makeEngine();
    await e.onData('just some log output\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
    expect(e.current.waitKind).toBeUndefined();
  });

  it('transitions to done after a busy stretch longer than finishedAfterBusyMs', async () => {
    const { engine: e, clock, seen } = makeEngine();
    for (let i = 0; i < 13; i++) {
      await e.onData(`working ${i}\r\n`);
      clock.advance(2000); // below idleMs, so the timer never fires
    }
    expect(e.current.status).toBe('busy');
    clock.advance(2500);
    expect(e.current.status).toBe('done');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'done']);
  });

  // UPDATED SEMANTICS: a submitted turn going quiet is amber ("your move"),
  // not green. Green is now reserved for the autonomous case below.
  it('treats a submitted turn as a turn-end even when it is over quickly', async () => {
    const { engine: e, clock } = makeEngine();
    e.onInput('explain pseudo-terminals\r');
    // Output must span at least MIN_TURN_OUTPUT_MS to count as a real turn.
    await e.onData('a pseudo-terminal is');
    clock.advance(800);
    await e.onData('... a kernel device pair.\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('turn');
  });

  it('leaves matchedRule and actions unset on a turn-end, so the UI can tell them apart', async () => {
    const { engine: e, clock } = makeEngine();
    e.onInput('go\r');
    await e.onData('thinking');
    clock.advance(800);
    await e.onData(' answer\r\n');
    clock.advance(2500);
    expect(e.current.waitKind).toBe('turn');
    expect(e.current.matchedRule).toBeUndefined();
    expect(e.current.actions).toBeUndefined();
  });

  it('prefers a matching rule over the generic turn-end', async () => {
    const { engine: e, clock } = makeEngine();
    e.onInput('edit the readme\r');
    await e.onData('reading file');
    clock.advance(800);
    await e.onData('\r\nDo you want to proceed?\r\n');
    clock.advance(2500);
    // Modal detection wins: the harness is blocked, not merely done talking.
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
    expect(e.current.matchedRule).toBe('Do you want to proceed');
  });

  it('ignores the keystroke echo that precedes real work', async () => {
    const { engine: e, clock } = makeEngine();
    e.onInput('explain pseudo-terminals\r');
    // The harness echoes instantly, then thinks silently for longer than
    // idleMs. That gap must settle as idle, not as a premature done.
    await e.onData('explain pseudo-terminals');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');

    // ...and the real answer that follows still lands on the turn-end.
    await e.onData('a pseudo-terminal is');
    clock.advance(800);
    await e.onData('... a kernel device pair.\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('turn');
  });

  it('does not go done for plain typing with no submit', async () => {
    const { engine: e, clock } = makeEngine();
    // Keystrokes echo back as output; without this guard a single typed
    // character would turn green 2.5s later.
    e.onInput('h');
    await e.onData('h');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
  });

  it('does not go done for unprompted startup output', async () => {
    const { engine: e, clock } = makeEngine();
    await e.onData('booting TUI...\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
  });

  it('clears the outstanding turn once acknowledged', async () => {
    const { engine: e, clock } = makeEngine();
    e.onInput('go\r');
    await e.onData('working');
    clock.advance(800);
    await e.onData(' done\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('turn');

    e.acknowledge();
    expect(e.current.status).toBe('idle');

    // Stray output after the turn was seen is just idle, not green again.
    await e.onData('a late stray byte');
    clock.advance(800);
    await e.onData(' more\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('idle');
  });

  it('acknowledge() on done emits idle', async () => {
    const { engine: e, clock, seen } = makeEngine();
    for (let i = 0; i < 13; i++) {
      await e.onData(`working ${i}\r\n`);
      clock.advance(2000);
    }
    clock.advance(2500);
    expect(e.current.status).toBe('done');

    e.acknowledge();
    expect(e.current.status).toBe('idle');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'done', 'idle']);
  });

  it('acknowledge() clears a generic turn-end back to idle', async () => {
    const { engine: e, clock, seen } = makeEngine();
    e.onInput('go\r');
    await e.onData('working');
    clock.advance(800);
    await e.onData(' done\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');

    e.acknowledge();
    expect(e.current.status).toBe('idle');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input', 'idle']);
  });

  it('acknowledge() must NOT clear a modally blocked waiting_input', async () => {
    // The menu is still on screen. Looking at a session does not answer its
    // permission prompt, and clearing it would hide a genuinely stuck session.
    const { engine: e, clock, seen } = makeEngine();
    e.onInput('edit the readme\r');
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(800);
    await e.onData('❯ 1. Yes\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');

    e.acknowledge();
    e.acknowledge();
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.waitKind).toBe('permission');
    expect(e.current.matchedRule).toBe('Do you want to proceed');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input']);
  });

  it('acknowledge() is a silent no-op when neither done nor a turn-end', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('x');
    expect(e.current.status).toBe('busy');

    e.acknowledge();
    e.acknowledge();
    expect(e.current.status).toBe('busy');
    expect(seen.map((s) => s.status)).toEqual(['busy']);
  });

  it('swallows a menu repaint: waiting_input never flaps to busy', async () => {
    const { engine: e, clock, seen } = makeEngine();
    await e.onData('Do you want to proceed?\r\n❯ 1. Yes\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');

    // opencode-style: repaint the same widget five times in half a minute.
    for (let i = 0; i < 5; i++) {
      await e.onData('\x1b[2J\x1b[HDo you want to proceed?\r\n❯ 1. Yes\r\n');
      clock.advance(6000);
      expect(e.current.status).toBe('waiting_input');
    }
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input']);
  });

  it('still transitions to busy after the delay when real work starts', async () => {
    const { engine: e, clock, seen } = makeEngine();
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');

    await e.onData('\x1b[2J\x1b[Hrunning the edit\r\n');
    // Immediately after: still amber. The whole point is not to flicker.
    expect(e.current.status).toBe('waiting_input');
    clock.advance(999);
    expect(e.current.status).toBe('waiting_input');
    clock.advance(1);
    expect(e.current.status).toBe('busy');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input', 'busy']);
  });

  it('honours an injected leave-waiting delay', async () => {
    const clock = new FakeClock();
    const e = new StatusEngine(harness, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      leaveWaitingDelayMs: 50,
    });
    engine = e;
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    await e.onData('\x1b[2J\x1b[Hoff we go\r\n');
    clock.advance(50);
    expect(e.current.status).toBe('busy');
  });

  it('records the matching rule source on a waiting transition', async () => {
    const { engine: e, clock } = makeEngine();
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.status).toBe('waiting_input');
    expect(e.current.matchedRule).toBe('Do you want to proceed');
  });

  it('clears matchedRule when leaving waiting_input', async () => {
    const { engine: e, clock } = makeEngine();
    await e.onData('Do you want to proceed?\r\n');
    clock.advance(2500);
    expect(e.current.matchedRule).toBe('Do you want to proceed');

    await e.onData('\x1b[2J\x1b[Hcarrying on\r\n');
    // Leaving waiting_input is deferred by LEAVE_WAITING_DELAY_MS.
    expect(e.current.status).toBe('waiting_input');
    clock.advance(1000);
    expect(e.current.status).toBe('busy');
    expect(e.current.matchedRule).toBeUndefined();

    clock.advance(2500);
    expect(e.current.status).toBe('idle');
    expect(e.current.matchedRule).toBeUndefined();
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
    clock.advance(1000);
    expect(e.current.status).toBe('busy');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'waiting_input', 'busy']);
  });

  it('reports killed when the exit was user-initiated, whatever the code', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('x');
    // Exit code 0 on a SIGTERM is the norm, so intent must come from the caller.
    e.onExit(0, { killed: true });
    expect(e.current.status).toBe('killed');
    expect(e.current.exitCode).toBe(0);
    expect(seen.map((s) => s.status)).toEqual(['busy', 'killed']);
  });

  it('treats killed as terminal, ignoring later data', async () => {
    const { engine: e, seen } = makeEngine();
    await e.onData('x');
    e.onExit(null, { killed: true });
    await e.onData('late flushed bytes');
    expect(e.current.status).toBe('killed');
    expect(seen.map((s) => s.status)).toEqual(['busy', 'killed']);
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

  it('does not infer killed from a non-zero code, nor error from killed', async () => {
    const { engine: e } = makeEngine();
    await e.onData('x');
    e.onExit(1, { killed: true });
    expect(e.current.status).toBe('killed');
    expect(e.current.exitCode).toBe(1);
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
