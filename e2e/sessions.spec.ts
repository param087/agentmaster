import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('rename survives a reload', async ({ page, request }) => {
  const session = await createSession(request, { title: 'before' });
  await openSession(page, session.id);

  await page.getByRole('main').getByRole('button', { name: 'before' }).click();
  const input = page.getByRole('textbox', { name: 'Session title' });
  await input.fill('after rename');
  await input.press('Enter');
  await expect(page.getByRole('main').getByRole('button', { name: 'after rename' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('main').getByRole('button', { name: 'after rename' })).toBeVisible();
  await expect(page.getByRole('complementary').getByText('after rename')).toBeVisible();
});

test('pin floats a session to the top; filter narrows the list', async ({ page, request }) => {
  const names = ['alpha', 'bravo', 'charlie', 'delta'];
  const created = [];
  for (const title of names) created.push(await createSession(request, { title }));
  // Newest first: delta, charlie, bravo, alpha. Pin the oldest.
  await openSession(page, created[0]!.id);

  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  const rows = page.getByRole('complementary').locator('button[aria-current]');
  await expect(rows.first()).toContainText('alpha');
  await expect(rows.first().getByLabel('Pinned')).toBeVisible();

  await page.getByRole('textbox', { name: 'Filter sessions' }).fill('char');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('charlie');
  await page.getByRole('textbox', { name: 'Filter sessions' }).fill('zzz');
  await expect(page.getByText('No sessions match')).toBeVisible();
});
