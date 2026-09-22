import { describe, expect, it } from 'vitest';

import { matchesFilter, orderSessions } from '../src/lib/session-order';
import type { Session } from '../src/lib/types';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    harnessIcon: 'claude-code',
    cwd: `/code/${id}`,
    title: id,
    status: 'idle',
    createdAt: 0,
    statusChangedAt: 0,
    ...extra,
  };
}

describe('matchesFilter', () => {
  it('matches every term across title, folder and harness, case-insensitively', () => {
    const s = session('api', { title: 'Fix Auth' });
    expect(matchesFilter(s, '')).toBe(true);
    expect(matchesFilter(s, 'auth')).toBe(true);
    expect(matchesFilter(s, 'claude /code/api')).toBe(true);
    expect(matchesFilter(s, 'auth billing')).toBe(false);
  });
});

describe('orderSessions', () => {
  it('floats pinned sessions without reordering the rest', () => {
    const list = [session('a'), session('b', { pinned: true }), session('c'), session('d', { pinned: true })];
    expect(orderSessions(list).map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('applies the filter before ordering', () => {
    const list = [session('web'), session('api', { pinned: true })];
    expect(orderSessions(list, 'web').map((s) => s.id)).toEqual(['web']);
  });
});
