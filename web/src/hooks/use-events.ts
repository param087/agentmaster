import { useEffect, useRef, useState } from 'react';

import type { ServerEvent, Session } from '../lib/types';

/** The `notify` arm of `ServerEvent`, narrowed for consumers. */
export type NotifyEvent = Extract<ServerEvent, { t: 'notify' }>;

/** A notification plus a monotonic sequence, so identical repeats still fire effects. */
export interface NotificationSignal {
  seq: number;
  event: NotifyEvent;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

const CLOSE_NORMAL = 1000;

export interface UseEventsResult {
  sessions: Session[];
  connected: boolean;
  lastNotification: NotificationSignal | null;
}

function eventsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws/events`;
}

/** Newest session first — the one just created should be at the top of the sidebar. */
function byNewest(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
}

function upsert(sessions: Session[], session: Session): Session[] {
  const index = sessions.findIndex((s) => s.id === session.id);
  if (index === -1) return byNewest([session, ...sessions]);
  const next = [...sessions];
  next[index] = session;
  return byNewest(next);
}

/** Pure reducer over the server event union, so the socket layer stays dumb. */
export function reduceEvent(sessions: Session[], event: ServerEvent): Session[] {
  switch (event.t) {
    case 'snapshot':
      return byNewest(event.sessions);
    case 'session:created':
    case 'session:updated':
      return upsert(sessions, event.session);
    case 'session:removed':
      return sessions.filter((s) => s.id !== event.id);
    case 'notify':
      return sessions;
  }
}

function parseEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 't' in parsed) return parsed as ServerEvent;
  } catch {
    // A malformed frame is a server bug, not something the UI can recover from
    // by tearing down a working socket.
  }
  return null;
}

/**
 * The app's single control-channel subscription.
 *
 * Call this once, at the root. Every component below reads sessions from props:
 * one socket means one ordering of events and therefore one consistent list.
 */
export function useEvents(): UseEventsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastNotification, setLastNotification] = useState<NotificationSignal | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    // Guards every async continuation against a teardown that already happened,
    // including StrictMode's deliberate mount/unmount/mount cycle.
    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (cancelled) return;

      const ws = new WebSocket(eventsUrl());
      socket = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        setConnected(true);
      };

      ws.onmessage = (message: MessageEvent<unknown>) => {
        if (cancelled) return;
        const event = parseEvent(message.data);
        if (!event) return;

        if (event.t === 'notify') {
          seqRef.current += 1;
          setLastNotification({ seq: seqRef.current, event });
          return;
        }
        setSessions((current) => reduceEvent(current, event));
      };

      ws.onerror = () => {
        // `onclose` always follows and is where the retry belongs.
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        if (socket === ws) socket = null;

        attempts += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      if (ws) {
        // Drop handlers first so closing cannot schedule a reconnect.
        ws.onmessage = ws.onerror = ws.onclose = null;
        if (ws.readyState === WebSocket.CONNECTING) {
          // Closing mid-handshake makes the browser log an abort warning on
          // every StrictMode double-mount; closing once open is silent.
          ws.onopen = () => ws.close(CLOSE_NORMAL);
        } else {
          ws.onopen = null;
          ws.close(CLOSE_NORMAL);
        }
      }
    };
  }, []);

  return { sessions, connected, lastNotification };
}
