import { useEffect, useRef } from 'react';

import { cn } from '../lib/cn';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** Styles the confirm action as dangerous and keeps focus off it. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Replaces `window.confirm`, which cannot be styled, ignores the app's theme,
 * and on iOS renders as a jarring full-width system sheet — a poor fit for a
 * tool that is now used from a phone.
 *
 * Focus starts on **Cancel**, deliberately: every use of this dialog is
 * destructive, and a stray Enter should never be the thing that deletes a
 * session's output.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    // Captured, so the terminal underneath cannot swallow Escape while the
    // dialog is up — xterm listens for keys aggressively.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-base-950/70 p-6 pt-[18vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-base-700 bg-base-900 p-5 shadow-2xl shadow-black/60"
      >
        <h2 className="text-sm font-semibold tracking-tight text-base-100">{title}</h2>
        <p className="text-[12.5px] leading-relaxed text-base-300">{body}</p>

        <div className="mt-1 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            // 40px minimum: this is reachable from a phone now.
            className="min-h-10 rounded-md border border-base-700 bg-base-850 px-3 py-1.5 text-[12px] text-base-200 transition-colors hover:border-base-600 hover:text-base-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'min-h-10 rounded-md border px-3 py-1.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1',
              destructive
                ? 'border-status-error/50 bg-status-error/10 text-status-error hover:bg-status-error/20 focus-visible:ring-status-error'
                : 'border-base-700 bg-base-850 text-base-100 hover:border-base-600 focus-visible:ring-accent',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
