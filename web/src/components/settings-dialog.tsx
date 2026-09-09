import { useEffect } from 'react';
import { Bell, BellOff, Share, Smartphone } from 'lucide-react';

import { cn } from '../lib/cn';
import type { MuteSettings, NotifyKind } from '../hooks/use-notifications';
import { NOTIFY_KINDS } from '../hooks/use-notifications';
import type { UsePushResult } from '../hooks/use-push';
import { HarnessSettings } from './harness-settings';

const BUTTON =
  'self-start rounded-md border border-base-700 bg-base-800 px-3 py-1.5 text-[12px] text-base-100 ' +
  'transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

const PRIMARY_BUTTON =
  'self-start rounded-md border border-accent-dim bg-accent/15 px-3 py-1.5 text-[12px] font-medium ' +
  'text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';


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
  /** Web Push — the only mechanism that reaches a phone with the app closed. */
  push: UsePushResult;
  onClose: () => void;
}

/**
 * The iOS install path, spelled out.
 *
 * This is the single most confusing thing about Web Push on an iPhone: Safari
 * offers no prompt, no error and no hint that a tab can never subscribe, so
 * without these three lines the feature looks broken rather than unfinished.
 */
function IosInstallSteps() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-status-waiting/40 bg-status-waiting/10 p-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-status-waiting">
        <Smartphone className="size-3.5 shrink-0" />
        Add agentmaster to your Home Screen first
      </p>
      <p className="text-[11px] leading-relaxed text-base-300">
        iOS only delivers push notifications to installed apps. A Safari tab can never receive
        them, no matter what you allow.
      </p>
      <ol className="flex list-none flex-col gap-1 text-[11px] leading-relaxed text-base-200">
        <li>
          <span className="mr-1.5 text-base-500">1.</span>
          Tap <Share className="inline size-3 align-[-1px] text-base-100" /> Share in Safari&apos;s
          toolbar
        </li>
        <li>
          <span className="mr-1.5 text-base-500">2.</span>
          Choose <span className="text-base-100">Add to Home Screen</span>
        </li>
        <li>
          <span className="mr-1.5 text-base-500">3.</span>
          Open <span className="text-base-100">agentmaster</span> from your Home Screen, then come
          back here and tap Enable
        </li>
      </ol>
    </div>
  );
}

function PushSection({ push }: { push: UsePushResult }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">
        Phone notifications (push)
      </h3>

      {push.needsInstall ? (
        <IosInstallSteps />
      ) : !push.supported ? (
        <p className="text-[12px] leading-relaxed text-base-400">
          {window.isSecureContext
            ? 'This browser has no Push API, so notifications cannot reach you with the app closed.'
            : 'Push needs a secure context. Open agentmaster over HTTPS (or on localhost) to enable it.'}
        </p>
      ) : push.status?.configured === false ? (
        <p className="text-[12px] leading-relaxed text-base-400">
          The server has no VAPID keys configured, so no device can subscribe.
        </p>
      ) : push.subscribed ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[12px] text-base-300">
            <Bell className="size-3.5 text-status-idle" /> This device is subscribed. Alerts arrive
            even with agentmaster closed.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={push.busy}
              onClick={() => void push.sendTest()}
              className={BUTTON}
            >
              Send test push
            </button>
            <button
              type="button"
              disabled={push.busy}
              onClick={() => void push.unsubscribe()}
              className={cn(BUTTON, 'hover:border-status-error/50 hover:text-status-error')}
            >
              Disable
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] leading-relaxed text-base-400">
            Delivered by the server through your browser&apos;s push service, so a blocked session
            still reaches you when the tab — or your phone — is asleep.
          </p>
          <button
            type="button"
            disabled={push.busy}
            onClick={() => void push.subscribe()}
            className={PRIMARY_BUTTON}
          >
            Enable on this device
          </button>
        </div>
      )}

      {/* Suppressed when the iOS steps are showing: a one-tap install button
          next to "you must do this manually" is a contradiction, and on iOS the
          button cannot work anyway. */}
      {push.promptInstall !== null && !push.installed && !push.needsInstall && (
        <button
          type="button"
          onClick={() => void push.promptInstall?.()}
          className={BUTTON}
        >
          Install agentmaster as an app
        </button>
      )}

      {push.error !== null && (
        <p className="text-[11px] leading-relaxed text-status-error">{push.error}</p>
      )}

      {/*
        Without this the user has no way to tell a phone that registered from
        one that silently did not — the two look identical from the phone.
      */}
      {push.status !== null && (
        <p className="text-[11px] text-base-500">
          Server is pushing to{' '}
          <span className="tabular-nums text-base-300">{push.status.subscriptions}</span>{' '}
          device{push.status.subscriptions === 1 ? '' : 's'}.{' '}
          <button
            type="button"
            onClick={() => void push.refreshStatus()}
            className="rounded text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Refresh
          </button>
        </p>
      )}
    </section>
  );
}

export function SettingsDialog({
  supported,
  permission,
  onRequestPermission,
  onSendTest,
  muted,
  onChangeMuted,
  push,
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-base-950/70 p-4 pt-[6vh] backdrop-blur-sm sm:p-6 sm:pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[88vh] w-full max-w-md flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl border border-base-700 bg-base-900 p-5 shadow-2xl shadow-black/60"
      >
        <h2 className="text-sm font-semibold tracking-tight text-base-100">Settings</h2>

        <PushSection push={push} />

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">
            Desktop notifications (this tab)
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
            These only arrive while this tab is open. For a phone, or a closed laptop lid, use push
            above.
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

        <HarnessSettings />

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
