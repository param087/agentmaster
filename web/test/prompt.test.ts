import { describe, expect, it } from 'vitest';

import { formatPrompt, PASTE_END, PASTE_START } from '../src/lib/prompt';

describe('formatPrompt', () => {
  it('submits a single line with Enter', () => {
    expect(formatPrompt('ls -la', true)).toBe('ls -la\r');
  });
  it('wraps multi-line text in a bracketed paste when the program supports it', () => {
    expect(formatPrompt('a\r\nb', true)).toBe(`${PASTE_START}a\nb${PASTE_END}\r`);
  });
  it('falls back to typed lines without bracketed paste', () => {
    expect(formatPrompt('a\nb', false)).toBe('a\rb\r');
  });
});

describe('sendPrompt', () => {
  it('writes the text, then Enter separately after a delay', async () => {
    const { sendPrompt, SUBMIT_DELAY_MS } = await import('../src/lib/prompt');
    const writes: Array<[string, number]> = [];
    const t0 = Date.now();
    await sendPrompt((d) => void writes.push([d, Date.now() - t0]), 'hello', true);
    expect(writes.map(([d]) => d)).toEqual(['hello', '\r']);
    expect(writes[1]![1]).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 5);
  });
});
