import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, X } from 'lucide-react';

import { api, ApiError, type Preset } from '../lib/api';
import type { HarnessInfo, Session } from '../lib/types';
import { FolderPicker, rememberFolder } from './folder-picker';
import { HarnessSelect } from './harness-select';

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
  const [prompt, setPrompt] = useState('');
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Suppresses the dialog's own Escape handling while a nested popup owns it.
  // A ref, not state: the window keydown listener must see the current value
  // immediately, or a second Escape in the same frame is dropped.
  const popupOpenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .harnesses()
      .then((list) => {
        if (cancelled) return;
        // Only enabled harnesses are offered; the full list lives in Settings.
        const usable = list.filter((h) => h.enabled);
        setHarnesses(usable);
        setHarnessId((current) => current || (usable[0]?.id ?? ''));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void api
      .presets()
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch(() => {
        // Presets are a shortcut; the dialog works fine without them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (cause: unknown): void => {
    setError(cause instanceof ApiError ? cause.message : String(cause));
    setSubmitting(false);
  };

  const launch = (preset: Preset): void => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    void api.launchPreset(preset.id).then(onCreated, fail);
  };

  const removePreset = (preset: Preset): void => {
    void api
      .deletePreset(preset.id)
      .then(() => setPresets((list) => list.filter((p) => p.id !== preset.id)), fail);
  };

  // Captured at the window so the terminal, which normally owns the keyboard,
  // cannot swallow Escape while the modal is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The harness listbox closes itself first; one Escape should not dismiss
      // both it and the dialog.
      if (popupOpenRef.current) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!harnessId || cwd === null || submitting) return;

    const name = title.trim();
    if (saveAsPreset && name === '') {
      setError('Give the preset a name in the Title field.');
      return;
    }
    const firstPrompt = prompt.trim() ? prompt : undefined;

    setSubmitting(true);
    setError(null);
    // Saved first, so a spawn failure does not lose the preset the user asked for.
    const saved = saveAsPreset
      ? api.savePreset({ name, harnessId, cwd, ...(firstPrompt ? { prompt: firstPrompt } : {}) })
      : Promise.resolve(null);
    void saved
      .then(() =>
        api.createSession({
          harnessId,
          cwd,
          ...(name ? { title: name } : {}),
          ...(firstPrompt ? { initialPrompt: firstPrompt } : {}),
        }),
      )
      .then((session) => {
        rememberFolder(cwd);
        onCreated(session);
      })
      // The server's message ("Unknown harness", "spawn ENOENT") is the only
      // useful thing here, so it is shown verbatim rather than replaced.
      .catch(fail);
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

        {presets.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">Presets</span>
            <ul aria-label="Presets" className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <li
                  key={preset.id}
                  className="inline-flex items-center rounded-md border border-base-700 bg-base-850 text-[12px] text-base-200"
                >
                  <button
                    type="button"
                    onClick={() => launch(preset)}
                    aria-label={`Start preset ${preset.name}`}
                    title={`${preset.cwd}${preset.prompt ? `\n${preset.prompt}` : ''}`}
                    className="inline-flex items-center gap-1 rounded-l-md px-2 py-1 hover:bg-base-800 hover:text-accent"
                  >
                    <Play className="size-3" />
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete preset ${preset.name}`}
                    onClick={() => removePreset(preset)}
                    className="rounded-r-md px-1.5 py-1 text-base-500 hover:bg-base-800 hover:text-status-error"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">Harness</span>
          <HarnessSelect
            harnesses={harnesses}
            value={harnessId}
            onChange={setHarnessId}
            loading={loading}
            onOpenChange={(v) => {
              popupOpenRef.current = v;
            }}
          />
          {!loading && harnesses.length === 0 && (
            <p className="text-[11px] text-base-400">
              Every harness is disabled. Turn one on in Settings.
            </p>
          )}
        </div>

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

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-base-400">
            First prompt <span className="normal-case tracking-normal text-base-500">(optional)</span>
          </span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            placeholder="Typed in as soon as the harness is ready"
            className="resize-y rounded-md border border-base-700 bg-base-950 px-2.5 py-1.5 text-[13px] text-base-100 placeholder:text-base-500 focus:border-accent-dim focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <label className="flex items-center gap-2 text-[12px] text-base-300">
          <input
            type="checkbox"
            checked={saveAsPreset}
            onChange={(event) => setSaveAsPreset(event.target.checked)}
          />
          Save as preset (uses the title as its name)
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
