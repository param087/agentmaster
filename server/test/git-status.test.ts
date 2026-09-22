import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parsePorcelain, readGitDiff, readGitStatus } from '../src/git/status.js';

describe('parsePorcelain', () => {
  it('reads branch, tracking counts, and files including renames and spaces', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'R  new name.ts', 'old name.ts', '?? notes.md', ''].join('\0');
    expect(parsePorcelain(out)).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 1,
      files: [
        { code: ' M', path: 'src/a.ts' },
        { code: 'R ', path: 'new name.ts' },
        { code: '??', path: 'notes.md' },
      ],
    });
  });

  it('handles unborn and detached heads', () => {
    expect(parsePorcelain('## No commits yet on trunk\0').branch).toBe('trunk');
    expect(parsePorcelain('## HEAD (no branch)\0').branch).toBeNull();
  });
});

describe('readGitStatus / readGitDiff against a real repo', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

  it('reports changes and diffs tracked and untracked files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'am-git-'));
    run('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    run('add', '.');
    run('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');

    const status = await readGitStatus(dir);
    expect(status?.branch).toBe('main');
    expect(status?.files).toEqual([
      { code: ' M', path: 'a.txt' },
      { code: '??', path: 'b.txt' },
    ]);

    const tracked = await readGitDiff(dir, status!.files[0]!);
    expect(tracked.diff).toContain('-one');
    expect(tracked.diff).toContain('+two');
    const untracked = await readGitDiff(dir, status!.files[1]!);
    expect(untracked.diff).toContain('+new');
  });

  it('returns null outside a repository', async () => {
    dir = mkdtempSync(join(tmpdir(), 'am-nogit-'));
    expect(await readGitStatus(dir)).toBeNull();
  });
});
