#!/usr/bin/env node
/**
 * Headless fixture capture.
 *
 * Spawns a harness through the running server, optionally types a prompt,
 * waits, and writes every PTY byte to a .cast fixture. Unlike
 * `record-fixture.ts` this needs no interactive TTY, so it can drive real
 * harnesses into blocked states unattended.
 *
 *   npx tsx server/scripts/capture.ts <harnessId> <fixtureName> [--cwd <dir>]
 *       [--send <text>] [--wait <ms>] [--then <text>] [--print]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { ScreenModel } from '../src/status/screen-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'test', 'fixtures');
const API = process.env.API ?? 'http://127.0.0.1:7180';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const [harnessId, fixtureName] = process.argv.slice(2);
if (!harnessId || !fixtureName || harnessId.startsWith('--')) {
  console.error('usage: capture.ts <harnessId> <fixtureName> [--cwd d] [--send t] [--wait ms] [--then t]');
  process.exit(1);
}

const cwd = arg('cwd') ?? process.env.HOME ?? '/tmp';
const send = arg('send');
const then = arg('then');
const waitMs = Number(arg('wait') ?? 12000);

const res = await fetch(`${API}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ harnessId, cwd }),
});
if (!res.ok) {
  console.error('create failed', res.status, await res.text());
  process.exit(1);
}
const { session } = (await res.json()) as { session: { id: string } };
console.error(`[capture] session ${session.id} (${harnessId}) in ${cwd}`);

const chunks: Buffer[] = [];
const screen = new ScreenModel(120, 32);
const ws = new WebSocket(`${API.replace('http', 'ws')}/ws/term/${session.id}`);
ws.binaryType = 'arraybuffer';

await new Promise<void>((resolve) => ws.on('open', () => resolve()));
ws.on('message', (data: ArrayBuffer) => {
  const buf = Buffer.from(new Uint8Array(data));
  chunks.push(buf);
  void screen.write(new Uint8Array(buf));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Let the TUI paint before typing into it.
await sleep(4000);
if (send) {
  console.error(`[capture] sending: ${send}`);
  ws.send(Buffer.from(send, 'utf8'));
}
await sleep(waitMs);
if (then) {
  console.error(`[capture] sending: ${JSON.stringify(then)}`);
  ws.send(Buffer.from(then, 'utf8'));
  await sleep(waitMs);
}

mkdirSync(FIXTURES, { recursive: true });
const out = join(FIXTURES, `${fixtureName}.cast`);
writeFileSync(out, chunks.map((c) => c.toString('base64')).join('\n') + '\n');

console.error(`[capture] ${chunks.length} chunks -> ${out}`);
console.error('----- RENDERED SCREEN -----');
console.error(screen.text());
console.error('----- END -----');

ws.close();
await fetch(`${API}/api/sessions/${session.id}/remove`, { method: 'POST' });
process.exit(0);
