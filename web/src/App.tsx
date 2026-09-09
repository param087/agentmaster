import { useCallback, useEffect, useState } from 'react';

import { TerminalView } from './components/terminal-view';
import { api } from './lib/api';
import type { Session } from './lib/types';

const POLL_MS = 3000;

/**
 * Placeholder shell for Task 10.
 *
 * Polling is deliberate and temporary — Task 11 replaces it with the
 * `/ws/events` socket and a real sidebar. Keep this file boring.
 */
export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async (): Promise<Session[]> => {
    try {
      const next = await api.sessions();
      setSessions(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Keep the selection valid without clobbering an explicit user choice.
  useEffect(() => {
    if (sessions.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) =>
      current && sessions.some((s) => s.id === current) ? current : (sessions[0]?.id ?? null),
    );
  }, [sessions]);

  const createSession = async (): Promise<void> => {
    setCreating(true);
    try {
      // `POST /api/sessions` requires a real absolute path; only `/api/fs/ls`
      // expands `~`. Task 11's folder picker replaces this.
      const { path: home } = await api.ls('~');
      const session = await api.createSession({ harnessId: 'opencode', cwd: home });
      setSelected(session.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-base-950 text-base-100">
      <header className="flex shrink-0 items-center gap-3 border-b border-base-800 bg-base-900 px-4 py-2">
        <span className="text-sm font-semibold tracking-tight text-base-200">agentmaster</span>

        <select
          className="rounded border border-base-700 bg-base-850 px-2 py-1 text-xs text-base-100"
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          {sessions.length === 0 && <option value="">no sessions</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.harnessName} · {s.title} · {s.status}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="rounded border border-base-700 bg-base-800 px-2 py-1 text-xs text-base-100 hover:bg-base-700 disabled:opacity-50"
          disabled={creating}
          onClick={() => void createSession()}
        >
          {creating ? 'Starting…' : 'New opencode session in $HOME'}
        </button>

        {error !== null && <span className="text-xs text-status-error">{error}</span>}
      </header>

      <main className="min-h-0 flex-1">
        <TerminalView sessionId={selected} />
      </main>
    </div>
  );
}
