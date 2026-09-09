import express from 'express';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/index.js';
import type { PushResult } from '../src/push/sender.js';
import { pushRouter } from '../src/routes/push.js';
import { resetVapidCache } from '../src/push/vapid.js';

let db: Db;
let server: Server | undefined;
let base = '';
let sent: unknown[] = [];

/**
 * Mounts only the push router, with the same JSON body parser and error
 * middleware shape as the real app. The sender is faked, so `/test` never
 * touches a push service.
 */
async function boot(send?: (d: Db, p: unknown) => Promise<PushResult>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/push',
    pushRouter(db, {
      send:
        send ??
        ((_d, payload) => {
          sent.push(payload);
          return Promise.resolve({ sent: 3, pruned: 1 });
        }),
    }),
  );
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  server = createServer(app);
  await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  // Keys come from the environment so no test writes ~/.agentmaster/vapid.json.
  process.env['AGENTMASTER_VAPID_PUBLIC_KEY'] = 'test-public-key';
  process.env['AGENTMASTER_VAPID_PRIVATE_KEY'] = 'test-private-key';
  resetVapidCache();
  db = openDb(':memory:');
  sent = [];
});

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  db.close();
  delete process.env['AGENTMASTER_VAPID_PUBLIC_KEY'];
  delete process.env['AGENTMASTER_VAPID_PRIVATE_KEY'];
  resetVapidCache();
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validSub = {
  endpoint: 'https://push.example.com/abc',
  expirationTime: null,
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

describe('GET /api/push/key', () => {
  it('returns the public key and nothing else', async () => {
    await boot();
    const res = await fetch(`${base}/api/push/key`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ publicKey: 'test-public-key' });
    // The private half must never cross the wire.
    expect(JSON.stringify(body)).not.toContain('test-private-key');
  });
});

describe('POST /api/push/subscribe', () => {
  it('accepts PushSubscription.toJSON() verbatim and stores it', async () => {
    await boot();
    const res = await post('/api/push/subscribe', validSub);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = db.listPushSubscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(validSub.endpoint);
    expect(rows[0]?.p256dh).toBe('p256dh-value');
    expect(rows[0]?.auth).toBe('auth-value');
    expect(rows[0]?.userAgent).toBeTruthy();
  });

  it('is idempotent: subscribing twice keeps one row', async () => {
    await boot();
    await post('/api/push/subscribe', validSub);
    await post('/api/push/subscribe', validSub);
    expect(db.listPushSubscriptions()).toHaveLength(1);
  });

  it.each([
    ['missing keys', { endpoint: 'https://push.example.com/a' }],
    ['missing auth', { endpoint: 'https://push.example.com/a', keys: { p256dh: 'x' } }],
    ['empty p256dh', { endpoint: 'https://push.example.com/a', keys: { p256dh: '', auth: 'y' } }],
    ['non-url endpoint', { endpoint: 'nope', keys: { p256dh: 'x', auth: 'y' } }],
    ['empty body', {}],
  ])('400s on %s, never 500', async (_label, body) => {
    await boot();
    const res = await post('/api/push/subscribe', body);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(db.listPushSubscriptions()).toEqual([]);
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('204s and removes the row', async () => {
    await boot();
    await post('/api/push/subscribe', validSub);
    const res = await post('/api/push/unsubscribe', { endpoint: validSub.endpoint });
    expect(res.status).toBe(204);
    expect(db.listPushSubscriptions()).toEqual([]);
  });

  it('204s for an unknown endpoint — unsubscribing is idempotent', async () => {
    await boot();
    const res = await post('/api/push/unsubscribe', { endpoint: 'https://nope/x' });
    expect(res.status).toBe(204);
  });

  it('400s without an endpoint', async () => {
    await boot();
    expect((await post('/api/push/unsubscribe', {})).status).toBe(400);
  });
});

describe('GET /api/push/status', () => {
  it('reports configured and the subscription count', async () => {
    await boot();
    expect(await (await fetch(`${base}/api/push/status`)).json()).toEqual({
      configured: true,
      subscriptions: 0,
    });

    await post('/api/push/subscribe', validSub);
    expect(await (await fetch(`${base}/api/push/status`)).json()).toEqual({
      configured: true,
      subscriptions: 1,
    });
  });
});

describe('POST /api/push/test', () => {
  it('sends through the injected sender and returns its counters', async () => {
    await boot();
    const res = await post('/api/push/test', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 3, pruned: 1 });
    expect(sent).toHaveLength(1);
  });

  it('does not 500 when the sender rejects... it reports the failure', async () => {
    await boot(() => Promise.reject(new Error('nope')));
    const res = await post('/api/push/test', {});
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toEqual({ error: 'nope' });
  });
});
