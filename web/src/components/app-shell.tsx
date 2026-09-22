import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  Maximize2,
  Menu,
  MoreVertical,
  History,
  Pin,
  PinOff,
  RotateCcw,
  Skull,
  Trash2,
  X,
} from 'lucide-react';

import type { Session } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { isPrimaryModifier } from '../lib/keys';
import { useIsNarrow, useIsTouch } from '../hooks/use-media-query';
import type { UseNotificationsResult } from '../hooks/use-notifications';
import type { UsePushResult } from '../hooks/use-push';
import { TERM_COLS, TERM_ROWS, type TerminalDims } from '../hooks/use-terminal';
import { attentionOrder } from './attention-queue';
import { KeyBar } from './key-bar';
import { NewSessionDialog } from './new-session-dialog';
import { QuickActions } from './quick-actions';
import { PromptComposer } from './prompt-composer';
import { formatPrompt } from '../lib/prompt';
import { formatElapsed } from './session-row';
import { ConfirmDialog } from './confirm-dialog';
import { EditableTitle } from './editable-title';
import { TimelinePanel } from './timeline-panel';
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

const HEADER_BUTTON =
  'inline-flex items-center gap-1.5 rounded-md border border-base-700 bg-base-850 px-2 py-1 ' +
  'text-[11px] text-base-200 transition-colors focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-accent';

export interface AppShellProps {
  sessions: Session[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (id: string) => void;
  notifications: UseNotificationsResult;
  push: UsePushResult;
}

export function AppShell({
  sessions,
  selectedId,
  connected,
  onSelect,
  notifications,
  push,
}: AppShellProps) {
  const now = useClock();
  const narrow = useIsNarrow();
  const touch = useIsTouch();
  const [newOpen, setNewOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Held in state (not a ref) so QuickActions re-renders when the socket opens
  // or closes and can switch between socket and REST delivery.
  const [terminalSend, setTerminalSend] = useState<((data: string) => void) | null>(null);
  const [setInputTransform, setSetInputTransform] = useState<
    ((transform: ((data: string) => string) | null) => void) | null
  >(null);

  // Stable identity, or TerminalView's effect would re-run every render.
  // The extra arrow is required: React treats a bare function passed to a state
  // setter as an updater, which would call `send` instead of storing it.
  const handleSendReady = useCallback((send: ((data: string) => void) | null) => {
    setTerminalSend(() => send);
  }, []);
  const handleInputTransformReady = useCallback(
    (set: ((transform: ((data: string) => string) | null) => void) | null) => {
      setSetInputTransform(() => set);
    },
    [],
  );

  const [sendPrompt, setSendPrompt] = useState<((text: string) => void) | null>(null);
  const handleSendPromptReady = useCallback((send: ((text: string) => void) | null) => {
    setSendPrompt(() => send);
  }, []);
  // Other sessions' terminal modes are unknown here; every agent CLI we ship
  // enables bracketed paste, so multi-line broadcasts assume it.
  const sendToOther = useCallback(
    (id: string, text: string) => api.sendInput(id, formatPrompt(text, true)),
    [],
  );

  // A ref, not state: the plan must be *measured at click time*, after any
  // rotation or soft-keyboard show/hide, and storing it in state would only
  // cause renders nobody needs.
  const fitPlanRef = useRef<(() => TerminalDims | null) | null>(null);
  const handleFitPlanReady = useCallback((plan: (() => TerminalDims | null) | null) => {
    fitPlanRef.current = plan;
  }, []);

  /**
   * An explicit PTY geometry for the selected session, or `null` for the
   * server's fixed 120x32. Per session, and dropped on switch: it is a
   * deliberate, confirmed action, never something inherited by accident.
   */
  const [ptyDims, setPtyDims] = useState<TerminalDims | null>(null);
  useEffect(() => setPtyDims(null), [selectedId]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  /**
   * The one pending confirmation, or null. A single slot rather than a flag per
   * action: only one dialog can ever be up, and this keeps the wiring honest.
   */
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const waiting = useMemo(() => attentionOrder(sessions), [sessions]);

  /** Cycles through the attention queue in the same order the sidebar shows. */
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

  // Escape closes whichever transient surface is open. Registered on `keyup` in
  // the bubble phase so it cannot swallow the Escape the terminal needs — the
  // drawer and the menu are only open when the terminal is not being typed into.
  useEffect(() => {
    if (!drawerOpen && !menuOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setDrawerOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, menuOpen]);

  // The drawer is a phone affordance; widening the window must not leave an
  // invisible overlay swallowing clicks.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  const runAction = (promise: Promise<void>): void => {
    setActionError(null);
    void promise.catch((cause: unknown) => {
      setActionError(cause instanceof ApiError ? cause.message : String(cause));
    });
  };

  const clearFinished = (): void => {
    const count = sessions.filter((s) => isTerminalStatus(s.status)).length;
    if (count === 0) return;
    setConfirm({
      title: `Clear ${count} stopped session${count === 1 ? '' : 's'}?`,
      body: 'Their output will be discarded. Running sessions are left alone.',
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: () => runAction(api.removeFinished().then(() => undefined)),
    });
  };

  const remove = (session: Session): void => {
    // Removing discards the scrollback for good, so it is the one action that
    // destroys something unrecoverable.
    setMenuOpen(false);
    setConfirm({
      title: isTerminalStatus(session.status) ? 'Delete session?' : 'Remove session?',
      body: `"${session.title}" and its output will be discarded. This cannot be undone.`,
      confirmLabel: isTerminalStatus(session.status) ? 'Delete' : 'Remove',
      destructive: true,
      onConfirm: () => runAction(api.removeSession(session.id)),
    });
  };

  /**
   * Resizes the *actual PTY* to fill this device's screen.
   *
   * This is the one control here that is not local to this browser: the server
   * calls `session.resize`, so a laptop watching the same session reflows too.
   * Hence the explicit confirmation naming the consequence.
   */
  const fitToScreen = (): void => {
    setMenuOpen(false);
    const plan = fitPlanRef.current?.() ?? null;
    if (!plan) {
      setActionError('Terminal is not ready to measure yet');
      return;
    }
    setConfirm({
      title: `Resize terminal to ${plan.cols}×${plan.rows}?`,
      body:
        'This resizes the real PTY, so it affects everyone watching this session — ' +
        'any other open viewer will reflow to the same size.',
      confirmLabel: 'Resize',
      onConfirm: () => setPtyDims(plan),
    });
  };

  const resetPtySize = (): void => {
    setMenuOpen(false);
    setPtyDims(null);
  };

  const selectFromDrawer = useCallback(
    (id: string): void => {
      onSelect(id);
      setDrawerOpen(false);
    },
    [onSelect],
  );

  // Deliberately not dismissible. The original bug was six correct detections
  // producing zero notifications because this banner had been dismissed and
  // never thought about again; a nagging strip is cheaper than a missed prompt.
  const showPermissionBanner = notifications.supported && notifications.permission === 'default';

  // Either half means the user will not hear about a blocked session.
  const notificationsDeaf =
    notifications.supported && (notifications.permission !== 'granted' || notifications.muted.waiting);

  /**
   * The install affordance, or null when there is nothing to offer.
   *
   * Chrome hands us a real prompt via `beforeinstallprompt`. iOS never does —
   * there is no API at all — so the only honest option there is to open Settings
   * and show the Share → Add to Home Screen steps.
   */
  const install: { label: string; onClick: () => void } | null = push.promptInstall
    ? { label: 'Install agentmaster as an app', onClick: () => void push.promptInstall?.() }
    : push.needsInstall
      ? {
          label: 'Add to Home Screen to get notifications on this phone',
          onClick: () => {
            setDrawerOpen(false);
            setSettingsOpen(true);
          },
        }
      : null;

  const sidebar = (
    <Sidebar
      sessions={sessions}
      selectedId={selectedId}
      connected={connected}
      now={now}
      onSelect={narrow ? selectFromDrawer : onSelect}
      notificationsDeaf={notificationsDeaf}
      install={install}
      onNew={() => {
        setDrawerOpen(false);
        setNewOpen(true);
      }}
      onOpenSettings={() => {
        setDrawerOpen(false);
        setSettingsOpen(true);
      }}
      onClearFinished={clearFinished}
    />
  );

  const restartButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        runAction(api.restartSession(selected.id).then(() => undefined));
      }}
      title="Re-run this harness in the same folder"
      className={cn(HEADER_BUTTON, 'hover:border-status-busy/60 hover:text-status-busy')}
    >
      <RotateCcw className="size-3.5" />
      Restart
    </button>
  );

  const killButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        runAction(api.killSession(selected.id));
      }}
      title="Send SIGTERM, keep the output"
      className={cn(HEADER_BUTTON, 'hover:border-status-error/50 hover:text-status-error')}
    >
      <Skull className="size-3.5" />
      Kill
    </button>
  );

  const removeButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        remove(selected);
      }}
      title={
        isTerminalStatus(selected.status)
          ? 'Forget this session and its output'
          : 'Kill and forget this session'
      }
      className={cn(HEADER_BUTTON, 'hover:border-status-error/50 hover:text-status-error')}
    >
      <Trash2 className="size-3.5" />
      {isTerminalStatus(selected.status) ? 'Delete' : 'Remove'}
    </button>
  );

  const timelineButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        setTimelineOpen((open) => !open);
      }}
      aria-pressed={timelineOpen}
      title="Where this session's time went"
      className={cn(HEADER_BUTTON, 'hover:border-accent-dim hover:text-accent')}
    >
      <History className="size-3.5" />
      Timeline
    </button>
  );

  const muteButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        runAction(api.updateSession(selected.id, { muted: !selected.muted }).then(() => undefined));
      }}
      aria-pressed={selected.muted === true}
      title={selected.muted ? 'Notify about this session again' : 'No notifications from this session'}
      className={cn(HEADER_BUTTON, 'hover:border-accent-dim hover:text-accent')}
    >
      {selected.muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
      {selected.muted ? 'Unmute' : 'Mute'}
    </button>
  );

  const pinButton = selected && (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        runAction(api.updateSession(selected.id, { pinned: !selected.pinned }).then(() => undefined));
      }}
      aria-pressed={selected.pinned === true}
      title={selected.pinned ? 'Unpin from the top of the list' : 'Pin to the top of the list'}
      className={cn(HEADER_BUTTON, 'hover:border-accent-dim hover:text-accent')}
    >
      {selected.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      {selected.pinned ? 'Unpin' : 'Pin'}
    </button>
  );

  const fitButton = selected && (
    <button
      type="button"
      onClick={ptyDims ? resetPtySize : fitToScreen}
      title={
        ptyDims
          ? `Back to the fixed ${TERM_COLS}×${TERM_ROWS} PTY`
          : 'Resize the real PTY to fill this screen — affects every viewer'
      }
      className={cn(HEADER_BUTTON, 'hover:border-accent-dim hover:text-accent')}
    >
      <Maximize2 className="size-3.5" />
      {ptyDims ? `${ptyDims.cols}×${ptyDims.rows} · Reset` : 'Fit to screen'}
    </button>
  );

  return (
    <div className="flex h-full bg-base-950 text-base-100">
      {narrow ? (
        <>
          {drawerOpen && (
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-30 bg-black/60"
            />
          )}
          <div
            className={cn(
              'fixed inset-y-0 left-0 z-40 w-[280px] max-w-[85vw] shadow-2xl transition-transform duration-200',
              'pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
              drawerOpen ? 'translate-x-0' : '-translate-x-full',
            )}
            // `inert` alone, deliberately: it already removes the subtree from
            // the a11y tree *and* from the tab order. Adding `aria-hidden` here
            // instead trips the "aria-hidden on a focused ancestor" violation,
            // because the row the user just tapped still holds focus at the
            // moment the drawer closes.
            inert={!drawerOpen}
          >
            {sidebar}
          </div>
        </>
      ) : (
        sidebar
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {showPermissionBanner && (
          <div className="flex shrink-0 items-center gap-2 border-b border-status-waiting/30 bg-status-waiting/10 px-4 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-[11px] text-status-waiting">
            <BellOff className="size-3.5 shrink-0" />
            {/* Worded as the consequence, not the setting: "notifications are
                off" is ignorable, "you will not be told" is not. */}
            <span className="font-medium">Notifications are off</span>
            <span className="hidden text-base-300 sm:inline">
              — you will not be told when a session needs you.
            </span>
            <button
              type="button"
              onClick={() => void notifications.request()}
              className="ml-auto shrink-0 rounded border border-accent-dim bg-accent/15 px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Enable
            </button>
          </div>
        )}

        <header
          className={cn(
            'relative flex shrink-0 items-center gap-3 border-b border-base-800 bg-base-900 px-4 py-2',
            !showPermissionBanner && 'pt-[max(0.5rem,env(safe-area-inset-top))]',
            'pr-[max(1rem,env(safe-area-inset-right))]',
          )}
        >
          {narrow && (
            // The badge is the entire point of the app on a phone: with the
            // drawer shut, a blocked session must still be visible.
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={
                waiting.length > 0
                  ? `Open sessions — ${waiting.length} need attention`
                  : 'Open sessions'
              }
              className="relative -ml-1 inline-flex size-10 shrink-0 items-center justify-center rounded-md text-base-200 transition-colors active:bg-base-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Menu className="size-5" />
              {waiting.length > 0 && (
                <span
                  data-testid="attention-badge"
                  className="absolute right-0.5 top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-status-waiting px-1 text-[10px] font-semibold leading-4 tabular-nums text-base-950"
                >
                  {waiting.length}
                </span>
              )}
            </button>
          )}

          {selected ? (
            <>
              <StatusDot status={selected.status} />

              <span className="min-w-0 flex-1 leading-tight">
                <span className="flex items-baseline gap-2">
                  <EditableTitle
                    key={selected.id}
                    title={selected.title}
                    onRename={async (title) => {
                      setActionError(null);
                      try {
                        await api.updateSession(selected.id, { title });
                      } catch (cause) {
                        setActionError(cause instanceof ApiError ? cause.message : String(cause));
                        throw cause;
                      }
                    }}
                  />
                  {/* The full path is the first thing to go when space runs
                      out; the folder name and status carry the meaning. */}
                  <span
                    className="hidden truncate text-[11px] text-base-400 sm:inline"
                    title={selected.cwd}
                  >
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
                <span className="hidden truncate text-[11px] text-status-error md:inline">
                  {actionError}
                </span>
              )}

              {/*
                Two slots, contextual: a stopped session offers Restart, a live
                one offers Kill. Same positions either way, so nothing shifts
                when a session dies under the cursor.

                On a phone they move into an overflow menu rather than being
                dropped — killing a runaway session from your pocket is exactly
                the case this app exists for.
              */}
              {narrow ? (
                <>
                  <button
                    type="button"
                    onClick={() => setMenuOpen((open) => !open)}
                    aria-label="Session actions"
                    aria-expanded={menuOpen}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-base-200 transition-colors active:bg-base-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    {menuOpen ? <X className="size-5" /> : <MoreVertical className="size-5" />}
                  </button>

                  {menuOpen && (
                    <>
                      <button
                        type="button"
                        aria-label="Close menu"
                        onClick={() => setMenuOpen(false)}
                        className="fixed inset-0 z-30 cursor-default"
                      />
                      <div className="absolute right-2 top-full z-40 mt-1 flex w-max flex-col items-stretch gap-1.5 rounded-lg border border-base-700 bg-base-900 p-2 shadow-2xl">
                        {timelineButton}
                        {muteButton}
                        {pinButton}
                        {fitButton}
                        {isTerminalStatus(selected.status) ? restartButton : killButton}
                        {removeButton}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  {timelineButton}
                  {muteButton}
                  {pinButton}
                  {fitButton}
                  {isTerminalStatus(selected.status) ? restartButton : killButton}
                  {removeButton}
                </>
              )}
            </>
          ) : (
            <span className="flex-1 truncate text-[12px] text-base-400">No session selected</span>
          )}
        </header>

        {actionError !== null && narrow && (
          <div className="shrink-0 border-b border-status-error/30 bg-status-error/10 px-4 py-1 text-[11px] text-status-error">
            {actionError}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {timelineOpen && selected && (
            <TimelinePanel session={selected} now={now} onClose={() => setTimelineOpen(false)} />
          )}
          <TerminalView
            sessionId={selectedId}
            dims={ptyDims}
            onSendReady={handleSendReady}
            onInputTransformReady={handleInputTransformReady}
            onFitPlanReady={handleFitPlanReady}
            onSendPromptReady={handleSendPromptReady}
          />
        </div>

        {selected && (
          <PromptComposer
            key={selected.id}
            session={selected}
            sessions={sessions}
            sendPrompt={sendPrompt}
            sendToOther={sendToOther}
          />
        )}

        <QuickActions
          session={selected}
          send={terminalSend ?? undefined}
          terminalConnected={terminalSend !== null}
        />

        {/*
          Phone keyboards have no Esc, Tab, Ctrl or arrows, which makes ⇧Tab,
          /model, arrow-key menus and Ctrl-C unreachable — i.e. read-only.
          Docked last so it sits directly above the soft keyboard.
        */}
        {(narrow || touch) && selectedId !== null && (
          <KeyBar send={terminalSend} setInputTransform={setInputTransform} />
        )}
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

      {confirm !== null && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive ?? false}
          onConfirm={() => {
            confirm.onConfirm();
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          supported={notifications.supported}
          permission={notifications.permission}
          onRequestPermission={() => void notifications.request()}
          onSendTest={notifications.sendTest}
          muted={notifications.muted}
          onChangeMuted={notifications.setMuted}
          push={push}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
