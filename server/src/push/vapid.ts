import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const DEFAULT_SUBJECT = 'mailto:agentmaster@localhost';
/** Owner-read/write only: this file contains a private signing key. */
const KEY_FILE_MODE = 0o600;

/** Same directory as the SQLite db, so all local state lives in one place. */
function defaultVapidPath(): string {
  return join(homedir(), '.agentmaster', 'vapid.json');
}

function fromEnv(): VapidKeys | undefined {
  const publicKey = process.env['AGENTMASTER_VAPID_PUBLIC_KEY'];
  const privateKey = process.env['AGENTMASTER_VAPID_PRIVATE_KEY'];
  if (!publicKey || !privateKey) return undefined;
  return { publicKey, privateKey };
}

function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['publicKey'] === 'string' && typeof record['privateKey'] === 'string';
}

/**
 * Reads the keypair from disk, returning undefined if it is missing or
 * unreadable.
 *
 * A corrupt file is treated as absent rather than fatal, but the error is
 * reported without its contents — the file holds a private key, so neither the
 * parse error nor the payload may ever reach a log.
 */
function readKeys(file: string): VapidKeys | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isVapidKeys(parsed)) return undefined;
    if (!parsed.publicKey || !parsed.privateKey) return undefined;
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch {
    process.stderr.write(`[push] ${file} is unreadable or malformed; regenerating\n`);
    return undefined;
  }
}

function writeKeys(file: string, keys: VapidKeys): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: KEY_FILE_MODE });
}

let cached: VapidKeys | undefined;

/**
 * The process-wide VAPID keypair, generated once and reused forever.
 *
 * Regenerating invalidates every subscription every browser has ever stored, so
 * the keypair is persisted on first use and only ever read afterwards.
 *
 * `path` exists for tests; production always uses `~/.agentmaster/vapid.json`.
 */
export function getVapidKeys(path?: string): VapidKeys {
  const override = fromEnv();
  if (override) return override;

  if (path === undefined && cached) return cached;

  const file = path ?? defaultVapidPath();
  const existing = readKeys(file);
  if (existing) {
    if (path === undefined) cached = existing;
    return existing;
  }

  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  writeKeys(file, keys);
  if (path === undefined) cached = keys;
  return keys;
}

/**
 * The `sub` claim in the VAPID JWT. Push services require a contact address so
 * they can reach the sender's operator; for a localhost tool nobody will, but
 * omitting it is rejected outright.
 */
export function getVapidSubject(): string {
  return process.env['AGENTMASTER_VAPID_SUBJECT'] ?? DEFAULT_SUBJECT;
}

/** Test seam: drops the in-process cache so the next call re-reads disk. */
export function resetVapidCache(): void {
  cached = undefined;
}
