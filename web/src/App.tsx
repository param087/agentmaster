import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell } from './components/app-shell';
import { useEvents } from './hooks/use-events';
import { useNotifications } from './hooks/use-notifications';
import { usePush } from './hooks/use-push';

/**
 * Reads and clears `?session=<id>`.
 *
 * The service worker opens `/?session=<id>` when there is no window to focus.
 * The parameter is stripped immediately so a later reload — or the browser
 * restoring the tab tomorrow — does not yank the user back to a session they
 * dealt with long ago.
 */
function takeSessionFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('session');
  if (id === null) return null;
  params.delete('session');
  const query = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
  return id;
}

/**
 * Consumed once, at module load, deliberately *outside* React.
 *
 * Reading it during render instead would be a side effect in render: StrictMode
 * renders twice, throws the first pass away, and the second pass finds the
 * parameter already stripped — so the deep link silently did nothing and you
 * landed on whichever session happened to be first.
 */
const INITIAL_SESSION_FROM_URL = takeSessionFromUrl();

/**
 * Root: owns the single `/ws/events` subscription, the selected session, and
 * notification delivery. Everything below it is driven by props.
 */
export function App() {
  const { sessions, connected, lastNotification } = useEvents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const push = usePush();

  const select = useCallback((id: string): void => setSelectedId(id), []);

  /**
   * A session asked for by a notification, held until it actually shows up in
   * the session list. The events socket has usually not delivered anything yet
   * when a cold start opens `/?session=…`, and selecting an id that is not in
   * `sessions` would be immediately overwritten by the reconciler below.
   */
  const pendingRef = useRef<string | null>(INITIAL_SESSION_FROM_URL);

  // Keep the selection valid — auto-select the newest session when there is no
  // choice yet, and recover when the selected one is removed — without ever
  // overriding a deliberate pick.
  //
  // Consuming the pending deep link happens in the effect body, never inside the
  // updater: StrictMode invokes updaters twice to catch impurity, so clearing
  // the ref in there made the second pass miss the link and fall through to
  // "first session" — a deep link that silently opened the wrong session.
  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(null);
      return;
    }

    const pending = pendingRef.current;
    if (pending !== null && sessions.some((s) => s.id === pending)) {
      pendingRef.current = null;
      setSelectedId(pending);
      return;
    }

    setSelectedId((current) => {
      if (current !== null && sessions.some((s) => s.id === current)) return current;
      return sessions[0]?.id ?? null;
    });
  }, [sessions]);

  // The other half of the deep link: when a window was already open the service
  // worker focuses it and posts the id instead of navigating.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; id?: unknown };
      if (message.type !== 'agentmaster:select') return;
      const { id } = message;
      if (typeof id !== 'string' || id === '') return;
      // Held as pending too, so a click on a notification that arrives moments
      // before the session list does still lands on the right session.
      pendingRef.current = id;
      if (sessions.some((s) => s.id === id)) {
        pendingRef.current = null;
        setSelectedId(id);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [sessions]);

  const notifications = useNotifications(lastNotification, selectedId, select);

  return (
    <AppShell
      sessions={sessions}
      selectedId={selectedId}
      connected={connected}
      onSelect={select}
      notifications={notifications}
      push={push}
    />
  );
}
