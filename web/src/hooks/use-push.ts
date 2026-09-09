import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Web Push subscription lifecycle.
 *
 * This is the mechanism that makes agentmaster useful on a phone. The existing
 * `useNotifications` hook fires `new Notification()` from the page, which only
 * works while a tab is alive — true on a laptop, never true on a phone in your
 * pocket. Push goes through the service worker, so it arrives with the app shut.
 *
 * The awkward part is iOS: Safari only permits push for sites added to the Home
 * Screen (16.4+). A plain Safari tab cannot subscribe at all, and the failure is
 * silent — `Notification.requestPermission` simply is not there. So the hook
 * reports `needsInstall` and the UI must show instructions instead of a button
 * that cannot work.
 */

/** `PushSubscription.toJSON()` — exactly the body POST /api/push/subscribe wants. */
interface SubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushStatus {
  /** Whether the server has VAPID keys at all. Without them nobody can subscribe. */
  configured: boolean;
  /** How many devices the server will push to. The only proof a phone registered. */
  subscriptions: number;
}

export interface UsePushResult {
  supported: boolean;
  installed: boolean;
  /** iOS in a browser tab: push is impossible until the app is on the Home Screen. */
  needsInstall: boolean;
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  /** Server-side view, refreshed after every change. `null` until first fetched. */
  status: PushStatus | null;
  /** Non-null on Android/Chrome once `beforeinstallprompt` has fired. */
  promptInstall: (() => Promise<void>) | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  sendTest: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

/**
 * The `beforeinstallprompt` event, which TypeScript's DOM lib does not declare
 * because it is not standardised. Chrome-only; iOS never fires it, which is the
 * whole reason the manual Add to Home Screen instructions exist.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

/**
 * VAPID keys are transported as base64url text but `pushManager.subscribe`
 * wants raw bytes. Passing the string works in some browsers and throws
 * `InvalidCharacterError` in others, so always convert.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  // Backed by an explicit ArrayBuffer, not the default `ArrayBufferLike`:
  // `applicationServerKey` only accepts a non-shared BufferSource.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

/** True for iPhone/iPad, including iPadOS which reports itself as a Mac with touch. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** True when running from the Home Screen / an installed PWA window. */
function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is the iOS-only signal; everywhere else it is the
  // display-mode media query the manifest asked for.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return res;
}

export function usePush(): UsePushResult {
  const [supported] = useState(isSupported);
  const [installed, setInstalled] = useState(isInstalled);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/push/status');
      if (!res.ok) return;
      const body = (await res.json()) as PushStatus;
      if (mounted.current) setStatus(body);
    } catch {
      // The status line is informational; a dead server already shows up as
      // "Disconnected" in the sidebar, so there is nothing to add here.
    }
  }, []);

  // Recover existing state on mount, so a reload does not present "Enable" to
  // someone who is already subscribed — and then re-subscribe them into a
  // duplicate row.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled && mounted.current) setSubscribed(existing !== null);
      } catch {
        // No registration yet (first load races the worker); staying
        // "not subscribed" is the correct, actionable default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // The moment the app is launched from the Home Screen the display mode flips,
  // and the iOS install instructions must disappear.
  useEffect(() => {
    const list = window.matchMedia('(display-mode: standalone)');
    const update = (): void => setInstalled(isInstalled());
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      // Chrome would otherwise show its own mini-infobar; deferring it lets the
      // install button live where the user expects it.
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setInstallEvent(null);
      setInstalled(isInstalled());
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Independent of `supported`: on iOS in a tab `PushManager` is missing, so
  // `supported` is false — and "unsupported browser" would be the wrong, and
  // very discouraging, thing to tell someone one gesture away from it working.
  const needsInstall = isIos() && !installed;

  const subscribe = useCallback(async (): Promise<void> => {
    setError(null);
    if (!supported) {
      setError('This browser cannot receive push notifications.');
      return;
    }
    if (needsInstall) {
      // Attempting it anyway throws an opaque DOMException on iOS, which reads
      // like a bug rather than "you skipped a step".
      setError('Add agentmaster to your Home Screen first — iOS cannot push to a Safari tab.');
      return;
    }

    setBusy(true);
    try {
      // Must be inside the user gesture that called this; browsers permanently
      // remember an unprompted request as a denial.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error(
          permission === 'denied'
            ? 'Notifications are blocked for this site. Re-enable them in your browser settings.'
            : 'Notification permission was dismissed.',
        );
      }

      const keyRes = await fetch('/api/push/key');
      if (!keyRes.ok) {
        throw new Error('Server has no VAPID key configured, so push is unavailable.');
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser: a push must always result in a
        // visible notification.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await postJson('/api/push/subscribe', subscription.toJSON() as unknown as SubscriptionJson);
      if (mounted.current) setSubscribed(true);
      await refreshStatus();
    } catch (cause) {
      if (mounted.current) setError(describe(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [supported, needsInstall, refreshStatus]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        const { endpoint } = existing;
        await existing.unsubscribe();
        // Tell the server too, or it keeps pushing into a dead endpoint for ten
        // more failures before its pruner gives up.
        await postJson('/api/push/unsubscribe', { endpoint });
      }
      if (mounted.current) setSubscribed(false);
      await refreshStatus();
    } catch (cause) {
      if (mounted.current) setError(describe(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const sendTest = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await postJson('/api/push/test', {});
      const { sent, pruned } = (await res.json()) as { sent: number; pruned: number };
      if (sent === 0 && mounted.current) {
        // Distinguish "nothing registered" from "the push service rejected the
        // endpoint we had". The second is the one that looks like everything is
        // fine — the UI says subscribed, and nothing ever arrives.
        setError(
          pruned > 0
            ? 'The push service rejected this device’s subscription and it has been dropped. Disable and enable again.'
            : 'The server has no live subscriptions to push to.',
        );
      }
      await refreshStatus();
    } catch (cause) {
      if (mounted.current) setError(describe(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const promptInstall = installEvent
    ? async (): Promise<void> => {
        await installEvent.prompt();
        setInstallEvent(null);
      }
    : null;

  return {
    supported,
    installed,
    needsInstall,
    subscribed,
    busy,
    error,
    status,
    promptInstall,
    subscribe,
    unsubscribe,
    sendTest,
    refreshStatus,
  };
}
