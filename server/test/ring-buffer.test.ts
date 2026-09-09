import { describe, expect, it } from 'vitest';

import { RingBuffer } from '../src/session/ring-buffer';

describe('RingBuffer', () => {
  it('holds content that fits under capacity', () => {
    const rb = new RingBuffer(100);
    rb.push(Buffer.from('hi'));

    expect(rb.read().toString()).toBe('hi');
    expect(rb.length).toBe(2);
    expect(rb.capacity).toBe(100);
  });

  it('holds content that lands exactly at capacity', () => {
    const rb = new RingBuffer(5);
    rb.push(Buffer.from('abcde'));

    expect(rb.read().toString()).toBe('abcde');
    expect(rb.length).toBe(5);
  });

  it('drops the oldest bytes when overflowing across two pushes', () => {
    const rb = new RingBuffer(10);
    rb.push(Buffer.from('abcdefgh'));
    rb.push(Buffer.from('ijkl'));

    expect(rb.read().toString()).toBe('cdefghijkl');
    expect(rb.length).toBe(10);
  });

  it('keeps only the trailing bytes of a single oversized push', () => {
    const rb = new RingBuffer(4);
    rb.push(Buffer.from('abcdefg'));

    expect(rb.read().toString()).toBe('defg');
    expect(rb.length).toBe(4);
  });

  it('survives repeated wrapping with tiny chunks', () => {
    const rb = new RingBuffer(8);
    const written: number[] = [];
    for (let i = 0; i < 50; i++) {
      written.push(i);
      rb.push(Buffer.from([i]));
    }

    expect(rb.length).toBe(8);
    expect([...rb.read()]).toEqual(written.slice(-8));
  });

  it('read() is idempotent and does not mutate state', () => {
    const rb = new RingBuffer(6);
    rb.push(Buffer.from('abcdefghij'));

    const first = rb.read();
    const second = rb.read();

    expect(first).toEqual(second);
    expect(first.toString()).toBe('efghij');
    expect(rb.length).toBe(6);
  });

  it('mutating a read() result does not corrupt the buffer', () => {
    const rb = new RingBuffer(4);
    rb.push(Buffer.from('abcd'));

    const copy = rb.read();
    copy.fill(0);

    expect(rb.read().toString()).toBe('abcd');
  });

  it('treats an empty push as a no-op', () => {
    const rb = new RingBuffer(4);
    rb.push(Buffer.from('ab'));
    rb.push(Buffer.alloc(0));

    expect(rb.read().toString()).toBe('ab');
    expect(rb.length).toBe(2);
  });

  it('returns a zero-length buffer when empty', () => {
    const rb = new RingBuffer(16);

    expect(rb.length).toBe(0);
    expect(rb.read()).toHaveLength(0);
  });

  it('clear() resets length and contents', () => {
    const rb = new RingBuffer(8);
    rb.push(Buffer.from('abcdefghij'));
    rb.clear();

    expect(rb.length).toBe(0);
    expect(rb.read()).toHaveLength(0);

    rb.push(Buffer.from('xy'));
    expect(rb.read().toString()).toBe('xy');
  });

  it('is binary safe across a wrap', () => {
    const rb = new RingBuffer(6);
    rb.push(Buffer.from([0x41, 0x42, 0x43, 0x44]));
    rb.push(Buffer.from([0x00, 0x1b, 0xff, 0x0a]));

    expect([...rb.read()]).toEqual([0x43, 0x44, 0x00, 0x1b, 0xff, 0x0a]);
  });

  it('supports a capacity of zero', () => {
    const rb = new RingBuffer(0);
    rb.push(Buffer.from('abc'));

    expect(rb.capacity).toBe(0);
    expect(rb.length).toBe(0);
    expect(rb.read()).toHaveLength(0);
  });

  it('throws RangeError on negative capacity', () => {
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
  });

  it('throws RangeError on non-integer capacity', () => {
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});
