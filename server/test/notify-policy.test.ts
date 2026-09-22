import { describe, expect, it } from 'vitest';

import { inQuietHours, isMuted, shouldPush } from '../src/notify/policy.js';
import type { NotifyPrefs } from '../src/status/types.js';

const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({
  pushKinds: ['waiting', 'error'],
  quietHours: null,
  mutedHarnesses: [],
  ...over,
});

describe('inQuietHours', () => {
  it('handles same-day windows as half-open', () => {
    const q = { start: '12:00', end: '13:30' };
    expect(inQuietHours(q, at(11, 59))).toBe(false);
    expect(inQuietHours(q, at(12, 0))).toBe(true);
    expect(inQuietHours(q, at(13, 29))).toBe(true);
    expect(inQuietHours(q, at(13, 30))).toBe(false);
  });
  it('wraps windows past midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(inQuietHours(q, at(23))).toBe(true);
    expect(inQuietHours(q, at(3))).toBe(true);
    expect(inQuietHours(q, at(7))).toBe(false);
    expect(inQuietHours(q, at(21, 59))).toBe(false);
  });
  it('treats an empty window and no window as never quiet', () => {
    expect(inQuietHours({ start: '09:00', end: '09:00' }, at(9))).toBe(false);
    expect(inQuietHours(null, at(9))).toBe(false);
  });
});

describe('shouldPush', () => {
  const ctx = { kind: 'waiting' as const, harnessId: 'claude-code', sessionMuted: false };
  it('pushes enabled kinds outside quiet hours', () => {
    expect(shouldPush(prefs(), ctx, at(10))).toBe(true);
    expect(shouldPush(prefs(), { ...ctx, kind: 'done' }, at(10))).toBe(false);
  });
  it('is silenced by quiet hours, a muted harness, or a muted session', () => {
    expect(shouldPush(prefs({ quietHours: { start: '09:00', end: '11:00' } }), ctx, at(10))).toBe(false);
    expect(shouldPush(prefs({ mutedHarnesses: ['claude-code'] }), ctx, at(10))).toBe(false);
    expect(shouldPush(prefs(), { ...ctx, sessionMuted: true }, at(10))).toBe(false);
    expect(isMuted(prefs(), { ...ctx, sessionMuted: true })).toBe(true);
  });
});
