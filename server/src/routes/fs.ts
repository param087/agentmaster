import { Router } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { httpError } from './sessions.js';

const lsQuery = z.object({
  path: z.string().optional(),
});

export interface DirEntry {
  name: string;
  path: string;
}

/** Expands a leading `~` and resolves to an absolute path. */
export function expandPath(input: string | undefined): string {
  const raw = input?.trim();
  if (!raw) return homedir();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw);
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function hasStatus(error: unknown): error is Error & { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error;
}

/** Maps filesystem errnos onto HTTP status codes. */
function toHttpError(error: unknown, path: string): Error {
  const code = errnoOf(error);
  if (code === 'ENOENT') return httpError(404, `No such directory: ${path}`);
  if (code === 'ENOTDIR') return httpError(404, `Not a directory: ${path}`);
  if (code === 'ELOOP' || code === 'ENAMETOOLONG') {
    return httpError(400, `Cannot read directory: ${path}`);
  }
  // Browsing the user's whole filesystem hits unreadable directories routinely;
  // that must be a clean 403, never an unhandled crash.
  if (code === 'EACCES' || code === 'EPERM') return httpError(403, `Permission denied: ${path}`);
  return httpError(500, error instanceof Error ? error.message : String(error));
}

/**
 * Directory browser for the new-session folder picker.
 *
 * Localhost-only single-user tool, so there is no path jail — but the target is
 * always stat'd first so a symlink to a file can never be walked into.
 */
export function fsRouter(): Router {
  const router = Router();

  router.get('/ls', (req, res, next) => {
    const parsed = lsQuery.safeParse(req.query);
    if (!parsed.success) return next(httpError(400, 'Invalid "path" query parameter'));

    const path = expandPath(parsed.data.path);

    void (async () => {
      try {
        const info = await stat(path);
        if (!info.isDirectory()) throw httpError(404, `Not a directory: ${path}`);

        const entries = await readdir(path, { withFileTypes: true });
        const dirs: DirEntry[] = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: join(path, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        const parent = dirname(path);
        res.json({ path, parent: parent === path ? null : parent, dirs });
      } catch (error) {
        next(hasStatus(error) ? error : toHttpError(error, path));
      }
    })();
  });

  return router;
}
