import { useState } from 'react';

import { api, ApiError } from '../lib/api';
import type { Session, WaitKind } from '../lib/types';

const WAIT_KIND_LABEL: Record<WaitKind, string> = {
  permission: 'permission',
  question: 'question',
  menu: 'menu',
  unknown: 'input',
};

/** Renders control bytes readably for the tooltip: `1\r`, `\u001b`. */
export function escapeKeys(keys: string): string {
  return keys.replace(/[\u0000-\u001f\u007f]/g, (char) => {
    if (char === '\r') return '\\r';
    if (char === '\n') return '\\n';
    if (char === '\t') return '\\t';
    if (char === '\u001b') return '\\e';
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

export interface QuickActionsProps {
  session: Session | null;
  /**
   * Writes bytes down the live terminal socket. Optional: when the socket is
   * closed (or the terminal is not mounted) we fall back to `POST /input`,
   * which writes to the same PTY.
   */
  send?: ((keys: string) => void) | undefined;
  terminalConnected?: boolean | undefined;
}

/**
 * One button per harness-declared quick action for a blocked session.
 *
 * The bytes are sent verbatim — a click is indistinguishable from typing, which
 * is why this needs no per-harness code.
 */
export function QuickActions({ session, send, terminalConnected }: QuickActionsProps) {
  const [error, setError] = useState<string | null>(null);

  const actions = session?.actions ?? [];
  if (!session || session.status !== 'waiting_input' || actions.length === 0) return null;

  const run = (keys: string, button: HTMLButtonElement): void => {
    // The terminal keeps the keyboard; a button that holds focus would silently
    // eat the user's next keystroke.
    button.blur();
    setError(null);

    if (send && terminalConnected) {
      send(keys);
      return;
    }
    void api.sendInput(session.id, keys).catch((cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-status-waiting/25 bg-status-waiting/[0.06] px-4 py-2">
      <span className="text-[11px] uppercase tracking-[0.12em] text-status-waiting">
        {WAIT_KIND_LABEL[session.waitKind ?? 'unknown']}
      </span>

      {actions.map((action) => (
        <button
          key={`${action.label}:${action.keys}`}
          type="button"
          title={`Sends: ${escapeKeys(action.keys)}`}
          onClick={(event) => run(action.keys, event.currentTarget)}
          className="rounded-md border border-status-waiting/40 bg-base-900 px-2.5 py-1 text-[12px] text-base-100 transition-colors hover:border-status-waiting hover:bg-base-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-waiting"
        >
          {action.label}
        </button>
      ))}

      {error !== null && <span className="text-[11px] text-status-error">{error}</span>}
    </div>
  );
}
