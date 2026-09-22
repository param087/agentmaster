import type { SessionStatus, StatusEvent, WaitKind } from './types';

export interface TimelineSegment {
  status: SessionStatus;
  waitKind: WaitKind | null;
  from: number;
  to: number;
}

export interface TimelineSummary {
  segments: TimelineSegment[];
  /** Time the harness spent working. */
  busyMs: number;
  /** Time spent blocked on you: every `waiting_input`, modal or turn-end. */
  waitingMs: number;
  /** How many times it stopped for you. */
  waits: number;
  /** Longest single wait, the number worth being embarrassed about. */
  longestWaitMs: number;
  spanMs: number;
}

/**
 * Folds transitions into contiguous segments, the last one running to `now`
 * (or to its own start, for a session that has stopped).
 */
export function summarizeTimeline(events: readonly StatusEvent[], now: number): TimelineSummary {
  const segments: TimelineSegment[] = events.map((event, i) => {
    const next = events[i + 1];
    const terminal = event.status === 'exited' || event.status === 'killed' || event.status === 'error';
    return {
      status: event.status,
      waitKind: event.waitKind,
      from: event.at,
      to: next ? next.at : terminal ? event.at : Math.max(event.at, now),
    };
  });

  let busyMs = 0;
  let waitingMs = 0;
  let waits = 0;
  let longestWaitMs = 0;
  for (const segment of segments) {
    const length = segment.to - segment.from;
    if (segment.status === 'busy') busyMs += length;
    if (segment.status === 'waiting_input') {
      waitingMs += length;
      waits += 1;
      longestWaitMs = Math.max(longestWaitMs, length);
    }
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const spanMs = first && last ? last.to - first.from : 0;
  return { segments, busyMs, waitingMs, waits, longestWaitMs, spanMs };
}

/** `850ms`, `42s`, `3m 05s`, `2h 10m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
