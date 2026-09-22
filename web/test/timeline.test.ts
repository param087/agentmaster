import { describe, expect, it } from 'vitest';

import { formatDuration, summarizeTimeline } from '../src/lib/timeline';
import type { StatusEvent } from '../src/lib/types';

let nextId = 0;
const ev = (at: number, status: StatusEvent['status'], waitKind: StatusEvent['waitKind'] = null): StatusEvent => ({
  id: nextId++,
  sessionId: 's',
  at,
  status,
  waitKind,
});

describe('summarizeTimeline', () => {
  it('totals busy and waiting time, running the open segment to now', () => {
    const summary = summarizeTimeline(
      [ev(0, 'busy'), ev(10_000, 'waiting_input', 'permission'), ev(40_000, 'busy'), ev(45_000, 'waiting_input', 'turn')],
      50_000,
    );
    expect(summary.busyMs).toBe(15_000);
    expect(summary.waitingMs).toBe(35_000);
    expect(summary.waits).toBe(2);
    expect(summary.longestWaitMs).toBe(30_000);
    expect(summary.spanMs).toBe(50_000);
  });

  it('does not keep counting after the process stopped', () => {
    const summary = summarizeTimeline([ev(0, 'busy'), ev(5_000, 'exited')], 99_000);
    expect(summary.spanMs).toBe(5_000);
    expect(summary.segments.at(-1)).toMatchObject({ from: 5_000, to: 5_000 });
  });

  it('handles an empty history', () => {
    expect(summarizeTimeline([], 1)).toMatchObject({ spanMs: 0, waits: 0 });
  });
});

describe('formatDuration', () => {
  it('picks a compact unit', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(7_800_000)).toBe('2h 10m');
  });
});
