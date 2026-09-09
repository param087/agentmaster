import type { Session } from '../lib/types';
import { SessionRow } from './session-row';

export interface AttentionQueueProps {
  sessions: Session[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}

/**
 * Sessions blocked on the user, longest-waiting first.
 *
 * Ascending `statusChangedAt` is the entire point of this panel: a session that
 * has been blocked for ten minutes is more urgent than one blocked for two
 * seconds, and sorting the other way would bury it.
 */
export function AttentionQueue({ sessions, selectedId, now, onSelect }: AttentionQueueProps) {
  const waiting = sessions
    .filter((s) => s.status === 'waiting_input')
    .sort((a, b) => a.statusChangedAt - b.statusChangedAt);

  if (waiting.length === 0) return null;

  return (
    <section
      aria-label="Needs attention"
      className="mx-2 mb-2 rounded-lg border border-status-waiting/25 bg-status-waiting/[0.06] p-1.5"
    >
      <h2 className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-status-waiting">
        Needs attention
        <span className="tabular-nums text-status-waiting/70">{waiting.length}</span>
      </h2>

      <div className="flex flex-col gap-0.5">
        {waiting.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === selectedId}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}
