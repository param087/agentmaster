import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import type { HarnessInfo } from '../lib/types';
import { cn } from '../lib/cn';
import { HarnessIcon } from './harness-icon';

/**
 * Enable/disable which harnesses appear in the new-session picker.
 *
 * The choice lives on the server, not in `localStorage`: the dashboard is used
 * from both a laptop and a phone, and a picker that differs between them would
 * be worse than no setting at all.
 *
 * A harness nobody has toggled is enabled *iff* it is installed, so this list is
 * self-maintaining — install a CLI and it shows up, with no interaction here.
 */
export function HarnessSettings() {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .harnesses()
      .then((list) => {
        if (!cancelled) setHarnesses(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (harness: HarnessInfo): void => {
    setBusyId(harness.id);
    setError(null);
    void api
      .setHarnessEnabled(harness.id, !harness.enabled)
      .then(({ harness: updated }) => {
        setHarnesses((list) => list.map((h) => (h.id === updated.id ? updated : h)));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => setBusyId(null));
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">Harnesses</h3>
      <p className="text-[12px] leading-relaxed text-base-400">
        Which harnesses appear when you start a session. Anything installed is on by default.
      </p>

      {loading ? (
        <p className="flex items-center gap-1.5 py-2 text-[12px] text-base-400">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <ul className="rounded-md border border-base-700 bg-base-950 p-1">
          {harnesses.map((harness) => (
            <li key={harness.id}>
              <button
                type="button"
                onClick={() => toggle(harness)}
                disabled={busyId === harness.id}
                aria-pressed={harness.enabled}
                className="flex min-h-10 w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-base-850 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <HarnessIcon
                  harnessId={harness.id}
                  icon={harness.icon}
                  title={harness.name}
                  className={cn(!harness.enabled && 'opacity-40')}
                />
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      'truncate text-[12.5px]',
                      harness.enabled ? 'text-base-100' : 'text-base-400',
                    )}
                  >
                    {harness.name}
                  </span>
                  <span className="truncate text-[11px] text-base-500">
                    {harness.command}
                    {!harness.available && ' · not installed'}
                  </span>
                </span>

                {/* Switch, drawn rather than an <input>, so it matches the app. */}
                <span
                  aria-hidden
                  className={cn(
                    'ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
                    harness.enabled ? 'bg-accent/70' : 'bg-base-700',
                  )}
                >
                  <span
                    className={cn(
                      'size-4 rounded-full bg-base-100 transition-transform',
                      harness.enabled && 'translate-x-4',
                    )}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && <p className="text-[11px] text-status-error">{error}</p>}
    </section>
  );
}
