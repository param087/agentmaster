import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

let repo = '';

test.beforeEach(async ({ request }) => {
  await removeAllSessions(request);
  repo = mkdtempSync(join(tmpdir(), 'am-e2e-git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, env });
  run('init', '-q', '-b', 'feature-x');
  writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
  run('add', '.');
  run('commit', '-qm', 'init');
});

test.afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('sidebar shows the branch; the changes panel lists files and diffs', async ({ page, request }) => {
  writeFileSync(join(repo, 'app.ts'), 'const a = 2;\n');
  writeFileSync(join(repo, 'new.md'), 'hello\n');
  const session = await createSession(request, { cwd: repo, title: 'repo' });
  await openSession(page, session.id);

  await expect(page.getByRole('complementary')).toContainText('feature-x ●2');
  await page.getByRole('button', { name: 'Changes' }).click();
  const panel = page.getByRole('complementary', { name: 'Changes' });
  const files = panel.getByRole('list', { name: 'Changed files' });
  await expect(files).toContainText('app.ts');
  await expect(files).toContainText('new.md');

  await files.getByText('app.ts').click();
  const diff = panel.getByLabel('Diff');
  await expect(diff).toContainText('-const a = 1;');
  await expect(diff).toContainText('+const a = 2;');

  await panel.getByRole('button', { name: 'Back to changed files' }).click();
  await expect(files).toBeVisible();
});
