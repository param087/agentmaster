import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { describeResults, TerminalSearch } from '../src/components/terminal-search';

describe('describeResults', () => {
  it('is silent before a search', () => {
    expect(describeResults('', null)).toBe('');
    expect(describeResults('x', null)).toBe('');
  });
  it('reports misses, positions, and overflow', () => {
    expect(describeResults('x', { index: 0, count: 0 })).toBe('No results');
    expect(describeResults('x', { index: 2, count: 9 })).toBe('3 of 9');
    expect(describeResults('x', { index: -1, count: 1000 })).toBe('1000+ matches');
  });
});

describe('TerminalSearch', () => {
  it('searches incrementally, steps with Enter/Shift+Enter, closes on Escape', () => {
    const onSearch = vi.fn(() => true);
    const onClose = vi.fn();
    render(<TerminalSearch results={null} onSearch={onSearch} onClose={onClose} />);
    const input = screen.getByRole('textbox', { name: 'Find in terminal' });

    fireEvent.change(input, { target: { value: 'err' } });
    expect(onSearch).toHaveBeenLastCalledWith('err', 'next', expect.objectContaining({ incremental: true }));

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).toHaveBeenLastCalledWith('err', 'next', expect.objectContaining({ regex: false }));
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSearch).toHaveBeenLastCalledWith('err', 'previous', expect.anything());

    fireEvent.click(screen.getByTitle('Regular expression'));
    expect(onSearch).toHaveBeenLastCalledWith('err', 'next', expect.objectContaining({ regex: true }));

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
