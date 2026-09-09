import { afterEach, describe, expect, it } from 'vitest';
import { ScreenModel } from '../src/status/screen-model.js';

let sm: ScreenModel | undefined;

function makeScreen(cols?: number, rows?: number): ScreenModel {
  sm = new ScreenModel(cols, rows);
  return sm;
}

afterEach(() => {
  sm?.dispose();
  sm = undefined;
});

describe('ScreenModel', () => {
  it('renders plain text', async () => {
    const s = makeScreen();
    await s.write('hello');
    expect(s.text()).toBe('hello');
  });

  it('applies erase-to-end-of-line semantics', async () => {
    const s = makeScreen();
    await s.write('Thinking...');
    await s.write('\r\x1b[KDo you want to proceed?');
    const out = s.text();
    expect(out).toContain('Do you want to proceed?');
    expect(out).not.toContain('Thinking');
  });

  it('erases multiple spinner frames leaving only the prompt', async () => {
    const s = makeScreen();
    for (const [frame, secs] of [['⠋', 3], ['⠙', 4], ['⠹', 5]] as const) {
      await s.write(`\r\x1b[K ${frame} Thinking… (${secs}s · esc to interrupt)`);
    }
    await s.write('\r\x1b[KDo you want to make this edit?\r\n');
    const out = s.text();
    expect(out).toContain('Do you want to make this edit?');
    expect(out).not.toContain('Thinking');
    expect(out).not.toContain('esc to interrupt');
    expect(out).toBe('Do you want to make this edit?');
  });

  it('handles newlines and tail()', async () => {
    const s = makeScreen();
    await s.write('a\r\nb\r\nc\r\n');
    expect(s.text()).toBe('a\nb\nc');
    expect(s.tail(2)).toBe('b\nc');
  });

  it('tail(n) returns everything when n exceeds available lines', async () => {
    const s = makeScreen();
    await s.write('a\r\nb\r\n');
    expect(s.tail(50)).toBe('a\nb');
  });

  it('strips SGR color codes from rendered text', async () => {
    const s = makeScreen();
    await s.write('\x1b[1;31mRED\x1b[0m');
    expect(s.text()).toBe('RED');
    expect(s.text().includes('\x1b')).toBe(false);
  });

  it('honours clear-screen and cursor-home', async () => {
    const s = makeScreen();
    await s.write('old content here\r\n');
    await s.write('\x1b[2J\x1b[H');
    await s.write('fresh');
    const out = s.text();
    expect(out).toBe('fresh');
    expect(out).not.toContain('old content');
  });

  it('renders a realistic multi-line menu in order', async () => {
    const s = makeScreen();
    await s.write(
      'Do you want to make this edit to payment.ts?\r\n❯ 1. Yes\r\n  2. Allow all\r\n  3. No\r\n',
    );
    const t = s.tail(4);
    expect(t).toBe(
      'Do you want to make this edit to payment.ts?\n❯ 1. Yes\n  2. Allow all\n  3. No',
    );
  });

  it('reset() clears the screen', async () => {
    const s = makeScreen();
    await s.write('something\r\nelse\r\n');
    expect(s.text()).not.toBe('');
    s.reset();
    expect(s.text()).toBe('');
  });

  it('accepts Uint8Array and Buffer input', async () => {
    const s = makeScreen();
    await s.write(new TextEncoder().encode('bytes ok\r\n'));
    expect(s.text()).toBe('bytes ok');
    s.reset();
    await s.write(Buffer.from('buffer ok\r\n', 'utf8'));
    expect(s.text()).toBe('buffer ok');
  });

  it('shows the last screenful for output longer than rows', async () => {
    const s = makeScreen(120, 24);
    for (let i = 1; i <= 50; i++) await s.write(`line ${i}\r\n`);
    const out = s.text();
    expect(out).toContain('line 50');
    expect(out).not.toContain('line 1\n');
    expect(out.split('\n').length).toBeLessThanOrEqual(24);
    expect(s.tail(1)).toBe('line 50');
  });
});
