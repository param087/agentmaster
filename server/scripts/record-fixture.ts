#!/usr/bin/env tsx
/**
 * Records REAL harness output into a replayable fixture.
 *
 *   npx tsx server/scripts/record-fixture.ts <harnessId> <fixtureName>
 *
 * Spawns the harness in a PTY, mirrors it to your terminal so you can drive it
 * interactively, and appends every PTY chunk to
 * `server/test/fixtures/<fixtureName>.cast` as newline-delimited base64.
 *
 * Detach with Ctrl-] (or just let the harness exit). The fixture is then
 * replayable by `test/detection.test.ts` to verify the regexes in
 * `harnesses.yaml` against output the CLIs actually produce.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as pty from 'node-pty';

import { getHarness, loadHarnesses } from '../src/config/harnesses.js';
import { fixturePath } from '../test/fixture-io.js';

const DETACH_BYTE = 0x1d; // Ctrl-]
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [harnessId, fixtureName] = process.argv.slice(2);
if (!harnessId || !fixtureName) {
  fail('usage: npx tsx server/scripts/record-fixture.ts <harnessId> <fixtureName>');
}

const harness = getHarness(harnessId);
if (!harness) {
  const ids = loadHarnesses()
    .map((h) => h.id)
    .join(', ');
  fail(`Unknown harness "${harnessId}". Valid ids: ${ids}`);
}

const outPath = fixturePath(fixtureName);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, '', 'utf8'); // truncate any previous recording

const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' };
delete env['NODE_OPTIONS']; // tsx's loader flags must not leak into the child

const cols = process.stdout.columns ?? DEFAULT_COLS;
const rows = process.stdout.rows ?? DEFAULT_ROWS;

const child = pty.spawn(harness.command, harness.args, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: process.cwd(),
  env: env as Record<string, string>,
});

let chunks = 0;
let finished = false;

/**
 * Restores the terminal and prints the summary. Runs at most once and is
 * reachable from every exit path (child exit, detach key, signal, error) —
 * if raw mode is left on, the user's shell is broken afterwards.
 */
function finish(code: number): never {
  if (!finished) {
    finished = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // best effort: nothing useful to do if the tty is already gone
    }
    process.stdin.pause();
    process.stdout.write(`\r\n[record-fixture] wrote ${chunks} chunks to ${outPath}\r\n`);
  }
  process.exit(code);
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`\r\n[record-fixture] ${String(error)}\r\n`);
  finish(1);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    child.kill();
    finish(0);
  });
}

child.onData((data) => {
  process.stdout.write(data);
  appendFileSync(outPath, `${Buffer.from(data, 'utf8').toString('base64')}\n`, 'utf8');
  chunks += 1;
});

child.onExit(({ exitCode }) => finish(exitCode ?? 0));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf: Buffer) => {
  if (buf.includes(DETACH_BYTE)) {
    child.kill();
    finish(0);
    return;
  }
  child.write(buf.toString('utf8'));
});

process.stdout.on('resize', () => {
  child.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows);
});

process.stdout.write(
  `[record-fixture] recording ${harness.id} -> ${outPath} (Ctrl-] to detach)\r\n`,
);
