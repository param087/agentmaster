/** Bracketed-paste delimiters (DECSET 2004). */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * Turns composer text into the bytes a user would have produced.
 *
 * Multi-line text is sent as a bracketed paste when the program has asked for
 * it, so an agent CLI receives one message instead of submitting at the first
 * newline. Programs that never enabled bracketed paste get plain lines, exactly
 * as if typed. Either way a final Enter submits.
 */
export function formatPrompt(text: string, bracketedPaste: boolean): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.includes('\n')) return `${normalized}\r`;
  if (bracketedPaste) return `${PASTE_START}${normalized}${PASTE_END}\r`;
  return `${normalized.split('\n').join('\r')}\r`;
}
