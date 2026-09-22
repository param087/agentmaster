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
