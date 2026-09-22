import { expect, test } from '@playwright/test';

import {
  createSession,
  expectTerminalToContain,
  openSession,
  removeAllSessions,
  runCommand,
} from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('typing reaches the PTY and output renders @mobile', async ({ page, request }) => {
  const session = await createSession(request);
  await openSession(page, session.id);
  await runCommand(page, 'echo e2e-$((6*7))');
  await expectTerminalToContain(page, 'e2e-42');
});

test('touch drag scrolls the scrollback @mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'touch only');
  const session = await createSession(request);
  await openSession(page, session.id);
  await runCommand(page, 'for i in $(seq 1 200); do echo row-$i; done');
  await expectTerminalToContain(page, 'row-200');

  const viewportY = () => page.evaluate(() => (window as unknown as { __term: { viewportY: () => number } }).__term.viewportY());
  const before = await viewportY();
  const box = (await page.locator('.xterm').first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + 100;
  let y = box.y + 20;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 0; i < 15; i += 1) {
    y += 15;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(viewportY).toBeLessThan(before);
  await page.getByRole('button', { name: '↓ Live' }).click();
  await expect.poll(viewportY).toBe(before);
});
