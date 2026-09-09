import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, type Db } from '../src/db/index.js';
import { sendPush } from '../src/push/sender.js';
import { getVapidKeys, getVapidSubject, resetVapidCache } from '../src/push/vapid.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmaster-push-'));
  resetVapidCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['AGENTMASTER_VAPID_PUBLIC_KEY'];
  delete process.env['AGENTMASTER_VAPID_PRIVATE_KEY'];
  delete process.env['AGENTMASTER_VAPID_SUBJECT'];
  resetVapidCache();
  vi.restoreAllMocks();
});

describe('VAPID keys', () => {
  it('generates a keypair on first call and persists it', () => {
    const file = join(dir, 'vapid.json');
    const keys = getVapidKeys(file);

    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();

    const onDisk: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual(keys);
  });

  it('returns the same keypair across calls — regenerating would kill every subscription', () => {
    const file = join(dir, 'vapid.json');
    const first = getVapidKeys(file);
    const second = getVapidKeys(file);
    expect(second).toEqual(first);
  });

  it('writes the key file 0600', () => {
    const file = join(dir, 'vapid.json');
    getVapidKeys(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('prefers the environment override over disk', () => {
    const file = join(dir, 'vapid.json');
    getVapidKeys(file);
    process.env['AGENTMASTER_VAPID_PUBLIC_KEY'] = 'pub-override';
    process.env['AGENTMASTER_VAPID_PRIVATE_KEY'] = 'priv-override';
    expect(getVapidKeys(file)).toEqual({
      publicKey: 'pub-override',
      privateKey: 'priv-override',
    });
  });

  it('regenerates over a corrupt file without logging its contents', () => {
    const file = join(dir, 'vapid.json');
    writeFileSync(file, 'not json at all', { mode: 0o600 });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const keys = getVapidKeys(file);
    expect(keys.publicKey).toBeTruthy();

    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).not.toContain(keys.privateKey);
    expect(logged).not.toContain('not json at all');
  });

  it('defaults the subject and honours the override', () => {
    expect(getVapidSubject()).toBe('mailto:agentmaster@localhost');
    process.env['AGENTMASTER_VAPID_SUBJECT'] = 'mailto:me@example.com';
    expect(getVapidSubject()).toBe('mailto:me@example.com');
  });
});

describe('push subscription storage', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('saves and lists a subscription', () => {
    db.savePushSubscription(
      { endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1', userAgent: 'Safari' },
      1000,
    );
    expect(db.listPushSubscriptions()).toEqual([
      {
        endpoint: 'https://push.example/a',
        p256dh: 'p1',
        auth: 'a1',
        userAgent: 'Safari',
        createdAt: 1000,
        lastOkAt: null,
        failures: 0,
      },
    ]);
  });

  it('upserts by endpoint, refreshing keys and clearing failures', () => {
    db.savePushSubscription({ endpoint: 'e', p256dh: 'old', auth: 'oldauth' }, 1);
    db.recordPushResult('e', false);
    db.recordPushResult('e', false);

    db.savePushSubscription({ endpoint: 'e', p256dh: 'new', auth: 'newauth' }, 2);

    const rows = db.listPushSubscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe('new');
    expect(rows[0]?.auth).toBe('newauth');
    expect(rows[0]?.failures).toBe(0);
    // created_at is not bumped: the row is the same subscription.
    expect(rows[0]?.createdAt).toBe(1);
  });

  it('deletes a subscription, and deleting an unknown one is a no-op', () => {
    db.savePushSubscription({ endpoint: 'e', p256dh: 'p', auth: 'a' });
    db.deletePushSubscription('e');
    expect(db.listPushSubscriptions()).toEqual([]);
    expect(() => db.deletePushSubscription('ghost')).not.toThrow();
  });

  it('recordPushResult bumps failures, and success resets them with a timestamp', () => {
    db.savePushSubscription({ endpoint: 'e', p256dh: 'p', auth: 'a' });
    db.recordPushResult('e', false);
    db.recordPushResult('e', false);
    expect(db.listPushSubscriptions()[0]?.failures).toBe(2);

    db.recordPushResult('e', true, 5555);
    const row = db.listPushSubscriptions()[0];
    expect(row?.failures).toBe(0);
    expect(row?.lastOkAt).toBe(5555);
  });

  it('defaults userAgent to null', () => {
    db.savePushSubscription({ endpoint: 'e', p256dh: 'p', auth: 'a' });
    expect(db.listPushSubscriptions()[0]?.userAgent).toBeNull();
  });
});

describe('sendPush', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    process.env['AGENTMASTER_VAPID_PUBLIC_KEY'] =
      'BJxKIaCbwCiOB2fBiHnQxLbHOQZ0EJ7Y5F9d3nT9k4pRc0S1a2b3c4d5e6f7g8h9i0jKlMnOpQrStUvWxYz0123';
    process.env['AGENTMASTER_VAPID_PRIVATE_KEY'] = 'sO_privateKeyPlaceholderValue0123456789ab';
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    db.close();
  });

  function seedSub(endpoint: string): void {
    db.savePushSubscription({ endpoint, p256dh: 'p', auth: 'a' });
  }

  /**
   * `web-push` is mocked at the module boundary so no test ever opens a socket.
   * Failures are modelled as objects carrying `statusCode`, which is exactly the
   * shape of a `WebPushError`.
   */
  async function withMockedWebPush(
    impl: (sub: { endpoint: string }) => Promise<unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    const webpush = (await import('web-push')).default;
    const spy = vi
      .spyOn(webpush, 'sendNotification')
      .mockImplementation((sub: { endpoint: string }) => impl(sub) as never);
    vi.spyOn(webpush, 'setVapidDetails').mockImplementation(() => undefined);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
  }

  const payload = {
    id: 's1',
    kind: 'waiting' as const,
    title: 'T',
    body: 'B',
  };

  it('returns zeroes when there are no subscriptions', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    expect(await sendPush(db, payload)).toEqual({ sent: 0, pruned: 0 });
  });

  it('counts successes and stamps last_ok_at', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    seedSub('https://push.example/a');
    seedSub('https://push.example/b');

    await withMockedWebPush(
      () => Promise.resolve({}),
      async () => {
        expect(await sendPush(db, payload)).toEqual({ sent: 2, pruned: 0 });
      },
    );

    for (const row of db.listPushSubscriptions()) {
      expect(row.lastOkAt).not.toBeNull();
      expect(row.failures).toBe(0);
    }
  });

  it('prunes a subscription on 410 Gone', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    seedSub('https://push.example/dead');
    seedSub('https://push.example/live');

    await withMockedWebPush(
      (sub) =>
        sub.endpoint.endsWith('/dead')
          ? Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }))
          : Promise.resolve({}),
      async () => {
        expect(await sendPush(db, payload)).toEqual({ sent: 1, pruned: 1 });
      },
    );

    expect(db.listPushSubscriptions().map((r) => r.endpoint)).toEqual([
      'https://push.example/live',
    ]);
  });

  it('prunes on 404 too', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    seedSub('https://push.example/gone');

    await withMockedWebPush(
      () => Promise.reject(Object.assign(new Error('Not Found'), { statusCode: 404 })),
      async () => {
        expect(await sendPush(db, payload)).toEqual({ sent: 0, pruned: 1 });
      },
    );
    expect(db.listPushSubscriptions()).toEqual([]);
  });

  it('keeps a subscription on a transient failure, but prunes after 10 in a row', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    seedSub('https://push.example/flaky');

    await withMockedWebPush(
      () => Promise.reject(Object.assign(new Error('boom'), { statusCode: 500 })),
      async () => {
        for (let i = 1; i <= 9; i += 1) {
          const result = await sendPush(db, payload);
          expect(result).toEqual({ sent: 0, pruned: 0 });
          expect(db.listPushSubscriptions()[0]?.failures).toBe(i);
        }
        expect(await sendPush(db, payload)).toEqual({ sent: 0, pruned: 1 });
      },
    );

    expect(db.listPushSubscriptions()).toEqual([]);
  });

  it('never rejects, even when the transport throws synchronously', async () => {
    const { resetPushConfig } = await import('../src/push/sender.js');
    resetPushConfig();
    seedSub('https://push.example/a');

    await withMockedWebPush(
      () => {
        throw new Error('sync explosion');
      },
      async () => {
        await expect(sendPush(db, payload)).resolves.toEqual({ sent: 0, pruned: 0 });
      },
    );
  });
});
