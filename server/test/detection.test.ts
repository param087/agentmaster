import { describe, expect, it } from 'vitest';

import { getHarness, loadHarnesses, type Harness } from '../src/config/harnesses.js';
import { StatusEngine, type StatusSnapshot } from '../src/status/engine.js';
import type { SessionStatus, WaitKind } from '../src/status/types.js';
import { loadFixture } from './fixture-io.js';

/**
 * NOTE ON TIMERS — see `engine.test.ts`. `vi.useFakeTimers()` deadlocks
 * `@xterm/headless` (its parse loop uses the global `setTimeout`, so
 * `ScreenModel.write()` never resolves). The engine's injectable clock is used
 * instead; real timers stay untouched.
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
}

function requireHarness(id: string): Harness {
  const harness = getHarness(id);
  if (!harness) throw new Error(`harnesses.yaml has no harness "${id}"`);
  return harness;
}

/**
 * Replays a recorded fixture through a real `ScreenModel` + `StatusEngine`,
 * then advances the injected clock past `idleMs` so the detection pass runs.
 *
 * `totalBusyMs` is the wall-clock duration the capture actually spanned, spread
 * evenly across its chunks. The `.cast` format stores bytes only, not timing, so
 * without it every replay looks instantaneous and no fixture could ever reach
 * `done` (which requires `finishedAfterBusyMs` of busy time). Spreading by total
 * duration rather than per chunk matters: a burst of 300 tiny paint chunks still
 * only took two seconds.
 */
async function replayFixture(
  name: string,
  harness: Harness,
  totalBusyMs = 0,
  opts: { submitted?: boolean } = {},
): Promise<StatusSnapshot> {
  const clock = new FakeClock();
  const engine = new StatusEngine(harness, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  try {
    // A turn-end is defined by *you having submitted something*, which the
    // recorded bytes cannot show: the `.cast` files hold output only. Fixtures
    // captured mid-conversation replay that submit explicitly.
    if (opts.submitted) engine.onInput('do the thing\r');
    const chunks = loadFixture(name);
    // Capped below idleMs, or the idle pass would fire mid-stream.
    const step = chunks.length > 1 ? Math.min(totalBusyMs / (chunks.length - 1), harness.idleMs - 1) : 0;
    for (const chunk of chunks) {
      await engine.onData(chunk);
      if (step > 0) clock.advance(step);
    }
    clock.advance(harness.idleMs + 1);
    return engine.current;
  } finally {
    engine.dispose();
  }
}

describe('detection against fixtures captured from real CLIs', () => {
  /**
   * These were captured with `server/scripts/capture.ts` against opencode
   * 1.18.30 and pi 0.85.1. Both auto-approve tool calls, so neither has a
   * permission prompt: their only modal blocked state is a selection widget.
   */
  it.each<[string, string, SessionStatus, WaitKind | undefined]>([
    ['opencode-menu', 'opencode', 'waiting_input', 'menu'],
    ['pi-menu', 'pi', 'waiting_input', 'menu'],
  ])('%s replayed against %s yields %s', async (fixture, harnessId, status, waitKind) => {
    const snapshot = await replayFixture(fixture, requireHarness(harnessId));
    expect(snapshot.status).toBe(status);
    expect(snapshot.waitKind).toBe(waitKind);
  });

  /**
   * Negative fixtures. A false-positive amber is worse than a miss: it trains
   * you to ignore the one colour that means "act now". Every rule above ships
   * with a screen it must NOT fire on.
   */
  it.each<[string, string]>([
    ['opencode-idle', 'opencode'],
    ['pi-idle', 'pi'],
    ['opencode-after-run', 'opencode'],
    ['pi-after-run', 'pi'],
    ['opencode-question', 'opencode'],
  ])('%s must not be reported as waiting', async (fixture, harnessId) => {
    // No submit, so no turn is outstanding either: an untouched session is
    // never amber. This is what stops a false amber on a bare prompt box.
    const snapshot = await replayFixture(fixture, requireHarness(harnessId));
    expect(snapshot.status).not.toBe('waiting_input');
    expect(snapshot.matchedRule).toBeUndefined();
  });

  /**
   * A submitted turn that produced output and went quiet is amber, not green.
   *
   * opencode's free-text question renders exactly like an empty prompt box, so
   * "it asked me something" and "it finished its turn" are the same screen. The
   * honest reading of both is the same too: it is your move. Calling that
   * `done` is what swallowed the notification this behaviour exists to fix.
   */
  it.each<[string, string]>([
    ['opencode-question', 'opencode'],
    ['opencode-after-run', 'opencode'],
    ['pi-after-run', 'pi'],
  ])('%s is a turn-end once you submitted something', async (fixture, harnessId) => {
    const harness = requireHarness(harnessId);
    const snapshot = await replayFixture(fixture, harness, 30_000, { submitted: true });
    expect(snapshot.status).toBe('waiting_input');
    expect(snapshot.waitKind).toBe('turn');
    // No rule fired: this path is regex-free, so it works for every harness.
    expect(snapshot.matchedRule).toBeUndefined();
    expect(snapshot.actions).toBeUndefined();
  });

  /**
   * Green survives, for the autonomous case only: a long busy stretch with no
   * submit, e.g. `claude -p "do X"` launched from args.
   */
  it.each<[string, string]>([
    ['opencode-after-run', 'opencode'],
    ['pi-after-run', 'pi'],
  ])('%s with no submit is done, not amber', async (fixture, harnessId) => {
    const snapshot = await replayFixture(fixture, requireHarness(harnessId), 30_000);
    expect(snapshot.status).toBe('done');
  });

  it('a short startup burst stays idle rather than going green', async () => {
    // opencode paints its TUI in about two seconds, well under the 4s
    // finished_after_busy_ms threshold, so a fresh session must not go green.
    const snapshot = await replayFixture('opencode-idle', requireHarness('opencode'), 2_000);
    expect(snapshot.status).toBe('idle');
  });

  it('reports which rule fired, so a wrong regex is visible', async () => {
    const snapshot = await replayFixture('opencode-menu', requireHarness('opencode'));
    expect(snapshot.matchedRule).toBe(requireHarness('opencode').waitingInput[0]?.re.source);
  });

  it('exposes byte-exact quick actions for the opencode selector', async () => {
    const snapshot = await replayFixture('opencode-menu', requireHarness('opencode'));
    expect(snapshot.actions).toEqual([
      { label: 'Submit', keys: '\r' },
      { label: 'Dismiss', keys: '\u001b' },
    ]);
  });
});

describe('detection against synthetic fixtures (unverified harnesses)', () => {
  it.each<[string, string, SessionStatus, WaitKind | undefined]>([
    ['claude-permission', 'claude-code', 'waiting_input', 'permission'],
    ['claude-busy', 'claude-code', 'busy', undefined],
    ['claude-idle', 'claude-code', 'idle', undefined],
    ['gemini-permission', 'gemini-cli', 'waiting_input', 'permission'],
  ])('%s replayed against %s yields %s', async (fixture, harnessId, status, waitKind) => {
    const snapshot = await replayFixture(fixture, requireHarness(harnessId));
    expect(snapshot.status).toBe(status);
    expect(snapshot.waitKind).toBe(waitKind);
  });

  it('falls back to idle for an unknown CLI with no waiting rules', async () => {
    const unknown: Harness = {
      id: 'mystery-cli',
      name: 'Mystery CLI',
      command: 'mystery',
      args: [],
      waitingInput: [],
      idleMs: 2500,
      finishedAfterBusyMs: 20000,
    };
    const snapshot = await replayFixture('unknown-idle', unknown);
    expect(snapshot.status).toBe('idle');
    expect(snapshot.waitKind).toBeUndefined();
    expect(snapshot.actions).toBeUndefined();
  });

  it('exposes the claude-code quick actions with byte-exact keys', async () => {
    const snapshot = await replayFixture('claude-permission', requireHarness('claude-code'));
    expect(snapshot.actions).toEqual([
      { label: 'Yes', keys: '1\r' },
      { label: 'Allow all', keys: '2\r' },
      { label: 'No', keys: '3\r' },
    ]);
  });
});

describe('the shipped harnesses.yaml (post-fixture-verification)', () => {
  it('still parses and contains all six harness ids', () => {
    const ids = loadHarnesses().map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining(['opencode', 'claude-code', 'gemini-cli', 'codex', 'qwen-code', 'pi']),
    );
    // No fixed count: the registry grows as harnesses are added. What matters
    // is that the six with detection rules are all still present.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
