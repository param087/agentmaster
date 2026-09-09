import type { SessionStatus } from '../lib/types';
import { cn } from '../lib/cn';

/** Human-readable status names, used for tooltips, labels and the header. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Starting',
  busy: 'Working',
  waiting_input: 'Waiting for you',
  idle: 'Idle',
  exited: 'Exited',
  error: 'Error',
};

/**
 * Only the five palette variables from `index.css` are used, so status is the
 * one thing in the UI that carries colour.
 */
const STATUS_DOT: Record<SessionStatus, string> = {
  starting: 'bg-status-busy',
  busy: 'bg-status-busy',
  waiting_input: 'bg-status-waiting',
  idle: 'bg-status-idle',
  exited: 'bg-status-exited',
  error: 'bg-status-error',
};

const STATUS_HALO: Record<SessionStatus, string> = {
  starting: 'bg-status-busy/25',
  busy: 'bg-status-busy/25',
  waiting_input: 'bg-status-waiting/25',
  idle: 'bg-transparent',
  exited: 'bg-transparent',
  error: 'bg-status-error/25',
};

/** In-flight states animate; settled ones stay still so the sidebar is calm. */
const ANIMATED: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['starting', 'busy']);

export interface StatusDotProps {
  status: SessionStatus;
  className?: string;
}

/**
 * A fixed-size status indicator.
 *
 * The halo is always rendered (transparent when unused) so a status change can
 * never shift layout — this sits next to text in a list that updates constantly.
 */
export function StatusDot({ status, className }: StatusDotProps) {
  const label = STATUS_LABEL[status];

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('relative inline-flex size-2.5 shrink-0 items-center justify-center', className)}
    >
      {ANIMATED.has(status) && (
        <span
          aria-hidden
          className={cn('absolute inset-0 animate-ping rounded-full', STATUS_HALO[status])}
        />
      )}
      <span aria-hidden className={cn('relative size-2 rounded-full', STATUS_DOT[status])} />
    </span>
  );
}
