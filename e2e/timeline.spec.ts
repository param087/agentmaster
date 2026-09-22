import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('timeline shows totals and transitions, and updates live', async ({ page, request }) => {
  const session = await createSession(request, { title: 'tl' });
  await openSession(page, session.id);
  await page.getByRole('button', { name: 'Timeline' }).click();

  const panel = page.getByRole('complementary', { name: 'Timeline' });
  await expect(panel.getByText('Waiting on you')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Transitions' })).toContainText('Working');

  await request.post(`/api/sessions/${session.id}/input`, {
    data: { keys: 'printf "Proceed%s [y/n] " "?"; read a\r' },
  });
  await expect(panel.getByRole('list', { name: 'Transitions' })).toContainText('permission', { timeout: 10_000 });

  await panel.getByRole('button', { name: 'Close timeline' }).click();
  await expect(panel).toHaveCount(0);
});
