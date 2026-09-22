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
