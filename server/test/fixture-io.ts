import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Directory holding the newline-delimited-base64 `.cast` fixtures. */
export const FIXTURE_DIR = resolve(here, 'fixtures');

export function fixturePath(name: string): string {
  return resolve(FIXTURE_DIR, `${name}.cast`);
}

/**
 * Reads `test/fixtures/<name>.cast`: one base64-encoded PTY chunk per line.
 * Base64 so raw ANSI control bytes survive a text file byte-exact.
 */
export function loadFixture(name: string): Buffer[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Buffer.from(line, 'base64'));
}

/** Writes chunks back out in the same format. Used by `scripts/record-fixture.ts`. */
export function writeFixture(name: string, chunks: Buffer[]): void {
  const body = chunks.map((chunk) => chunk.toString('base64')).join('\n');
  writeFileSync(fixturePath(name), body.length > 0 ? `${body}\n` : '', 'utf8');
}
