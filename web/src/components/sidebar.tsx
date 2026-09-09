import { BellOff, Plus, Settings, WifiOff } from 'lucide-react';

import type { Session } from '../lib/types';
import { cn } from '../lib/cn';
import { AttentionQueue } from './attention-queue';
import { SessionRow } from './session-row';
import { isTerminalStatus } from './status-dot';

export interface SidebarProps {
  sessions: Session[];
  selectedId: string | null;
  connected: boolean;
  /** Shared clock from `AppShell` — one interval drives every relative timestamp. */
  now: number;
  /**
   * Permission is not granted, or `waiting` is muted — either way the user will
   * not be told when a session needs them, and that must be visible at all
   * times rather than only in a banner they can scroll past.
   */
  notificationsDeaf: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  /** Forgets every stopped session. Only offered when there are some. */
  onClearFinished: () => void;
}

export function Sidebar({
  sessions,
  selectedId,
  connected,
  now,
  notificationsDeaf,
  onClearFinished,
  onSelect,
  onNew,
  onOpenSettings,
}: SidebarProps) {
  const finishedCount = sessions.filter((s) => isTerminalStatus(s.status)).length;
  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-base-800 bg-base-900">
      <header className="flex shrink-0 items-center gap-2 border-b border-base-800 px-3 py-2.5">
        <h1 className="flex-1 truncate text-[13px] font-semibold tracking-tight text-base-100">
          agent<span className="text-accent">master</span>
        </h1>

        {notificationsDeaf && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="You will not be told when a session needs you. Click to fix."
            aria-label="Notifications are off — open settings"
            className="rounded p-1.5 text-status-waiting transition-colors hover:bg-status-waiting/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <BellOff className="size-4" />
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          className="rounded p-1.5 text-base-400 transition-colors hover:bg-base-800 hover:text-base-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Settings className="size-4" />
        </button>

        <button
          type="button"
          onClick={onNew}
          title="New session (⌘N)"
          className="inline-flex items-center gap-1 rounded-md border border-base-700 bg-base-800 px-2 py-1 text-[11px] font-medium text-base-100 transition-colors hover:border-accent-dim hover:bg-base-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Plus className="size-3.5" />
          New
        </button>
      </header>

      {!connected && (
        <div className="flex shrink-0 items-center gap-2 border-b border-status-error/30 bg-status-error/10 px-3 py-1.5 text-[11px] text-status-error">
          <WifiOff className="size-3.5 shrink-0" />
          Disconnected — retrying…
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <AttentionQueue
          sessions={sessions}
          selectedId={selectedId}
          now={now}
          onSelect={onSelect}
        />

        <h2 className="flex items-center gap-2 px-3.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-400">
          Sessions
          <span className="ml-auto tabular-nums text-base-500">{sessions.length}</span>
          {/*
            Stopped sessions are kept on purpose so their output stays readable,
            so the list only grows. This is the manual escape hatch — nothing is
            ever pruned automatically, because silently deleting history is worse
            than a long list.
          */}
          {finishedCount > 0 && (
            <button
              type="button"
              onClick={onClearFinished}
              title={`Forget ${finishedCount} stopped session${finishedCount === 1 ? '' : 's'}`}
              className="rounded border border-transparent px-1 py-0.5 text-[9px] uppercase tracking-[0.1em] text-base-500 transition-colors hover:border-base-700 hover:text-base-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Clear
            </button>
          )}
        </h2>

        {sessions.length === 0 ? (
          <p className="px-3.5 py-6 text-[12px] leading-relaxed text-base-400">
            No sessions yet.
            <br />
            <button
              type="button"
              onClick={onNew}
              className="mt-1 rounded text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Start one
            </button>{' '}
            to spawn a harness in a folder.
          </p>
        ) : (
          <div className={cn('flex flex-col gap-0.5 px-2')}>
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                now={now}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
