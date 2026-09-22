import type { Session } from '../lib/types';
import { isModalWait } from '../lib/types';
import { ScreenPreview } from './screen-preview';
import { SessionRow } from './session-row';

/**
 * Every amber session, most urgent first.
 *
 * Two orderings, in this priority:
 *
 * 1. Modal kinds (`permission` / `menu` / `question`) above `turn`. A jammed
 *    harness is burning wall-clock doing nothing; a finished turn is only
 *    waiting on you to read it.
 * 2. Oldest first within each group — a session blocked for ten minutes is more
 *    urgent than one blocked for two seconds, and sorting the other way would
 *    bury it.
 */
export function attentionOrder(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.status === 'waiting_input')
    .sort((a, b) => {
      const rank = Number(isModalWait(b.waitKind)) - Number(isModalWait(a.waitKind));
      return rank !== 0 ? rank : a.statusChangedAt - b.statusChangedAt;
    });
}

export interface AttentionQueueProps {
  sessions: Session[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}

export function AttentionQueue({ sessions, selectedId, now, onSelect }: AttentionQueueProps) {
  const waiting = attentionOrder(sessions);

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
          <div key={session.id}>
            <SessionRow
              session={session}
              selected={session.id === selectedId}
              now={now}
              showMatchedRule
              onSelect={onSelect}
            />
            {/* The selected session's screen is already on display. */}
            {session.preview !== undefined && session.id !== selectedId && (
              <ScreenPreview preview={session.preview} label={`Screen of ${session.title}`} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
