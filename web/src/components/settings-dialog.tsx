import { useEffect } from 'react';
import { Bell, BellOff } from 'lucide-react';

import { cn } from '../lib/cn';
import type { MuteSettings, NotifyKind } from '../hooks/use-notifications';
import { NOTIFY_KINDS } from '../hooks/use-notifications';

const KIND_COPY: Record<NotifyKind, { label: string; hint: string }> = {
  waiting: {
    label: 'Waiting for input',
    hint: 'A session is blocked on you and will wait forever. Recommended on.',
  },
  done: { label: 'Done', hint: 'A long run finished. Opening the session clears it.' },
  exited: { label: 'Exited', hint: 'The harness process ended cleanly.' },
  error: { label: 'Error', hint: 'The harness exited with a non-zero code.' },
};

export interface SettingsDialogProps {
  supported: boolean;
  permission: NotificationPermission;
  onRequestPermission: () => void;
  /** Fires a real notification, so delivery can be proven rather than assumed. */
  onSendTest: () => void;
  muted: MuteSettings;
  onChangeMuted: (mutes: MuteSettings) => void;
  onClose: () => void;
}

export function SettingsDialog({
  supported,
  permission,
  onRequestPermission,
  onSendTest,
  muted,
  onChangeMuted,
  onClose,
}: SettingsDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-base-950/70 p-6 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-base-700 bg-base-900 p-5 shadow-2xl shadow-black/60"
      >
        <h2 className="text-sm font-semibold tracking-tight text-base-100">Settings</h2>

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">
            Desktop notifications
          </h3>

          {!supported ? (
            <p className="text-[12px] text-base-400">
              This browser does not support the Notification API.
            </p>
          ) : permission === 'granted' ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-[12px] text-base-300">
                <Bell className="size-3.5 text-status-idle" /> Enabled.
              </p>
              <button
                type="button"
                onClick={onSendTest}
                className="self-start rounded-md border border-base-700 bg-base-800 px-3 py-1.5 text-[12px] text-base-100 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                Send test notification
              </button>
              {/* Permission can read `granted` while the OS still swallows
                  everything — Do Not Disturb, a focus mode, or a per-app switch
                  in System Settings. Only a real notification proves delivery. */}
              <p className="text-[11px] leading-relaxed text-base-500">
                If nothing appears, your OS is blocking it: check Do Not Disturb / Focus, and that
                your browser is allowed to notify in system settings.
              </p>
            </div>
          ) : permission === 'denied' ? (
            <div className="flex items-start gap-1.5 text-[12px] text-status-error">
              <BellOff className="mt-0.5 size-3.5 shrink-0" />
              {/* JS cannot re-request once denied — `requestPermission()` resolves
                  straight back to `denied` — so the only useful thing to render
                  is the click path through the browser's own UI. */}
              <p className="leading-relaxed">
                Blocked for this site. This page cannot ask again — you have to re-enable it in
                Chrome: click the <span className="text-base-200">padlock</span> (or sliders icon)
                in the address bar → <span className="text-base-200">Site settings</span> →{' '}
                <span className="text-base-200">Notifications</span> → Allow, then reload.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={onRequestPermission}
              className="self-start rounded-md border border-accent-dim bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Enable notifications
            </button>
          )}

          <p className="text-[11px] leading-relaxed text-base-500">
            Notifications only arrive while this tab is open — there is no background service
            worker. Keep agentmaster open in a window to stay notified.
          </p>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">Notify me about</h3>

          {NOTIFY_KINDS.map((kind) => {
            const copy = KIND_COPY[kind];
            const enabled = !muted[kind];
            return (
              <label
                key={kind}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-base-850"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => onChangeMuted({ ...muted, [kind]: !event.target.checked })}
                  className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-[12px]',
                      kind === 'waiting' ? 'font-medium text-status-waiting' : 'text-base-200',
                    )}
                  >
                    {copy.label}
                  </span>
                  <span className="block text-[11px] leading-relaxed text-base-500">
                    {copy.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </section>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-base-700 bg-base-800 px-3 py-1.5 text-[12px] text-base-100 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
