import { describe, expect, it } from 'vitest';

import { focusPane, initialPanes, pruneMissing, setLayout, showSession } from '../src/lib/panes';

describe('panes', () => {
  it('shows a session in the focused pane, or focuses it where already shown', () => {
    let s = setLayout(initialPanes(1, 'a'), 2);
    expect(s.panes).toEqual(['a', null]);
    s = showSession(focusPane(s, 1), 'b');
    expect(s.panes).toEqual(['a', 'b']);
    s = showSession(s, 'a');
    expect(s).toMatchObject({ panes: ['a', 'b'], focused: 0 });
  });

  it('keeps the focused session visible when shrinking', () => {
    let s = initialPanes(4, 'a');
    s = showSession(focusPane(s, 3), 'd');
    s = setLayout(s, 1);
    expect(s).toEqual({ layout: 1, panes: ['d'], focused: 0 });
  });

  it('empties panes whose session is gone', () => {
    const s = pruneMissing({ layout: 2, panes: ['a', 'b'], focused: 1 }, new Set(['a']));
    expect(s.panes).toEqual(['a', null]);
  });

  it('ignores out-of-range focus', () => {
    const s = initialPanes(2, null);
    expect(focusPane(s, 5)).toBe(s);
  });
});
