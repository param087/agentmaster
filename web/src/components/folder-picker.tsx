import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, Clock, Folder, Loader2 } from 'lucide-react';

import { api, ApiError, type LsResult } from '../lib/api';
import { cn } from '../lib/cn';

const RECENT_KEY = 'agentmaster.recentFolders';
const MAX_RECENT = 8;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT);
  } catch {
    // Corrupt or unavailable storage must not stop the user creating a session.
    return [];
  }
}

/** Most-recent-first, de-duplicated, capped. Exported so the dialog can record a pick. */
export function rememberFolder(path: string): void {
  try {
    const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, MAX_RECENT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures are not worth surfacing.
  }
}

/** Path split into `{label, path}` crumbs, rooted at `/`. */
function crumbs(path: string): { label: string; path: string }[] {
  const segments = path.split('/').filter(Boolean);
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const segment of segments) {
    acc += `/${segment}`;
    out.push({ label: segment, path: acc });
  }
  return out;
}

export interface FolderPickerProps {
  /** The currently chosen absolute path, or `null` before the first listing lands. */
  value: string | null;
  onChange: (path: string) => void;
}

/**
 * Directory browser over `/api/fs/ls`.
 *
 * Navigating *is* selecting: the current directory is the chosen one, which
 * matches how you actually pick a project folder — you cd into it.
 */
export function FolderPicker({ value, onChange }: FolderPickerProps) {
  const [listing, setListing] = useState<LsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent] = useState<string[]>(() => readRecent());

  // Held in a ref so an inline `onChange` from the parent cannot re-trigger the
  // initial listing effect on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const browse = useCallback((path: string | undefined): void => {
    setLoading(true);
    void api
      .ls(path)
      .then((result) => {
        setListing(result);
        setError(null);
        onChangeRef.current(result.path);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => setLoading(false));
  }, []);

  // `~` is expanded server-side; the browser never needs to know the home path.
  useEffect(() => browse('~'), [browse]);

  const trail = listing ? crumbs(listing.path) : [];
  const parent = listing?.parent ?? null;

  return (
    <div className="flex flex-col gap-2">
      {recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Clock className="size-3 shrink-0 text-base-500" aria-hidden />
          {recent.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => browse(path)}
              title={path}
              className={cn(
                'max-w-[140px] truncate rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                value === path
                  ? 'border-accent-dim bg-accent/10 text-accent'
                  : 'border-base-700 bg-base-850 text-base-300 hover:border-base-600 hover:text-base-100',
              )}
            >
              {path.slice(path.lastIndexOf('/') + 1) || path}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-md border border-base-700 bg-base-950 px-2 py-1.5 text-[11px]">
        {trail.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {index > 0 && <span className="text-base-600">/</span>}
            <button
              type="button"
              onClick={() => browse(crumb.path)}
              className="rounded px-0.5 text-base-300 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {crumb.label}
            </button>
          </span>
        ))}
        {loading && <Loader2 className="ml-1 size-3 animate-spin text-base-500" aria-label="Loading" />}
      </div>

      <div className="h-48 overflow-y-auto rounded-md border border-base-700 bg-base-950 p-1">
        {parent !== null && (
          <button
            type="button"
            onClick={() => browse(parent)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-base-300 transition-colors hover:bg-base-850 hover:text-base-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <ChevronUp className="size-3.5 shrink-0 text-base-500" />
            Parent
          </button>
        )}

        {listing?.dirs.map((dir) => (
          <button
            key={dir.path}
            type="button"
            onClick={() => browse(dir.path)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-base-200 transition-colors hover:bg-base-850 hover:text-base-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <Folder className="size-3.5 shrink-0 text-base-500" />
            <span className="truncate">{dir.name}</span>
          </button>
        ))}

        {listing !== null && listing.dirs.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-base-500">No sub-folders here.</p>
        )}
      </div>

      {error !== null && <p className="text-[11px] text-status-error">{error}</p>}

      <p className="truncate text-[11px] text-base-400" title={value ?? undefined}>
        Will start in <span className="text-base-200">{value ?? '…'}</span>
      </p>
    </div>
  );
}
