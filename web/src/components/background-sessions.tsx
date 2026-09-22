import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';

/** Native confirm: this lives inside the Settings modal, where a second modal would stack badly. */
function confirmDeleteAll(running: number): boolean {
  return window.confirm(
    `Delete every session? ${running} running agent${running === 1 ? '' : 's'} will be stopped, and all output and history erased. This cannot be undone.`,
  );
}

/**
 * With the tmux backend, agents outlive the server. This says so, and offers
 * the one-click way to get rid of all of them.
 */
export function BackgroundSessions() {
  const [info, setInfo] = useState<{ backend: 'direct' | 'tmux'; running: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = (): void => {
    api.backendInfo().then(setInfo, (cause: unknown) =>
      setMessage(cause instanceof ApiError ? cause.message : String(cause)),
    );
  };
  useEffect(load, []);

  if (info === null) return message === null ? null : <p className="text-[11px] text-status-error">{message}</p>;

  const deleteAll = async (): Promise<void> => {
    if (!confirmDeleteAll(info.running)) return;
    try {
      const deleted = await api.deleteAllSessions();
      setMessage(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
      load();
    } catch (cause) {
      setMessage(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  return (
    <section aria-label="Background sessions" className="flex flex-col gap-1.5">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">Background sessions</h3>
      <p className="text-[12px] leading-relaxed text-base-300">
        {info.backend === 'tmux'
          ? `Agents run in tmux and keep running when the server restarts. ${info.running} running now.`
          : 'Agents stop when the server stops. Install tmux to keep them running across restarts.'}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void deleteAll()}
          className="rounded-md border border-status-error/40 px-2.5 py-1 text-[12px] text-status-error hover:bg-status-error/10"
        >
          Delete all sessions
        </button>
        {message !== null && <span className="text-[11px] text-base-400">{message}</span>}
      </div>
    </section>
  );
}
