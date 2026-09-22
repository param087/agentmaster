import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { createSession, expectTerminalToContain, openSession, removeAllSessions, runCommand } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

async function download(page: import('@playwright/test').Page, label: RegExp): Promise<{ name: string; body: string }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: label }).click(),
  ]);
  return { name: file.suggestedFilename(), body: readFileSync((await file.path())!, 'utf8') };
}

test('exports text, HTML and an asciicast recording', async ({ page, request }) => {
  const session = await createSession(request, { title: 'my export' });
  await openSession(page, session.id);
  await runCommand(page, 'printf "\\033[31mred-text\\033[0m\\n"');
  await expectTerminalToContain(page, 'red-text');

  const txt = await download(page, /Text/);
  expect(txt.name).toBe('my-export.txt');
  expect(txt.body).toContain('red-text');
  expect(txt.body).not.toContain('\u001b');

  const html = await download(page, /HTML/);
  expect(html.name).toBe('my-export.html');
  expect(html.body).toMatch(/<span style=['"][^'"]*color[^'"]*['"]>red-text<\/span>/);

  const cast = await download(page, /Recording/);
  expect(cast.name).toBe('my-export.cast');
  const [header] = cast.body.split('\n');
  expect(JSON.parse(header!)).toMatchObject({ version: 2, title: 'my export' });
  expect(cast.body).toContain('red-text');
});
