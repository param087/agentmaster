import type { SessionStatus } from '../lib/types';
import { cn } from '../lib/cn';

/** Human-readable status names, used for tooltips, labels and the header. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Starting',
  busy: 'Working',
  waiting_input: 'Waiting for you',
  done: 'Done',
  idle: 'Idle',
  exited: 'Exited',
  killed: 'Killed',
  error: 'Error',
};

/**
 * Only the status palette variables from `index.css` are used, so status is the
 * one thing in the UI that carries colour.
 */
const STATUS_DOT: Record<SessionStatus, string> = {
  starting: 'bg-status-busy',
  busy: 'bg-status-busy',
  waiting_input: 'bg-status-waiting',
  done: 'bg-status-done',
  idle: 'bg-status-idle',
  exited: 'bg-status-exited',
  killed: 'bg-status-killed',
  error: 'bg-status-error',
};

const STATUS_HALO: Record<SessionStatus, string> = {
  starting: 'bg-status-busy/25',
  busy: 'bg-status-busy/25',
  waiting_input: 'bg-status-waiting/25',
  // `done` is unseen work: it gets the halo that says "look here", but no
  // animation — it is finished, not in flight.
  done: 'bg-status-done/25',
  idle: 'bg-transparent',
  exited: 'bg-transparent',
  // Killed is a settled state you caused; a halo would imply it wants something.
  killed: 'bg-transparent',
  error: 'bg-status-error/25',
};

/**
 * Text colour for the header status word. Empty means "inherit" — only the
 * states that want something from you, plus the two failure-ish ends, colour
 * their label; ambient activity stays neutral.
 */
export const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: '',
  busy: '',
  waiting_input: 'text-status-waiting',
  done: 'text-status-done',
  idle: '',
  exited: '',
  killed: 'text-status-killed',
  error: 'text-status-error',
};

/**
 * The process is gone and nothing can be sent to it any more.
 *
 * A record rather than a set so adding a status is a type error here too.
 */
const TERMINAL: Record<SessionStatus, boolean> = {
  starting: false,
  busy: false,
  waiting_input: false,
  done: false,
  idle: false,
  exited: true,
  killed: true,
  error: true,
};

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL[status];
}

/** In-flight states animate; settled ones stay still so the sidebar is calm. */
const ANIMATED: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['starting', 'busy']);

export interface StatusDotProps {
  status: SessionStatus;
  className?: string;
}

/**
 * A fixed-size status indicator.
 *
 * The halo is always rendered (transparent when unused, animated only for
 * in-flight states) so a status change can never shift layout — this sits next
 * to text in a list that updates constantly.
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
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-full',
          ANIMATED.has(status) && 'animate-ping',
          STATUS_HALO[status],
        )}
      />
      <span aria-hidden className={cn('relative size-2 rounded-full', STATUS_DOT[status])} />
    </span>
  );
}
