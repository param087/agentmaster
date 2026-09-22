import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('Cmd+digit jumps to a session; Cmd+arrows step through the list', async ({ page, request }) => {
  const first = await createSession(request, { title: 'one' });
  await createSession(request, { title: 'two' });
  await createSession(request, { title: 'three' });
  // Sidebar order is newest first: three, two, one.
  await openSession(page, first.id);
  const title = page.getByRole('main').getByTitle('Rename session');
  await expect(title).toHaveText('one');

  await page.keyboard.press('ControlOrMeta+1');
  await expect(title).toHaveText('three');
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await expect(title).toHaveText('two');
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await expect(title).toHaveText('one');
  await page.keyboard.press('ControlOrMeta+9');
  await expect(title).toHaveText('one');
});
