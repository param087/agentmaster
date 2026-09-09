import webpush, { WebPushError } from 'web-push';

import type { Db, PushSubscriptionRow } from '../db/index.js';
import { getVapidKeys, getVapidSubject } from './vapid.js';

export interface PushPayload {
  /** Session id, so the service worker can deep-link and coalesce by tag. */
  id: string;
  kind: 'waiting' | 'done' | 'exited' | 'killed' | 'error';
  title: string;
  body: string;
}

export interface PushResult {
  sent: number;
  pruned: number;
}

/**
 * Consecutive failures tolerated before a subscription is dropped.
 *
 * Transient 5xx and network blips are normal, so one failure means nothing.
 * A subscription that has failed this many times in a row is, in practice,
 * never coming back.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Statuses that mean the endpoint is permanently gone, not merely unhappy. */
const DEAD_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);

/** Push services reject payloads over ~4 KB, so the JSON is kept minimal. */
const MAX_PAYLOAD_BYTES = 3500;

let configured: boolean | undefined;

/**
 * Installs the VAPID details on the shared `web-push` client, once.
 *
 * Deliberately lazy rather than at import time: importing this module must not
 * generate and write a keypair as a side effect (tests import it), and a
 * misconfigured subject should surface at send time, not crash boot.
 */
function ensureConfigured(): boolean {
  if (configured !== undefined) return configured;
  try {
    const keys = getVapidKeys();
    webpush.setVapidDetails(getVapidSubject(), keys.publicKey, keys.privateKey);
    configured = true;
  } catch (error) {
    // The message may reference the key file but never its contents.
    process.stderr.write(`[push] VAPID configuration failed: ${describe(error)}\n`);
    configured = false;
  }
  return configured;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof WebPushError) return error.statusCode;
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const code = Number((error as { statusCode: unknown }).statusCode);
    return Number.isFinite(code) ? code : undefined;
  }
  return undefined;
}

function toWebPushSubscription(row: PushSubscriptionRow): webpush.PushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

/**
 * Fans a notification out to every stored subscription.
 *
 * Never rejects and never throws: a push failure is a delivery problem, and
 * letting it propagate would take down the session status path that triggered
 * it. Everything is reported through the returned counters instead.
 */
export async function sendPush(db: Db, payload: PushPayload): Promise<PushResult> {
  const subs = db.listPushSubscriptions();
  if (subs.length === 0) return { sent: 0, pruned: 0 };
  if (!ensureConfigured()) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
    process.stderr.write(`[push] payload too large for session ${payload.id}; dropping\n`);
    return { sent: 0, pruned: 0 };
  }

  let sent = 0;
  let pruned = 0;

  const attempts = subs.map(async (row) => {
    try {
      await webpush.sendNotification(toWebPushSubscription(row), body);
      db.recordPushResult(row.endpoint, true);
      sent += 1;
    } catch (error) {
      const status = statusOf(error);

      // 404/410 is the push service telling us the endpoint no longer exists —
      // an uninstalled PWA or a revoked permission. Keeping it would mean a
      // guaranteed failure on every future notification, forever.
      if (status !== undefined && DEAD_STATUS_CODES.has(status)) {
        db.deletePushSubscription(row.endpoint);
        pruned += 1;
        return;
      }

      db.recordPushResult(row.endpoint, false);
      if (row.failures + 1 >= MAX_CONSECUTIVE_FAILURES) {
        db.deletePushSubscription(row.endpoint);
        pruned += 1;
        process.stderr.write(
          `[push] pruned endpoint after ${MAX_CONSECUTIVE_FAILURES} consecutive failures\n`,
        );
        return;
      }
      process.stderr.write(`[push] send failed (${status ?? 'no status'}): ${describe(error)}\n`);
    }
  });

  await Promise.allSettled(attempts);
  return { sent, pruned };
}

/** Test seam: forces the next send to re-read the VAPID configuration. */
export function resetPushConfig(): void {
  configured = undefined;
}
