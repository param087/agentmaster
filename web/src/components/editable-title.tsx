import { useEffect, useRef, useState } from 'react';

export interface EditableTitleProps {
  title: string;
  /** Resolves when saved; a rejection keeps the editor open with the draft. */
  onRename: (title: string) => Promise<void>;
}

/**
 * The session title in the header, renamed in place.
 *
 * Click (or tap) to edit; Enter or blur saves, Escape cancels. An unchanged or
 * blank draft is a no-op rather than an error — blanking a title is almost
 * always a slip, and the server would reject it anyway.
 */
export function EditableTitle({ title, onRename }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = (): void => {
    const next = draft.trim();
    if (next === '' || next === title) {
      setEditing(false);
      return;
    }
    onRename(next).then(
      () => setEditing(false),
      () => inputRef.current?.focus(),
    );
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename session"
        className="min-w-0 truncate rounded text-left text-[13px] font-medium text-base-100 hover:underline hover:decoration-base-500 hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {title}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={120}
      aria-label="Session title"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(title);
          setEditing(false);
        }
      }}
      className="min-w-0 flex-1 rounded border border-accent-dim bg-base-950 px-1.5 py-0.5 text-[13px] font-medium text-base-100 focus:outline-none"
    />
  );
}
