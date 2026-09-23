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

/**
 * Delay between the prompt text and the Enter that submits it.
 *
 * Measured against Claude Code 2.1: text and CR arriving in one write are read
 * as a paste, and the CR is kept as a literal newline instead of submitting.
 * A short gap makes the Enter a separate keypress, as it is when typed.
 */
export const SUBMIT_DELAY_MS = 100;

/** The prompt split into what to type and the Enter that submits it. */
export function promptParts(text: string, bracketedPaste: boolean): { body: string; submit: string } {
  const full = formatPrompt(text, bracketedPaste);
  return { body: full.slice(0, -1), submit: '\r' };
}

/** Types the prompt, then presses Enter as a separate write after {@link SUBMIT_DELAY_MS}. */
export function sendPrompt(
  write: (data: string) => void | Promise<unknown>,
  text: string,
  bracketedPaste: boolean,
): Promise<void> {
  const { body, submit } = promptParts(text, bracketedPaste);
  return Promise.resolve(write(body))
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS)))
    .then(() => write(submit))
    .then(() => undefined);
}
