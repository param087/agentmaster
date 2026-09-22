import { useMemo, useRef, useState } from 'react';
import { SendHorizontal, Users } from 'lucide-react';

import type { Session } from '../lib/types';
import { cn } from '../lib/cn';
import { isTerminalStatus } from './status-dot';

export interface PromptComposerProps {
  session: Session;
  /** All sessions, for "also send to". */
  sessions: Session[];
  /** Sends to the selected session through its live terminal socket. */
  sendPrompt: ((text: string) => void) | null;
  /** Sends to another session over REST. */
  sendToOther: (id: string, text: string) => Promise<void>;
}

/** Composer height stops growing here; beyond it the textarea scrolls. */
const MAX_ROWS = 8;

/**
 * A plain text box under the terminal.
 *
 * Typing a paragraph into xterm on a phone is miserable — autocorrect and
 * dictation fight the canvas. This is a native textarea that sends the whole
 * prompt at once. Enter sends, Shift+Enter adds a line.
 */
export function PromptComposer({ session, sessions, sendPrompt, sendToOther }: PromptComposerProps) {
  const [text, setText] = useState('');
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [extraTargets, setExtraTargets] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const others = useMemo(
    () => sessions.filter((s) => s.id !== session.id && !isTerminalStatus(s.status)),
    [sessions, session.id],
  );
  const activeTargets = others.filter((s) => extraTargets.has(s.id));
  const rows = Math.min(MAX_ROWS, Math.max(1, text.split('\n').length));
  const stopped = isTerminalStatus(session.status);
  const canSend = text.trim() !== '' && sendPrompt !== null && !stopped;

  const submit = (): void => {
    if (!canSend) return;
    setError(null);
    sendPrompt(text);
    const failures = activeTargets.map((target) =>
      sendToOther(target.id, text).catch(() => target.title),
    );
    void Promise.all(failures).then((results) => {
      const failed = results.filter((r): r is string => typeof r === 'string');
      if (failed.length > 0) setError(`Not delivered to: ${failed.join(', ')}`);
    });
    setText('');
    textareaRef.current?.focus();
  };

  const toggleTarget = (id: string): void => {
    setExtraTargets((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="relative shrink-0 border-t border-base-800 bg-base-900 px-2 py-1.5">
      {error !== null && <p className="px-1 pb-1 text-[11px] text-status-error">{error}</p>}
      {activeTargets.length > 0 && (
        <p className="px-1 pb-1 text-[11px] text-base-400">
          Also sending to {activeTargets.map((t) => t.title).join(', ')}
        </p>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={textareaRef}
          value={text}
          rows={rows}
          disabled={stopped}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={stopped ? 'Session has stopped' : `Message ${session.harnessName}…`}
          aria-label="Prompt"
          className="min-h-[34px] min-w-0 flex-1 resize-none rounded-md border border-base-700 bg-base-950 px-2.5 py-1.5 text-[13px] leading-5 text-base-100 placeholder:text-base-500 focus:border-accent-dim focus:outline-none disabled:opacity-50"
        />
        {others.length > 0 && (
          <button
            type="button"
            aria-label="Also send to other sessions"
            aria-expanded={targetsOpen}
            onClick={() => setTargetsOpen((open) => !open)}
            className={cn(
              'inline-flex size-[34px] shrink-0 items-center justify-center rounded-md border transition-colors',
              activeTargets.length > 0
                ? 'border-accent-dim bg-accent/15 text-accent'
                : 'border-base-700 text-base-300 hover:text-base-100',
            )}
          >
            <Users className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Send prompt"
          disabled={!canSend}
          onClick={submit}
          className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-md bg-accent text-base-950 transition-opacity disabled:opacity-30"
        >
          <SendHorizontal className="size-4" />
        </button>
      </div>

      {targetsOpen && (
        <div
          role="group"
          aria-label="Also send to"
          className="absolute bottom-full right-2 z-30 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-base-700 bg-base-900 p-1.5 shadow-2xl"
        >
          {others.map((other) => (
            <label
              key={other.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-base-200 hover:bg-base-800"
            >
              <input
                type="checkbox"
                checked={extraTargets.has(other.id)}
                onChange={() => toggleTarget(other.id)}
              />
              <span className="min-w-0 flex-1 truncate">{other.title}</span>
              <span className="shrink-0 text-[10px] text-base-500">{other.harnessName}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
