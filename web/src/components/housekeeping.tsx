import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';

const OPTIONS: { label: string; hours: number | null }[] = [
  { label: 'Never', hours: null },
  { label: 'After 1 hour', hours: 1 },
  { label: 'After 6 hours', hours: 6 },
  { label: 'After 1 day', hours: 24 },
  { label: 'After 1 week', hours: 24 * 7 },
];

/** Auto-forgetting stopped sessions. Off by default: deleting history silently is worse than a long list. */
export function Housekeeping() {
  const [hours, setHours] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.generalSettings().then(
      (settings) => {
        if (!cancelled) setHours(settings.pruneAfterHours);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (hours === undefined) return error === null ? null : <p className="text-[11px] text-status-error">{error}</p>;

  const known = OPTIONS.some((o) => o.hours === hours);
  return (
    <section aria-label="Housekeeping" className="flex flex-col gap-1.5">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">Housekeeping</h3>
      <label className="flex items-center justify-between gap-3 text-[12px] text-base-200">
        Forget stopped sessions
        <select
          value={String(hours)}
          onChange={(event) => {
            const next = event.target.value === 'null' ? null : Number(event.target.value);
            const previous = hours;
            setHours(next);
            setError(null);
            api.saveGeneralSettings({ pruneAfterHours: next }).catch((cause: unknown) => {
              setHours(previous);
              setError(cause instanceof ApiError ? cause.message : String(cause));
            });
          }}
          className="rounded border border-base-700 bg-base-950 px-1.5 py-1 text-base-100"
        >
          {!known && <option value={String(hours)}>After {hours} hours</option>}
          {OPTIONS.map((option) => (
            <option key={option.label} value={String(option.hours)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {error !== null && <p className="text-[11px] text-status-error">{error}</p>}
    </section>
  );
}
