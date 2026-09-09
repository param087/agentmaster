import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import type { HarnessInfo } from '../lib/types';
import { cn } from '../lib/cn';
import { HarnessIcon } from './harness-icon';

export interface HarnessSelectProps {
  harnesses: HarnessInfo[];
  value: string;
  onChange: (id: string) => void;
  /** Rendered while the registry is still loading. */
  loading?: boolean;
  /**
   * Announces open state to the parent dialog.
   *
   * The dialog listens for Escape on `window` in the *capture* phase, so its
   * handler runs before anything inside it and `stopPropagation` here is too
   * late — Escape would close the whole dialog instead of just this list. The
   * parent has to know to stand down.
   */
  onOpenChange?: (open: boolean) => void;
}

/** Type-ahead window: keystrokes closer together than this build one search string. */
const TYPEAHEAD_RESET_MS = 700;

/**
 * Harness picker.
 *
 * A custom listbox rather than a native `<select>` because macOS paints select
 * popups outside the page: they ignore the app's theme entirely, so the options
 * rendered as near-white text on the system's light popup — effectively
 * invisible. A DOM listbox is styled like everything else, behaves identically
 * on every platform, and can show each harness's brand mark, which a native
 * option cannot.
 */
export function HarnessSelect({
  harnesses,
  value,
  onChange,
  loading = false,
  onOpenChange,
}: HarnessSelectProps) {
  const [open, setOpenState] = useState(false);

  /**
   * Always use this instead of the raw setter: the parent has to learn the new
   * state synchronously. Reporting it from an effect loses the race against a
   * second Escape pressed in the same frame, which the dialog would then ignore.
   */
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const listId = useId();

  const selected = harnesses.find((h) => h.id === value) ?? null;
  const selectedIndex = harnesses.findIndex((h) => h.id === value);

  const close = (restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (index: number): void => {
    const harness = harnesses[index];
    if (!harness) return;
    onChange(harness.id);
    close();
  };

  // Opening lands on the current selection rather than the top of the list.
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  // Keeps the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: 'nearest',
    });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // Closing without restoring focus: the user is on their way somewhere else.
      close(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (harnesses.length === 0) return;

    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        // Must not bubble: the New Session dialog also listens for Escape at the
        // window in capture phase, and would close out from under the listbox.
        event.stopPropagation();
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % harnesses.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + harnesses.length) % harnesses.length);
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(harnesses.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(activeIndex);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        break;
    }

    if (event.key.length === 1) {
      const now = Date.now();
      const previous = now - typeahead.current.at < TYPEAHEAD_RESET_MS ? typeahead.current.text : '';
      const text = (previous + event.key).toLowerCase();
      typeahead.current = { text, at: now };

      const hit = harnesses.findIndex((h) => h.name.toLowerCase().startsWith(text));
      if (hit >= 0) setActiveIndex(hit);
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label="Harness"
        disabled={loading || harnesses.length === 0}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
        className="flex min-h-10 w-full items-center gap-2 rounded-md border border-base-700 bg-base-950 px-2.5 py-1.5 text-left text-[13px] text-base-100 transition-colors hover:border-base-600 disabled:opacity-50 focus:border-accent-dim focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {selected ? (
          <>
            <HarnessIcon harnessId={selected.id} icon={selected.icon} title={selected.name} />
            <span className="truncate">{selected.name}</span>
            <span className="truncate text-base-500">({selected.command})</span>
          </>
        ) : (
          <span className="text-base-500">{loading ? 'Loading…' : 'No harnesses enabled'}</span>
        )}
        <ChevronDown className="ml-auto size-4 shrink-0 text-base-500" aria-hidden />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Harness"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-base-700 bg-base-900 p-1 shadow-2xl shadow-black/60"
        >
          {harnesses.map((harness, index) => {
            const isSelected = harness.id === value;
            return (
              <li key={harness.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={index === activeIndex}
                  onPointerEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  className={cn(
                    'flex min-h-10 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors',
                    index === activeIndex ? 'bg-base-800 text-base-100' : 'text-base-200',
                  )}
                >
                  <HarnessIcon harnessId={harness.id} icon={harness.icon} title={harness.name} />
                  <span className="truncate">{harness.name}</span>
                  <span className="truncate text-[11px] text-base-500">{harness.command}</span>
                  {isSelected && <Check className="ml-auto size-3.5 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
