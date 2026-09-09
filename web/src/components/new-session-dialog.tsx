import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import type { HarnessInfo, Session } from '../lib/types';
import { FolderPicker, rememberFolder } from './folder-picker';

export interface NewSessionDialogProps {
  onClose: () => void;
  onCreated: (session: Session) => void;
}

/**
 * Modal for spawning a harness.
 *
 * Plain React rather than a dialog library: the app has exactly two modals and
 * both need the same twenty lines of Escape / backdrop / focus handling.
 */
export function NewSessionDialog({ onClose, onCreated }: NewSessionDialogProps) {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [harnessId, setHarnessId] = useState('');
  const [cwd, setCwd] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .harnesses()
      .then((list) => {
        if (cancelled) return;
        setHarnesses(list);
        setHarnessId((current) => current || (list[0]?.id ?? ''));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  // Captured at the window so the terminal, which normally owns the keyboard,
  // cannot swallow Escape while the modal is up.
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

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!harnessId || cwd === null || submitting) return;

    setSubmitting(true);
    setError(null);
    void api
      .createSession({ harnessId, cwd, ...(title.trim() ? { title: title.trim() } : {}) })
      .then((session) => {
        rememberFolder(cwd);
        onCreated(session);
      })
      .catch((cause: unknown) => {
        // The server's message ("Unknown harness", "spawn ENOENT") is the only
        // useful thing here, so it is shown verbatim rather than replaced.
        setError(cause instanceof ApiError ? cause.message : String(cause));
        setSubmitting(false);
      });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-base-950/70 p-6 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        onSubmit={submit}
        className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-base-700 bg-base-900 p-5 shadow-2xl shadow-black/60"
      >
        <h2 className="text-sm font-semibold tracking-tight text-base-100">New session</h2>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">Harness</span>
          <select
            ref={selectRef}
            value={harnessId}
            onChange={(event) => setHarnessId(event.target.value)}
            className="rounded-md border border-base-700 bg-base-950 px-2.5 py-1.5 text-[13px] text-base-100 focus:border-accent-dim focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {harnesses.length === 0 && <option value="">Loading…</option>}
            {harnesses.map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.name} ({harness.command})
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">Folder</span>
          <FolderPicker value={cwd} onChange={setCwd} />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">
            Title <span className="normal-case tracking-normal text-base-500">(optional)</span>
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Defaults to the folder name"
            className="rounded-md border border-base-700 bg-base-950 px-2.5 py-1.5 text-[13px] text-base-100 placeholder:text-base-500 focus:border-accent-dim focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        {error !== null && (
          <p className="rounded-md border border-status-error/30 bg-status-error/10 px-2.5 py-1.5 text-[12px] text-status-error">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-base-300 transition-colors hover:bg-base-800 hover:text-base-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !harnessId || cwd === null}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent-dim bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {submitting ? 'Starting…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
