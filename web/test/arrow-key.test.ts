import { describe, expect, it } from 'vitest';

import { arrowKey } from '../src/hooks/use-terminal';

describe('arrowKey', () => {
  it('follows the program\'s cursor-key mode', () => {
    expect(arrowKey('up', false)).toBe('\x1b[A');
    expect(arrowKey('down', false)).toBe('\x1b[B');
    expect(arrowKey('up', true)).toBe('\x1bOA');
    expect(arrowKey('down', true)).toBe('\x1bOB');
  });
});
