import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions, terminalTextFor } from './helpers';

test.beforeEach(async ({ request, page }) => {
  await removeAllSessions(request);
  // Once per test, not per navigation, so the reload below can see what was stored.
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('reset')) return;
    window.sessionStorage.setItem('reset', '1');
    window.localStorage.removeItem('agentmaster.paneLayout');
  });
});

test('two panes show two sessions; input follows the focused pane', async ({ page, request }) => {
  const left = await createSession(request, { title: 'left' });
  const right = await createSession(request, { title: 'right' });
  await openSession(page, left.id);

  await page.getByRole('button', { name: '2 panes' }).click();
  await page.getByRole('region', { name: 'Pane 2' }).click();
  await page.getByRole('complementary').getByText('right', { exact: true }).click();

  await expect(page.getByRole('region', { name: 'Pane 1' })).toContainText('left');
  await expect(page.getByRole('region', { name: 'Pane 2' })).toContainText('right');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('echo to-right');
  await prompt.press('Enter');
  await expect.poll(() => terminalTextFor(page, right.id)).toContain('to-right');
  expect(await terminalTextFor(page, left.id)).not.toContain('to-right');

  await page.getByRole('region', { name: 'Pane 1' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'left' }).first()).toBeVisible();
  await prompt.fill('echo to-left');
  await prompt.press('Enter');
  await expect.poll(() => terminalTextFor(page, left.id)).toContain('to-left');

  // The layout is remembered.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Pane 2' })).toBeVisible();
});

test('phones always get a single pane @mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.addInitScript(() => window.localStorage.setItem('agentmaster.paneLayout', '4'));
  const s = await createSession(request);
  await openSession(page, s.id);
  await expect(page.getByRole('region', { name: 'Pane 2' })).toHaveCount(0);
});
