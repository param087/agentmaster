import { expect, test } from '@playwright/test';

import { createSession, expectTerminalToContain, openSession, removeAllSessions, runCommand } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('find in terminal counts matches and steps through them', async ({ page, request }) => {
  const session = await createSession(request);
  await openSession(page, session.id);
  await runCommand(page, 'for i in 1 2 3; do echo needle-$i; done; echo haystack');
  await expectTerminalToContain(page, 'haystack');

  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByRole('textbox', { name: 'Find in terminal' });
  await expect(input).toBeFocused();
  await input.fill('needle-');
  // The echoed command line itself contains "needle-" once too.
  await expect(page.getByRole('search')).toContainText(/\d of 4/);
  await input.press('Enter');
  await input.fill('nothing-here');
  await expect(page.getByRole('search')).toContainText('No results');

  await input.press('Escape');
  await expect(page.getByRole('search')).toHaveCount(0);
});

test('search button opens find on touch @mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'touch only');
  const session = await createSession(request);
  await openSession(page, session.id);
  await runCommand(page, 'echo findme');
  await expectTerminalToContain(page, 'findme');
  await page.getByRole('button', { name: 'Find in terminal' }).click();
  await page.getByRole('textbox', { name: 'Find in terminal' }).fill('findme');
  await expect(page.getByRole('search')).toContainText(/of 2/);
});
