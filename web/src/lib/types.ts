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

export type WaitKind = 'permission' | 'question' | 'menu' | 'unknown';

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
