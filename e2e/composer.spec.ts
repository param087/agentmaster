import { expect, test } from '@playwright/test';

import { createSession, expectTerminalToContain, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('composer sends single and multi-line prompts @mobile', async ({ page, request }) => {
  const session = await createSession(request);
  await openSession(page, session.id);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });

  await prompt.fill('echo one-$((1+1))');
  await prompt.press('Enter');
  await expectTerminalToContain(page, 'one-2');
  await expect(prompt).toHaveValue('');

  await prompt.fill('echo line-a\necho line-b');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expectTerminalToContain(page, 'line-a');
  await expectTerminalToContain(page, 'line-b');
});

test('Shift+Enter adds a line instead of sending', async ({ page, request }) => {
  const session = await createSession(request);
  await openSession(page, session.id);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('first');
  await prompt.press('Shift+Enter');
  await prompt.pressSequentially('second');
  await expect(prompt).toHaveValue('first\nsecond');
});

test('also-send-to broadcasts to another session', async ({ page, request }) => {
  const other = await createSession(request, { title: 'other' });
  const main = await createSession(request, { title: 'main' });
  await openSession(page, main.id);

  await page.getByRole('button', { name: 'Also send to other sessions' }).click();
  await page.getByRole('group', { name: 'Also send to' }).getByLabel('other').check();
  await expect(page.getByText('Also sending to other')).toBeVisible();

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('echo broadcast-ok');
  await prompt.press('Enter');
  await expectTerminalToContain(page, 'broadcast-ok');

  await page.getByRole('complementary').getByText('other', { exact: true }).click();
  await expectTerminalToContain(page, 'broadcast-ok');
});
