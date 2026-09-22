import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';
import type { HarnessInfo, NotifyKind, NotifyPrefs } from '../lib/types';

const PUSH_KIND_LABEL: Record<NotifyKind, string> = {
  waiting: 'Needs you',
  error: 'Crashed',
  done: 'Finished',
  exited: 'Exited',
  killed: 'Killed',
};
const PUSH_KINDS: NotifyKind[] = ['waiting', 'error', 'done', 'exited', 'killed'];

const DEFAULT_QUIET = { start: '22:00', end: '07:00' };

/**
 * Server-side rules: which kinds reach the phone, quiet hours, and harnesses
 * that should never notify. Saved on every change — there is no Save button to
 * forget, and each edit is a single small PUT.
 */
export function PhoneRules() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.notifyPrefs(), api.harnesses()]).then(
      ([loaded, list]) => {
        if (cancelled) return;
        setPrefs(loaded);
        setHarnesses(list.filter((h) => h.enabled || loaded.mutedHarnesses.includes(h.id)));
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (next: NotifyPrefs): void => {
    const previous = prefs;
    setPrefs(next);
    setError(null);
    api.saveNotifyPrefs(next).then(setPrefs, (cause: unknown) => {
      setPrefs(previous);
      setError(cause instanceof ApiError ? cause.message : String(cause));
    });
  };

  if (prefs === null) {
    return error === null ? null : <p className="text-[11px] text-status-error">{error}</p>;
  }

  const toggleKind = (kind: NotifyKind, on: boolean): void =>
    save({ ...prefs, pushKinds: on ? [...prefs.pushKinds, kind] : prefs.pushKinds.filter((k) => k !== kind) });
  const toggleHarness = (id: string, muted: boolean): void =>
    save({
      ...prefs,
      mutedHarnesses: muted ? [...prefs.mutedHarnesses, id] : prefs.mutedHarnesses.filter((h) => h !== id),
    });

  return (
    <section aria-label="Phone rules" className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-base-400">Phone rules</h3>

      <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
        <legend className="mb-1 text-[11px] text-base-500">Push to phone for</legend>
        {PUSH_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-1.5 text-[12px] text-base-200">
            <input
              type="checkbox"
              checked={prefs.pushKinds.includes(kind)}
              onChange={(event) => toggleKind(kind, event.target.checked)}
            />
            {PUSH_KIND_LABEL[kind]}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-base-200">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={prefs.quietHours !== null}
            onChange={(event) => save({ ...prefs, quietHours: event.target.checked ? DEFAULT_QUIET : null })}
          />
          Quiet hours
        </label>
        {prefs.quietHours !== null && (
          <>
            <input
              type="time"
              aria-label="Quiet hours start"
              value={prefs.quietHours.start}
              onChange={(event) =>
                event.target.value && save({ ...prefs, quietHours: { ...prefs.quietHours!, start: event.target.value } })
              }
              className="rounded border border-base-700 bg-base-950 px-1.5 py-0.5 text-base-100"
            />
            <span className="text-base-500">to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={prefs.quietHours.end}
              onChange={(event) =>
                event.target.value && save({ ...prefs, quietHours: { ...prefs.quietHours!, end: event.target.value } })
              }
              className="rounded border border-base-700 bg-base-950 px-1.5 py-0.5 text-base-100"
            />
          </>
        )}
      </div>

      {harnesses.length > 0 && (
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="mb-1 text-[11px] text-base-500">Never notify for (desktop or phone)</legend>
          {harnesses.map((harness) => (
            <label key={harness.id} className="flex items-center gap-1.5 text-[12px] text-base-200">
              <input
                type="checkbox"
                checked={prefs.mutedHarnesses.includes(harness.id)}
                onChange={(event) => toggleHarness(harness.id, event.target.checked)}
              />
              {harness.name}
            </label>
          ))}
        </fieldset>
      )}

      <p className="text-[11px] leading-relaxed text-base-500">
        Waiting alerts include the last lines of the screen and, where the harness offers them,
        answer buttons that reply without opening the app.
      </p>
      {error !== null && <p className="text-[11px] text-status-error">{error}</p>}
    </section>
  );
}
