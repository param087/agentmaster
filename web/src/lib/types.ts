/**
 * Wire types shared with the server live in `shared/types.ts` — one source of
 * truth, so the two sides can no longer drift. Only client-side helpers and
 * REST shapes the server never needs to name are declared here.
 */
export * from '../../../shared/types';

import type { WaitKind } from '../../../shared/types';

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

/** Wire shape of `GET /api/harnesses` entries. */
export interface HarnessInfo {
  id: string;
  name: string;
  command: string;
  /** Brand mark to draw. Resolved server-side, so the client never guesses. */
  icon: string;
  /** The command resolves to an executable on PATH. */
  available: boolean;
  /** Shown in the new-session picker. */
  enabled: boolean;
}
