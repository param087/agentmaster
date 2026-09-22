import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { lastLines, ScreenPreview } from '../src/components/screen-preview';

describe('ScreenPreview', () => {
  it('keeps the last lines, where the question and options are', () => {
    expect(lastLines('a\nb\nc\nd\ne', 2)).toBe('d\ne');
  });

  it('shows short previews in full with no expander', () => {
    render(<ScreenPreview preview={'Proceed?\n❯ Yes'} label="Screen of x" />);
    expect(screen.getByLabelText('Screen of x').textContent).toContain('❯ Yes');
    expect(screen.queryByText(/more lines/)).toBeNull();
  });

  it('collapses long previews and offers the rest', () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    render(<ScreenPreview preview={long} label="Screen of y" />);
    expect(screen.getByText('Show 6 more lines')).toBeTruthy();
  });
});
