import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { sendPush, type PushResult } from '../push/sender.js';
import { getVapidKeys } from '../push/vapid.js';
import { httpError } from './sessions.js';

/**
 * Exactly the shape of `PushSubscription.toJSON()` in the browser, so the
 * client can post the subscription object through unmodified.
 *
 * `.passthrough()` is deliberate: browsers also send `expirationTime` and
 * sometimes vendor extras, and rejecting those would break subscribe for no
 * benefit.
 */
const subscribeBody = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  })
  .passthrough();

const unsubscribeBody = z.object({
  endpoint: z.string().min(1),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export interface PushRouterOptions {
  /** Injectable sender, so tests never reach a real push service. */
  send?: (db: Db, payload: Parameters<typeof sendPush>[1]) => Promise<PushResult>;
}

export function pushRouter(db: Db, opts: PushRouterOptions = {}): Router {
  const router = Router();
  const send = opts.send ?? sendPush;

  /**
   * The VAPID public key. Safe to expose by design — it is the verification
   * half of the pair, and the browser cannot subscribe without it.
   */
  router.get('/key', (_req, res, next) => {
    try {
      res.json({ publicKey: getVapidKeys().publicKey });
    } catch (error) {
      next(httpError(500, error instanceof Error ? error.message : String(error)));
    }
  });

  router.get('/status', (_req, res) => {
    let configured = false;
    try {
      configured = getVapidKeys().publicKey.length > 0;
    } catch {
      configured = false;
    }
    res.json({ configured, subscriptions: db.listPushSubscriptions().length });
  });

  router.post('/subscribe', (req, res, next) => {
    const parsed = subscribeBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, firstIssue(parsed.error)));

    const { endpoint, keys } = parsed.data;
    const userAgent = req.get('user-agent') ?? null;
    // Upsert: a browser re-subscribing after a key rotation keeps one row, and
    // its failure counter is reset because it has just proven it is alive.
    db.savePushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent });
    res.status(201).json({ ok: true });
  });

  router.post('/unsubscribe', (req, res, next) => {
    const parsed = unsubscribeBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, firstIssue(parsed.error)));

    // Idempotent: deleting an unknown endpoint is a success, not a 404.
    db.deletePushSubscription(parsed.data.endpoint);
    res.status(204).end();
  });

  /**
   * Sends a real push to every subscription.
   *
   * This is how the user confirms end-to-end delivery on a phone without
   * waiting for a session to actually block — the failure modes (permission,
   * service worker, OS focus mode) are all invisible until something arrives.
   */
  router.post('/test', (_req, res, next) => {
    void send(db, {
      id: 'test',
      kind: 'waiting',
      title: 'agentmaster',
      body: 'Test notification — push is working.',
    })
      .then((result) => {
        res.json(result);
      })
      .catch((error: unknown) => {
        next(httpError(500, error instanceof Error ? error.message : String(error)));
      });
  });

  return router;
}
