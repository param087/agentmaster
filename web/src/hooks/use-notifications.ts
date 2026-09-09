import { useCallback, useEffect, useRef, useState } from 'react';

import type { NotificationSignal } from './use-events';

/**
 * The kinds the user can mute.
 *
 * `killed` is deliberately absent: the server never emits it, because you are
 * the one who pressed Kill. A toggle for it would be a switch wired to nothing.
 */
export type NotifyKind = 'waiting' | 'done' | 'exited' | 'error';

export type MuteSettings = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: readonly NotifyKind[] = ['waiting', 'done', 'exited', 'error'];

/**
 * v2 of the mutes key.
 *
 * The v1 key is **not** migrated. Real installs accumulated
 * `{"waiting":false,"done":true,"error":true}` during testing, which silently
 * muted two thirds of the alerts this tool exists to deliver. Carrying that
 * forward would preserve the bug, so v1 is deleted and everyone starts from
 * "nothing muted".
 */
const MUTES_KEY = 'agentmaster.mutes.v2';

/** Discarded on sight, never read. See `MUTES_KEY`. */
const LEGACY_MUTES_KEY = 'agentmaster.mutes';

/** Nothing is muted by default: the tool is useless if it stays quiet. */
export const DEFAULT_MUTES: MuteSettings = {
  waiting: false,
  done: false,
  exited: false,
  error: false,
};

/**
 * Reads persisted v2 mutes.
 *
 * Anything unrecognised or malformed falls back to the default for that kind
 * rather than throwing — a stale value in storage must never break the app on
 * boot, and the default is always the noisier, safer direction.
 */
export function parseMutes(parsed: unknown): MuteSettings {
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_MUTES };
  const record = parsed as Record<string, unknown>;
  const out = { ...DEFAULT_MUTES };
  for (const kind of NOTIFY_KINDS) {
    const value = record[kind];
    if (typeof value === 'boolean') out[kind] = value;
  }
  return out;
}

function readMutes(): MuteSettings {
  try {
    const raw = window.localStorage.getItem(MUTES_KEY);
    if (raw === null) return { ...DEFAULT_MUTES };
    return parseMutes(JSON.parse(raw));
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
  /**
   * Fires a real notification immediately, bypassing mutes and the active-session
   * rule. The only way to prove end-to-end delivery — permission can read
   * `granted` while the OS still swallows everything (Do Not Disturb, focus
   * modes, a per-app switch in System Settings).
   */
  sendTest: () => void;
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

  // Drop the v1 key on mount and write the v2 shape, so a polluted legacy value
  // cannot be resurrected by an older build and nobody stays silently deaf.
  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_MUTES_KEY);
      window.localStorage.setItem(MUTES_KEY, JSON.stringify(mutedRef.current));
    } catch {
      // Storage failures cost the user their preference on reload, nothing more.
    }
  }, []);

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
    // `killed` has no mute toggle and the server never sends it; if one ever
    // arrives, it is not something the user asked to be told about.
    if (event.kind === 'killed') return;
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

  const sendTest = useCallback((): void => {
    if (!supported() || Notification.permission !== 'granted') return;
    const notification = new Notification('agentmaster test', {
      body: 'Notifications are working. This is what a blocked session looks like.',
      tag: 'agentmaster.test',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }, []);

  return { supported: supported(), permission, request, muted, setMuted, sendTest };
}
