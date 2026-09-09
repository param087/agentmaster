/**
 * Mirror of `server/src/status/types.ts`.
 *
 * These types are duplicated rather than imported because the two workspaces
 * build independently. **Keep this file in sync verbatim** — any change on the
 * server side must be reflected here in the same commit.
 */

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
 * output, it went quiet. It is an unread marker, so looking at it clears it —
 * and `matchedRule` / `actions` are both unset, which is the discriminator.
 */
export type WaitKind = 'permission' | 'question' | 'menu' | 'turn' | 'unknown';

/** Modal kinds: the harness is stuck and viewing the session will not clear it. */
export const MODAL_WAIT_KINDS: ReadonlySet<WaitKind> = new Set<WaitKind>([
  'permission',
  'question',
  'menu',
]);

/** True when the session is jammed on a prompt, rather than just "your move". */
export function isModalWait(kind: WaitKind | undefined): boolean {
  return kind !== undefined && MODAL_WAIT_KINDS.has(kind);
}

export interface QuickAction {
  label: string;
  keys: string;
}

export interface Session {
  id: string;
  harnessId: string;
  harnessName: string;
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

/** Wire shape of `GET /api/harnesses` entries. */
export interface HarnessInfo {
  id: string;
  name: string;
  command: string;
}
