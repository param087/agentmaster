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
 */
async function replayFixture(name: string, harness: Harness): Promise<StatusSnapshot> {
  const clock = new FakeClock();
  const engine = new StatusEngine(harness, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  try {
    for (const chunk of loadFixture(name)) {
      await engine.onData(chunk);
    }
    clock.advance(harness.idleMs + 1);
    return engine.current;
  } finally {
    engine.dispose();
  }
}

describe('detection against recorded fixtures', () => {
  it.each<[string, string, SessionStatus, WaitKind | undefined]>([
    ['claude-permission', 'claude-code', 'waiting_input', 'permission'],
    ['claude-busy', 'claude-code', 'busy', undefined],
    ['claude-idle', 'claude-code', 'idle', undefined],
    ['opencode-permission', 'opencode', 'waiting_input', 'permission'],
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
    expect(ids).toHaveLength(6);
  });
});
