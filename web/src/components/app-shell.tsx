import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Skull, Trash2 } from 'lucide-react';

import type { Session } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import type { UseNotificationsResult } from '../hooks/use-notifications';
import { NewSessionDialog } from './new-session-dialog';
import { QuickActions } from './quick-actions';
import { basename, formatElapsed } from './session-row';
import { SettingsDialog } from './settings-dialog';
import { Sidebar } from './sidebar';
import { StatusDot, STATUS_LABEL, STATUS_TEXT, isTerminalStatus } from './status-dot';
import { TerminalView } from './terminal-view';

const CLOCK_TICK_MS = 1000;

/**
 * One clock for every relative timestamp on screen. A `setInterval` per row
 * would be N timers and N renders a second; this is one of each, and every
 * timestamp stays in lockstep.
 */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * ⌘ on Apple platforms, Ctrl+Shift elsewhere.
 *
 * Plain Ctrl-K and Ctrl-N are readline bindings (kill-to-end-of-line, next-line)
 * that every harness TUI expects to receive, so on non-Apple platforms the app
 * must not swallow them. ⌘ is safe because terminals never claim it.
 */
function isPrimaryModifier(event: KeyboardEvent): boolean {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (mac) return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && event.shiftKey && !event.metaKey;
}

export interface AppShellProps {
  sessions: Session[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (id: string) => void;
  notifications: UseNotificationsResult;
}

export function AppShell({
  sessions,
  selectedId,
  connected,
  onSelect,
  notifications,
}: AppShellProps) {
  const now = useClock();
  const [newOpen, setNewOpen] = useState(false);
  // Held in state (not a ref) so QuickActions re-renders when the socket opens
  // or closes and can switch between socket and REST delivery.
  const [terminalSend, setTerminalSend] = useState<((data: string) => void) | null>(null);

  // Stable identity, or TerminalView's effect would re-run every render.
  // The extra arrow is required: React treats a bare function passed to a state
  // setter as an updater, which would call `send` instead of storing it.
  const handleSendReady = useCallback((send: ((data: string) => void) | null) => {
    setTerminalSend(() => send);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionBannerHidden, setPermissionBannerHidden] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const waiting = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'waiting_input')
        .sort((a, b) => a.statusChangedAt - b.statusChangedAt),
    [sessions],
  );

  /** Cycles through the attention queue, longest-waiting first. */
  const cycleAttention = useCallback((): void => {
    if (waiting.length === 0) return;
    const index = waiting.findIndex((s) => s.id === selectedId);
    const next = waiting[(index + 1) % waiting.length];
    if (next) onSelect(next.id);
  }, [waiting, selectedId, onSelect]);

  // Captured at the window because the terminal has focus almost all the time.
  // Only these two combinations are intercepted; everything else — including
  // every bare key, Ctrl-C and ⇧Tab — reaches the PTY verbatim.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPrimaryModifier(event) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        setNewOpen(true);
      } else if (key === 'k') {
        event.preventDefault();
        cycleAttention();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cycleAttention]);

  const runAction = (promise: Promise<void>): void => {
    setActionError(null);
    void promise.catch((cause: unknown) => {
      setActionError(cause instanceof ApiError ? cause.message : String(cause));
    });
  };

  const remove = (session: Session): void => {
    // Removing discards the scrollback for good, so it is the one destructive
    // button in the app and the only one that asks.
    const ok = window.confirm(`Remove "${session.title}"? Its output will be discarded.`);
    if (ok) runAction(api.removeSession(session.id));
  };

  const showPermissionBanner =
    notifications.supported && notifications.permission === 'default' && !permissionBannerHidden;

  return (
    <div className="flex h-full bg-base-950 text-base-100">
      <Sidebar
        sessions={sessions}
        selectedId={selectedId}
        connected={connected}
        now={now}
        onSelect={onSelect}
        onNew={() => setNewOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {showPermissionBanner && (
          <div className="flex shrink-0 items-center gap-2 border-b border-base-800 bg-base-900 px-4 py-1.5 text-[11px] text-base-300">
            <Bell className="size-3.5 shrink-0 text-status-waiting" />
            Turn on desktop notifications so you hear about blocked sessions.
            <button
              type="button"
              onClick={() => void notifications.request()}
              className="rounded border border-accent-dim bg-accent/15 px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Enable
            </button>
            <button
              type="button"
              onClick={() => setPermissionBannerHidden(true)}
              className="ml-auto rounded px-1.5 py-0.5 text-base-500 transition-colors hover:text-base-200"
            >
              Dismiss
            </button>
          </div>
        )}

        {selected ? (
          <header className="flex shrink-0 items-center gap-3 border-b border-base-800 bg-base-900 px-4 py-2">
            <StatusDot status={selected.status} />

            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-medium text-base-100">
                  {basename(selected.cwd)}
                </span>
                <span className="truncate text-[11px] text-base-400" title={selected.cwd}>
                  {selected.cwd}
                </span>
              </span>
              <span className="block truncate text-[11px] text-base-400">
                {selected.harnessName} ·{' '}
                <span className={cn(STATUS_TEXT[selected.status])}>
                  {STATUS_LABEL[selected.status]}
                </span>{' '}
                · {formatElapsed(selected.statusChangedAt, now)}
                {selected.exitCode !== undefined && ` · exit ${selected.exitCode}`}
              </span>
            </span>

            {actionError !== null && (
              <span className="truncate text-[11px] text-status-error">{actionError}</span>
            )}

            <button
              type="button"
              onClick={() => runAction(api.killSession(selected.id))}
              disabled={isTerminalStatus(selected.status)}
              title={
                isTerminalStatus(selected.status)
                  ? 'This session has already ended'
                  : 'Send SIGTERM, keep the output'
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-base-700 bg-base-850 px-2 py-1 text-[11px] text-base-200 transition-colors hover:border-status-error/50 hover:text-status-error disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Skull className="size-3.5" />
              Kill
            </button>

            <button
              type="button"
              onClick={() => remove(selected)}
              title="Kill and forget this session"
              className="inline-flex items-center gap-1.5 rounded-md border border-base-700 bg-base-850 px-2 py-1 text-[11px] text-base-200 transition-colors hover:border-status-error/50 hover:text-status-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Trash2 className="size-3.5" />
              Remove
            </button>
          </header>
        ) : (
          <header className="flex shrink-0 items-center border-b border-base-800 bg-base-900 px-4 py-2 text-[12px] text-base-400">
            No session selected
          </header>
        )}

        <div className="min-h-0 flex-1">
          <TerminalView sessionId={selectedId} onSendReady={handleSendReady} />
        </div>

        <QuickActions
          session={selected}
          send={terminalSend ?? undefined}
          terminalConnected={terminalSend !== null}
        />
      </main>

      {newOpen && (
        <NewSessionDialog
          onClose={() => setNewOpen(false)}
          onCreated={(session) => {
            setNewOpen(false);
            onSelect(session.id);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          supported={notifications.supported}
          permission={notifications.permission}
          onRequestPermission={() => void notifications.request()}
          muted={notifications.muted}
          onChangeMuted={notifications.setMuted}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
