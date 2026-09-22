/**
 * ⌘ on Apple platforms, Ctrl+Shift elsewhere.
 *
 * Plain Ctrl-K and Ctrl-N are readline bindings (kill-to-end-of-line, next-line)
 * that every harness TUI expects to receive, so on non-Apple platforms the app
 * must not swallow them. ⌘ is safe because terminals never claim it.
 */
export function isPrimaryModifier(event: KeyboardEvent): boolean {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (mac) return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && event.shiftKey && !event.metaKey;
}

function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * An app shortcut: the primary modifier with no Alt, and — on Apple, where the
 * modifier is ⌘ alone — no Shift either, so ⌘⇧N stays free for the browser.
 * (Elsewhere Shift is *part of* the modifier, so it must not be rejected.)
 */
export function isAppShortcut(event: KeyboardEvent): boolean {
  if (!isPrimaryModifier(event) || event.altKey) return false;
  return !(isApple() && event.shiftKey);
}

/** 1-9 from `Digit1`…`Digit9`, layout- and Shift-independent; otherwise null. */
export function shortcutDigit(event: KeyboardEvent): number | null {
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}
