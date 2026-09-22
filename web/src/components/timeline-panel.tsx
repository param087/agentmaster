import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { formatDuration, summarizeTimeline } from '../lib/timeline';
import type { Session, SessionStatus, StatusEvent } from '../lib/types';
import { WAIT_KIND_SUBTITLE } from './session-row';
import { STATUS_LABEL } from './status-dot';

/** Segment fill per status, matching the sidebar dots. */
const SEGMENT_COLOR: Record<SessionStatus, string> = {
  starting: 'bg-status-idle',
  busy: 'bg-status-busy',
  waiting_input: 'bg-status-waiting',
  done: 'bg-status-done',
  idle: 'bg-status-idle/50',
  exited: 'bg-status-exited',
  killed: 'bg-status-killed',
  error: 'bg-status-error',
};

/** Only the most recent transitions are listed; the bar covers all of them. */
const MAX_LISTED = 40;

export interface TimelinePanelProps {
  session: Session;
  now: number;
  onClose: () => void;
}

/**
 * Where a session's time went: a proportional bar, the totals that matter
 * (how long it waited on *you*), and the recent transitions.
 */
export function TimelinePanel({ session, now, onClose }: TimelinePanelProps) {
  const [events, setEvents] = useState<StatusEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetched on every status change so the panel stays live while open.
  useEffect(() => {
    let cancelled = false;
    api.sessionEvents(session.id).then(
      (list) => {
        if (!cancelled) setEvents(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session.id, session.statusChangedAt]);

  const summary = events ? summarizeTimeline(events, now) : null;
  const listed = summary ? summary.segments.slice(-MAX_LISTED).reverse() : [];

  return (
    <aside
      aria-label="Timeline"
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-base-800 bg-base-900 shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b border-base-800 px-3 py-2">
        <h2 className="flex-1 text-[12px] font-semibold text-base-100">Timeline</h2>
        <button
          type="button"
          aria-label="Close timeline"
          onClick={onClose}
          className="rounded p-1 text-base-400 hover:bg-base-800 hover:text-base-100"
        >
          <X className="size-4" />
        </button>
      </header>

      {error !== null && <p className="p-3 text-[12px] text-status-error">{error}</p>}
      {summary === null && error === null && <p className="p-3 text-[12px] text-base-400">Loading…</p>}

      {summary !== null && summary.segments.length === 0 && (
        <p className="p-3 text-[12px] text-base-400">No activity recorded yet.</p>
      )}

      {summary !== null && summary.segments.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex h-3 w-full overflow-hidden rounded bg-base-800" role="img" aria-label="Status over time">
            {summary.segments.map((segment) => {
              const width = summary.spanMs > 0 ? ((segment.to - segment.from) / summary.spanMs) * 100 : 0;
              if (width <= 0) return null;
              return (
                <span
                  key={`${segment.from}-${segment.status}`}
                  className={SEGMENT_COLOR[segment.status]}
                  style={{ width: `${width}%` }}
                  title={`${STATUS_LABEL[segment.status]} · ${formatDuration(segment.to - segment.from)}`}
                />
              );
            })}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <Stat label="Working" value={formatDuration(summary.busyMs)} />
            <Stat label="Waiting on you" value={formatDuration(summary.waitingMs)} />
            <Stat label="Stops for input" value={String(summary.waits)} />
            <Stat label="Longest wait" value={formatDuration(summary.longestWaitMs)} />
          </dl>

          <h3 className="mb-1 mt-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-400">
            Recent
          </h3>
          <ol aria-label="Transitions" className="flex flex-col">
            {listed.map((segment) => (
              <li
                key={`${segment.from}-${segment.status}`}
                className="flex items-center gap-2 border-b border-base-850 py-1 text-[11px]"
              >
                <span className={`size-2 shrink-0 rounded-full ${SEGMENT_COLOR[segment.status]}`} />
                <span className="text-base-200">
                  {STATUS_LABEL[segment.status]}
                  {segment.waitKind !== null && segment.status === 'waiting_input' && (
                    <span className="text-base-400"> · {WAIT_KIND_SUBTITLE[segment.waitKind]}</span>
                  )}
                </span>
                <span className="ml-auto tabular-nums text-base-400">
                  {new Date(segment.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="w-14 text-right tabular-nums text-base-500">
                  {formatDuration(segment.to - segment.from)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-base-800 bg-base-950 px-2 py-1.5">
      <dt className="text-base-400">{label}</dt>
      <dd className="text-[13px] font-medium tabular-nums text-base-100">{value}</dd>
    </div>
  );
}
