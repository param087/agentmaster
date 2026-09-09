export type SessionStatus =
  | 'starting'
  | 'busy'
  | 'waiting_input'
  /** Finished a long task and nobody has looked at it yet. */
  | 'done'
  | 'idle'
  | 'exited'
  /** The user pressed Kill. Distinct from `exited` because SIGTERM often reports code 0. */
  | 'killed'
  | 'error';

/**
 * Why a session is amber.
 *
 * `permission` / `question` / `menu` come from a harness rule: the CLI is
 * *modally blocked* and cannot continue without you. They clear only when the
 * harness itself moves on — looking at the screen does not unblock it.
 *
 * `turn` is the regex-free generic case: you submitted something, it produced
 * output, it went quiet. It is an unread marker, so looking at it clears it.
 */
export type WaitKind = 'permission' | 'question' | 'menu' | 'turn' | 'unknown';

export interface QuickAction {
  label: string;
  keys: string;
}

export interface Session {
  id: string;
  harnessId: string;
  harnessName: string;
  /** Brand mark to draw for this session. Defaults to `harnessId`. */
  harnessIcon: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  waitKind?: WaitKind;
  actions?: QuickAction[];
  /** Source text of the waiting rule that fired, so a wrong regex is visible. */
  matchedRule?: string;
  pid?: number;
  exitCode?: number;
  createdAt: number;
  statusChangedAt: number;
  busySince?: number;
}

export type ServerEvent =
  | { t: 'snapshot'; sessions: Session[] }
  | { t: 'session:created'; session: Session }
  | { t: 'session:updated'; session: Session }
  | { t: 'session:removed'; id: string }
  | {
      t: 'notify';
      id: string;
      kind: 'waiting' | 'done' | 'exited' | 'killed' | 'error';
      title: string;
      body: string;
    };

/** Statuses where the process is gone and only a restart can revive it. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'exited',
  'killed',
  'error',
]);

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
