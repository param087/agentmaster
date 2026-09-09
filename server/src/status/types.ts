export type SessionStatus = 'starting' | 'busy' | 'waiting_input' | 'idle' | 'exited' | 'error';

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
      kind: 'waiting' | 'finished' | 'exited' | 'error';
      title: string;
      body: string;
    };
