import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, X } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { classifyDiff, describeCode, type DiffLineKind } from '../lib/diff';
import type { GitStatusResponse, Session } from '../lib/types';

const LINE_STYLE: Record<DiffLineKind, string> = {
  add: 'bg-status-done/10 text-status-done',
  del: 'bg-status-error/10 text-status-error',
  hunk: 'text-accent',
  meta: 'text-base-500',
  context: 'text-base-300',
};

export interface GitPanelProps {
  session: Session;
  onClose: () => void;
}

/**
 * Read-only review of what changed in the session's folder: branch, changed
 * files, and a per-file diff. Deliberately no commit or discard — the agent
 * and your own terminal own the repository; this is for looking.
 */
export function GitPanel({ session, onClose }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const fail = (cause: unknown): void => setError(cause instanceof ApiError ? cause.message : String(cause));

  // Refetched when the sidebar summary changes, i.e. after each turn.
  const dirty = session.git?.dirty;
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.gitStatus(session.id).then((next) => {
      if (!cancelled) setStatus(next);
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [session.id, dirty, reload]);

  useEffect(() => {
    if (selected === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    api.gitDiff(session.id, selected).then((next) => {
      if (!cancelled) setDiff(next);
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [session.id, selected, reload]);

  return (
    <aside
      aria-label="Changes"
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-2xl flex-col border-l border-base-800 bg-base-900 shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b border-base-800 px-3 py-2">
        {selected !== null && (
          <button
            type="button"
            aria-label="Back to changed files"
            onClick={() => setSelected(null)}
            className="rounded p-1 text-base-400 hover:bg-base-800 hover:text-base-100"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-base-100">
          {selected ?? 'Changes'}
          {selected === null && status?.branch && (
            <span className="ml-2 font-normal text-base-400">
              on {status.branch}
              {status.ahead > 0 && ` · ${status.ahead} ahead`}
              {status.behind > 0 && ` · ${status.behind} behind`}
            </span>
          )}
        </h2>
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => setReload((n) => n + 1)}
          className="rounded p-1 text-base-400 hover:bg-base-800 hover:text-base-100"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close changes"
          onClick={onClose}
          className="rounded p-1 text-base-400 hover:bg-base-800 hover:text-base-100"
        >
          <X className="size-4" />
        </button>
      </header>

      {error !== null && <p className="p-3 text-[12px] text-status-error">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {selected === null && status !== null && !status.repo && (
          <p className="p-3 text-[12px] text-base-400">{session.cwd} is not a git repository.</p>
        )}
        {selected === null && status?.repo && status.files.length === 0 && (
          <p className="p-3 text-[12px] text-base-400">Working tree clean.</p>
        )}
        {selected === null && status?.repo && status.files.length > 0 && (
          <ul aria-label="Changed files" className="p-1">
            {status.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSelected(file.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-base-800"
                >
                  <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-base-500">
                    {describeCode(file.code)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-base-200">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected !== null && diff === null && error === null && (
          <p className="p-3 text-[12px] text-base-400">Loading…</p>
        )}
        {selected !== null && diff !== null && (
          <>
            {diff.truncated && (
              <p className="border-b border-base-800 px-3 py-1.5 text-[11px] text-status-waiting">
                Diff truncated — it is larger than 512 KB.
              </p>
            )}
            <pre aria-label="Diff" className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
              {classifyDiff(diff.diff).map((line, i) => (
                <div key={i} className={cn('px-3', LINE_STYLE[line.kind])}>
                  {line.text || ' '}
                </div>
              ))}
            </pre>
          </>
        )}
      </div>
    </aside>
  );
}
