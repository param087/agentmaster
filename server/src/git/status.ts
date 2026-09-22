import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 5_000;
/** Diffs past this are truncated: a lockfile rewrite is not worth 20 MB on a phone. */
export const MAX_DIFF_BYTES = 512 * 1024;

export interface GitFile {
  path: string;
  /** Two-letter porcelain code, e.g. ` M`, `A `, `??`. */
  code: string;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitDiff {
  diff: string;
  truncated: boolean;
}

/** Runs git without a shell; resolves stdout, or null when git fails (not a repo). */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES * 4, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * Parses `git status --porcelain=v1 -b -z`.
 *
 * `-z` keeps paths with spaces or newlines intact; renames carry their source
 * as a second NUL-separated field, which is skipped.
 */
export function parsePorcelain(output: string): GitStatus {
  const fields = output.split('\0');
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field === '') continue;
    if (field.startsWith('## ')) {
      ({ branch, ahead, behind } = parseBranchHeader(field.slice(3)));
      continue;
    }
    const code = field.slice(0, 2);
    files.push({ code, path: field.slice(3) });
    if (code.startsWith('R') || code.startsWith('C')) i += 1;
  }
  return { branch, ahead, behind, files };
}

/** `main...origin/main [ahead 1, behind 2]`, `No commits yet on main`, `HEAD (no branch)`. */
function parseBranchHeader(header: string): { branch: string | null; ahead: number; behind: number } {
  const ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
  if (header.startsWith('HEAD (no branch)')) return { branch: null, ahead, behind };
  const unborn = /^No commits yet on (\S+)/.exec(header);
  if (unborn) return { branch: unborn[1]!, ahead, behind };
  const name = header.split('...')[0]!.split(' ')[0]!;
  return { branch: name, ahead, behind };
}

/** `null` when `cwd` is not inside a git work tree. */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']);
  return out === null ? null : parsePorcelain(out);
}

/**
 * Diff of one changed file against HEAD. Untracked files are diffed against
 * the empty file so they read as additions. The caller must have checked that
 * `file` is in the current status — this never touches arbitrary paths.
 */
export async function readGitDiff(cwd: string, file: GitFile): Promise<GitDiff> {
  const out =
    file.code === '??'
      ? await gitNoIndex(cwd, file.path)
      : ((await git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file.path])) ??
        (await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--cached', '--', file.path])) ??
        '');
  if (Buffer.byteLength(out, 'utf8') <= MAX_DIFF_BYTES) return { diff: out, truncated: false };
  return { diff: out.slice(0, MAX_DIFF_BYTES), truncated: true };
}

/** `git diff --no-index` exits 1 when files differ, so its stdout is taken regardless. */
function gitNoIndex(cwd: string, path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--no-color', '--no-index', '--', '/dev/null', path],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES * 4 },
      (_error, stdout) => resolve(stdout ?? ''),
    );
  });
}
