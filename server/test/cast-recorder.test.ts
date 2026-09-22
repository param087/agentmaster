import { describe, expect, it } from 'vitest';

import { CastRecorder } from '../src/session/cast-recorder.js';

function parse(cast: string): unknown[] {
  return cast.trim().split('\n').map((line) => JSON.parse(line) as unknown);
}

describe('CastRecorder', () => {
  it('writes an asciicast v2 header and timed output/resize events', () => {
    let t = 10_000;
    const rec = new CastRecorder(1024, 120, 32, () => t);
    t += 500;
    rec.output('hello\r\n');
    t += 1250;
    rec.resize(80, 24);
    const [header, ...events] = parse(rec.toCast('demo'));
    expect(header).toEqual({ version: 2, width: 120, height: 32, timestamp: 10, title: 'demo' });
    expect(events).toEqual([
      [0.5, 'o', 'hello\r\n'],
      [1.75, 'r', '80x24'],
    ]);
  });

  it('drops the oldest events past capacity and keeps the header geometry honest', () => {
    const rec = new CastRecorder(10, 120, 32, () => 0);
    rec.resize(80, 24);
    rec.output('12345');
    rec.output('67890');
    const [header, ...events] = parse(rec.toCast());
    expect(events).toEqual([
      [0, 'o', '12345'],
      [0, 'o', '67890'],
    ]);
    expect(header).toMatchObject({ width: 80, height: 24 });
  });

  it('starts over on clear', () => {
    const rec = new CastRecorder(100, 10, 10, () => 0);
    rec.output('x');
    rec.clear();
    expect(rec.eventCount).toBe(0);
  });
});
