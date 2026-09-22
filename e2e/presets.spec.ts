import { expect, test } from '@playwright/test';

import { expectTerminalToContain, openSession, createSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => {
  await removeAllSessions(request);
  const res = await request.get('/api/presets');
  const { presets } = (await res.json()) as { presets: Array<{ id: string }> };
  for (const p of presets) await request.delete(`/api/presets/${p.id}`);
});

test('first prompt runs on start; save-as-preset relaunches it', async ({ page, request }) => {
  // Any session, just to land on the dashboard with the probe enabled.
  const seed = await createSession(request, { title: 'seed' });
  await openSession(page, seed.id);

  await page.getByRole('button', { name: 'New', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByPlaceholder('Defaults to the folder name').fill('Greeter');
  await dialog.getByPlaceholder('Typed in as soon as the harness is ready').fill('echo preset-$((40+2))');
  await dialog.getByLabel('Save as preset').check();
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('main').getByRole('button', { name: 'Greeter' })).toBeVisible();
  await expectTerminalToContain(page, 'preset-42');

  await page.getByRole('button', { name: 'New', exact: true }).first().click();
  await dialog.getByRole('list', { name: 'Presets' }).getByRole('button', { name: 'Start preset Greeter' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('complementary').getByText('Greeter')).toHaveCount(2);
  await expectTerminalToContain(page, 'preset-42');

  await page.getByRole('button', { name: 'New', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Delete preset Greeter' }).click();
  await expect(dialog.getByRole('list', { name: 'Presets' })).toHaveCount(0);
});
