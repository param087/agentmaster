import { useCallback, useEffect, useRef, useState } from 'react';

import type { NotificationSignal } from './use-events';

export type NotifyKind = 'waiting' | 'finished' | 'exited' | 'error';

export type MuteSettings = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: readonly NotifyKind[] = ['waiting', 'finished', 'exited', 'error'];

const MUTES_KEY = 'agentmaster.mutes';

/** Nothing is muted by default: the tool is useless if it stays quiet. */
export const DEFAULT_MUTES: MuteSettings = {
  waiting: false,
  finished: false,
  exited: false,
  error: false,
};

function readMutes(): MuteSettings {
  try {
    const raw = window.localStorage.getItem(MUTES_KEY);
    if (raw === null) return { ...DEFAULT_MUTES };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_MUTES };
    const record = parsed as Partial<Record<NotifyKind, unknown>>;
    const out = { ...DEFAULT_MUTES };
    for (const kind of NOTIFY_KINDS) {
      const value = record[kind];
      if (typeof value === 'boolean') out[kind] = value;
    }
    return out;
  } catch {
    return { ...DEFAULT_MUTES };
  }
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export interface UseNotificationsResult {
  supported: boolean;
  permission: NotificationPermission;
  request: () => Promise<void>;
  muted: MuteSettings;
  setMuted: (mutes: MuteSettings) => void;
}

/**
 * Turns server `notify` events into OS notifications.
 *
 * The server already decides *whether* something is notify-worthy and applies
 * the per-(session, kind) cooldown; this hook only applies the two things the
 * browser knows: the user's mute settings and whether they are already looking
 * at that session.
 */
export function useNotifications(
  lastNotification: NotificationSignal | null,
  activeSessionId: string | null,
  onNotificationClick: (sessionId: string) => void,
): UseNotificationsResult {
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported() ? Notification.permission : 'denied',
  );
  const [muted, setMutedState] = useState<MuteSettings>(readMutes);

  // Read through refs so the delivery effect depends only on the signal —
  // switching sessions must not re-fire the previous notification.
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const clickRef = useRef(onNotificationClick);
  clickRef.current = onNotificationClick;
  const permissionRef = useRef(permission);
  permissionRef.current = permission;

  const setMuted = useCallback((next: MuteSettings): void => {
    setMutedState(next);
    try {
      window.localStorage.setItem(MUTES_KEY, JSON.stringify(next));
    } catch {
      // Storage failures cost the user their preference on reload, nothing more.
    }
  }, []);

  /**
   * Only ever called from an explicit click. Browsers reject (and permanently
   * remember) unprompted permission requests on page load.
   */
  const request = useCallback(async (): Promise<void> => {
    if (!supported()) return;
    setPermission(await Notification.requestPermission());
  }, []);

  useEffect(() => {
    if (lastNotification === null) return;
    if (!supported() || permissionRef.current !== 'granted') return;

    const { event } = lastNotification;
    if (mutedRef.current[event.kind]) return;

    // Never interrupt someone about the session already on their screen.
    if (!document.hidden && event.id === activeRef.current) return;

    // `tag` lets the OS collapse repeats for the same session for us.
    const notification = new Notification(event.title, { body: event.body, tag: event.id });
    notification.onclick = () => {
      window.focus();
      clickRef.current(event.id);
      notification.close();
    };
  }, [lastNotification]);

  return { supported: supported(), permission, request, muted, setMuted };
}
