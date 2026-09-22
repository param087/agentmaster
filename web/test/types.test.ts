import { describe, expect, it } from 'vitest';

import { isModalWait, TERMINAL_STATUSES } from '../src/lib/types';

describe('shared types', () => {
  it('re-exports server constants from the shared module', () => {
    expect(TERMINAL_STATUSES.has('killed')).toBe(true);
  });

  it('treats only harness-rule waits as modal', () => {
    expect(isModalWait('permission')).toBe(true);
    expect(isModalWait('turn')).toBe(false);
    expect(isModalWait(undefined)).toBe(false);
  });
});
