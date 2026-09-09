import { useCallback, useEffect, useState } from 'react';

import { AppShell } from './components/app-shell';
import { useEvents } from './hooks/use-events';
import { useNotifications } from './hooks/use-notifications';

/**
 * Root: owns the single `/ws/events` subscription, the selected session, and
 * notification delivery. Everything below it is driven by props.
 */
export function App() {
  const { sessions, connected, lastNotification } = useEvents();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const select = useCallback((id: string): void => setSelectedId(id), []);

  // Keep the selection valid — auto-select the newest session when there is no
  // choice yet, and recover when the selected one is removed — without ever
  // overriding a deliberate pick.
  useEffect(() => {
    setSelectedId((current) => {
      if (sessions.length === 0) return null;
      if (current !== null && sessions.some((s) => s.id === current)) return current;
      return sessions[0]?.id ?? null;
    });
  }, [sessions]);

  const notifications = useNotifications(lastNotification, selectedId, select);

  return (
    <AppShell
      sessions={sessions}
      selectedId={selectedId}
      connected={connected}
      onSelect={select}
      notifications={notifications}
    />
  );
}
