import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import type { SearchOptions, SearchResults } from '../hooks/use-terminal';
import { cn } from '../lib/cn';

export interface TerminalSearchProps {
  results: SearchResults | null;
  onSearch: (query: string, direction: 'next' | 'previous', options: SearchOptions) => boolean;
  onClose: () => void;
}

/** Renders "3 of 12", "No results", or nothing before the first search. */
export function describeResults(query: string, results: SearchResults | null): string {
  if (query === '' || results === null) return '';
  if (results.count === 0) return 'No results';
  if (results.index < 0) return `${results.count}+ matches`;
  return `${results.index + 1} of ${results.count}`;
}

const TOGGLE =
  'rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
const ICON_BUTTON =
  'inline-flex size-7 items-center justify-center rounded text-base-300 transition-colors hover:bg-base-800 hover:text-base-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40';

/**
 * Find-in-scrollback bar.
 *
 * Incremental: every keystroke re-runs the search from the current match, the
 * way a browser's find bar behaves. Enter / ⇧Enter step through matches, Escape
 * closes and hands focus back to the terminal.
 */
export function TerminalSearch({ results, onSearch, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const options: SearchOptions = { caseSensitive, regex };

  // Re-run when the query or a toggle changes. `incremental` semantics are
  // provided by searching "next" from the current selection.
  useEffect(() => {
    onSearch(query, 'next', { caseSensitive, regex, incremental: true });
    // onSearch is stable (useCallback in the hook).
  }, [query, caseSensitive, regex, onSearch]);

  const step = (direction: 'next' | 'previous'): void => {
    onSearch(query, direction, options);
  };

  const summary = describeResults(query, results);

  return (
    <div
      role="search"
      className="absolute left-3 right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-base-700 bg-base-900/95 p-1 shadow-xl sm:left-auto sm:w-[380px]"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? 'previous' : 'next');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[13px] text-base-100 placeholder:text-base-500 focus:outline-none"
      />
      <span aria-live="polite" className="shrink-0 px-1 text-[11px] tabular-nums text-base-400">
        {summary}
      </span>
      <button
        type="button"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => setCaseSensitive((v) => !v)}
        className={cn(TOGGLE, caseSensitive ? 'bg-accent/20 text-accent' : 'text-base-400 hover:text-base-100')}
      >
        Aa
      </button>
      <button
        type="button"
        aria-pressed={regex}
        title="Regular expression"
        onClick={() => setRegex((v) => !v)}
        className={cn(TOGGLE, regex ? 'bg-accent/20 text-accent' : 'text-base-400 hover:text-base-100')}
      >
        .*
      </button>
      <button
        type="button"
        aria-label="Previous match"
        disabled={query === ''}
        onClick={() => step('previous')}
        className={ICON_BUTTON}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        disabled={query === ''}
        onClick={() => step('next')}
        className={ICON_BUTTON}
      >
        <ChevronDown className="size-4" />
      </button>
      <button type="button" aria-label="Close search" onClick={onClose} className={ICON_BUTTON}>
        <X className="size-4" />
      </button>
    </div>
  );
}
