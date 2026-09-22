import type { Session } from './types';

/** True when every whitespace-separated term appears in title, folder or harness. */
export function matchesFilter(session: Session, filter: string): boolean {
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${session.title} ${session.cwd} ${session.harnessName}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Sidebar order: pinned first, then the server's newest-first order.
 * Stable, so pinning never reshuffles the rest of the list.
 */
export function orderSessions(sessions: readonly Session[], filter = ''): Session[] {
  const visible = sessions.filter((s) => matchesFilter(s, filter));
  return [...visible.filter((s) => s.pinned), ...visible.filter((s) => !s.pinned)];
}
