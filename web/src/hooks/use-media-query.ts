import { useEffect, useState } from 'react';

/**
 * The single breakpoint in the app. Below it the shell is a phone: the sidebar
 * becomes an off-canvas drawer and the virtual key bar appears. At or above it
 * the layout is exactly what it has always been.
 *
 * Kept in sync with Tailwind's `md`.
 */
export const NARROW_MAX_PX = 767;

/**
 * Subscribes to a media query.
 *
 * Server-safe-ish and StrictMode-safe: the initial value is read lazily during
 * the first render so the first paint is already correct, and the listener is
 * re-read on attach in case the query flipped between render and effect.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** True on phone-width viewports. Drives the drawer and the key bar. */
export function useIsNarrow(): boolean {
  return useMediaQuery(`(max-width: ${NARROW_MAX_PX}px)`);
}

/**
 * True when the primary pointer is a finger.
 *
 * Used to gate pinch/pan and `touch-action: none`, so a desktop mouse keeps
 * native text selection and scrolling untouched.
 */
export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
