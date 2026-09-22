import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions, runCommand } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

/**
 * Enters the alternate screen with application cursor keys on (as vim/less
 * do), then logs every byte it receives. A drag must arrive as `ESC O B`.
 */
test('drag on a full-screen program sends application-mode arrows @mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'touch only');
  const log = join(tmpdir(), `am-keys-${Date.now()}.txt`);
  const session = await createSession(request);
  await openSession(page, session.id);
  await runCommand(
    page,
    `printf '\\033[?1049h\\033[?1h'; while IFS= read -r -s -n1 c; do printf '%q ' "$c" >> ${log}; done`,
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __term: { bufferType: () => string } }).__term.bufferType()))
    .toBe('alternate');

  const box = (await page.locator('.xterm').first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + 100;
  let y = box.y + 200;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 0; i < 10; i += 1) {
    y -= 15;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain("$'\\E' O B");
  expect(readFileSync(log, 'utf8')).not.toContain('\\[ B');
  rmSync(log, { force: true });
});
