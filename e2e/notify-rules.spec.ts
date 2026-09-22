import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => {
  await removeAllSessions(request);
  await request.put('/api/notify-prefs', {
    data: { pushKinds: ['waiting', 'error'], quietHours: null, mutedHarnesses: [] },
  });
});

test('phone rules save on change and survive reopening settings', async ({ page, request }) => {
  const session = await createSession(request);
  await openSession(page, session.id);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const rules = page.getByRole('region', { name: 'Phone rules' });
  await rules.getByLabel('Finished').check();
  await rules.getByLabel('Quiet hours', { exact: true }).check();
  await rules.getByLabel('Quiet hours start').fill('23:15');
  await rules.getByLabel('Bash').check();

  await expect
    .poll(async () => (await (await request.get('/api/notify-prefs')).json()).prefs)
    .toEqual({
      pushKinds: ['waiting', 'error', 'done'],
      quietHours: { start: '23:15', end: '07:00' },
      mutedHarnesses: ['bash'],
    });

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(rules.getByLabel('Quiet hours start')).toHaveValue('23:15');
  await expect(rules.getByLabel('Finished')).toBeChecked();
});

test('muting a session marks it in the sidebar', async ({ page, request }) => {
  const session = await createSession(request, { title: 'noisy' });
  await openSession(page, session.id);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('complementary').getByLabel('Muted')).toBeVisible();
  await page.getByRole('button', { name: 'Unmute' }).click();
  await expect(page.getByRole('complementary').getByLabel('Muted')).toHaveCount(0);
});
