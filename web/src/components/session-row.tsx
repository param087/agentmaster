import { AlertTriangle } from 'lucide-react';

import type { Session } from '../lib/types';
import { cn } from '../lib/cn';
import { HarnessIcon } from './harness-icon';
import { StatusDot } from './status-dot';

/** Last path segment, with `/` and `~` surviving as themselves. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/**
 * Compact elapsed time: `12s`, `5m`, `3h 20m`, `2d`.
 *
 * Deliberately not `Intl.RelativeTimeFormat` — "3 hours ago" is three times the
 * width for the same information in a 280px column.
 */
export function formatElapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export interface SessionRowProps {
  session: Session;
  selected: boolean;
  /** Shared clock from the sidebar: one interval for the whole list, not one per row. */
  now: number;
  /**
   * Show the detection rule that fired, inline. Only the attention queue asks
   * for this: it is a debugging affordance for wrong regexes, not primary UI.
   */
  showMatchedRule?: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({
  session,
  selected,
  now,
  showMatchedRule = false,
  onSelect,
}: SessionRowProps) {
  const waiting = session.status === 'waiting_input';
  const label = basename(session.cwd);

  // The rule lives in the tooltip everywhere, so a bad regex is always one hover
  // away without ever taking up space.
  const title =
    session.matchedRule === undefined
      ? `${session.title} — ${session.cwd}`
      : `${session.title} — ${session.cwd}\nmatched: ${session.matchedRule}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      aria-current={selected}
      title={title}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        selected
          ? 'bg-base-800 ring-1 ring-inset ring-base-700'
          : 'hover:bg-base-850 ring-1 ring-inset ring-transparent',
      )}
    >
      <StatusDot status={session.status} />
      <HarnessIcon harnessId={session.harnessId} title={session.harnessName} />

      <span className="min-w-0 flex-1 leading-tight">
        <span
          className={cn(
            'block truncate text-[13px]',
            selected ? 'text-base-100' : 'text-base-200 group-hover:text-base-100',
          )}
        >
          {label}
        </span>
        <span className="block truncate text-[11px] text-base-400">
          {session.harnessName} · {formatElapsed(session.statusChangedAt, now)}
          {/* Appended to the existing line, never a new one: the rule can appear
              and disappear with a status change without moving anything. */}
          {showMatchedRule && session.matchedRule !== undefined && (
            <>
              {' · '}
              <span className="font-mono text-base-500">{session.matchedRule}</span>
            </>
          )}
        </span>
      </span>

      {waiting && (
        <AlertTriangle
          aria-label="Waiting for input"
          className="size-3.5 shrink-0 text-status-waiting"
        />
      )}
    </button>
  );
}
