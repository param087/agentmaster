import { Router } from 'express';
import { z } from 'zod';

import type { SessionManager } from '../session/manager.js';
import { expandPath } from './fs.js';
import { readGitDiff, readGitStatus } from '../git/status.js';

/** An `Error` carrying the HTTP status the central middleware should use. */
export interface HttpError extends Error {
  status: number;
}

export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

const createBody = z.object({
  harnessId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1).optional(),
  initialPrompt: z.string().max(20_000).optional(),
});

/** Session titles are shown in a 280px column; anything longer is a paste accident. */
const MAX_TITLE_LENGTH = 120;

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update: send title, pinned and/or muted',
  });

const inputBody = z.object({
  keys: z.string(),
});

/** First zod issue, rendered as `field: message` (or just the message at root). */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** A title as a download filename: no quotes, slashes or control characters. */
export function safeFilename(title: string): string {
  const cleaned = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 80) || 'session';
}

export function sessionsRouter(manager: SessionManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ sessions: manager.list() });
  });

  router.post('/', (req, res, next) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, firstIssue(parsed.error)));

    try {
      // `create` throws for an unknown harness id, a missing cwd, or a failed
      // spawn — all of them are the caller's fault, so they are 400s, not 500s.
      // `cwd` goes through the same tilde expansion as /api/fs/ls, so a path
      // copied out of the folder picker is accepted here too.
      const input = { ...parsed.data, cwd: expandPath(parsed.data.cwd) };
      res.status(201).json({ session: manager.create(input) });
    } catch (error) {
      next(httpError(400, error instanceof Error ? error.message : String(error)));
    }
  });

  /** Kills the process but keeps the session listed, so its output stays readable. */
  /** Forgets every stopped session at once, leaving running ones alone. */
  router.post('/finished/remove', (_req, res) => {
    res.json({ removed: manager.removeFinished() });
  });

  router.delete('/:id', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!manager.get(id)) return next(httpError(404, `Unknown session "${id}"`));
    manager.kill(id);
    res.status(204).end();
  });

  router.patch('/:id', (req, res, next) => {
    const id = req.params.id ?? '';
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, firstIssue(parsed.error)));
    const session = manager.update(id, parsed.data);
    if (!session) return next(httpError(404, `Unknown session "${id}"`));
    res.json({ session });
  });

  /** Downloads the retained output as an asciinema recording. */
  router.get('/:id/export.cast', (req, res, next) => {
    const id = req.params.id ?? '';
    const session = manager.get(id);
    if (!session) return next(httpError(404, `Unknown session "${id}"`));
    const name = safeFilename(session.info.title);
    res.setHeader('content-type', 'application/x-asciicast');
    res.setHeader('content-disposition', `attachment; filename="${name}.cast"`);
    res.send(session.toCast());
  });

  /** Branch and changed files of the session's folder. */
  router.get('/:id/git', (req, res, next) => {
    const id = req.params.id ?? '';
    const session = manager.get(id);
    if (!session) return next(httpError(404, `Unknown session "${id}"`));
    void readGitStatus(session.info.cwd).then((status) => {
      if (!status) return res.json({ repo: false, branch: null, ahead: 0, behind: 0, files: [] });
      // Reading the status is a cheap moment to refresh the sidebar summary too.
      manager.refreshGit(session, 0);
      res.json({ repo: true, ...status });
    }, next);
  });

  /**
   * Diff of one changed file. The path must appear in the current status, so
   * this can never be used to read arbitrary files on disk.
   */
  router.get('/:id/git/diff', (req, res, next) => {
    const id = req.params.id ?? '';
    const session = manager.get(id);
    if (!session) return next(httpError(404, `Unknown session "${id}"`));
    const path = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    void readGitStatus(session.info.cwd)
      .then(async (status) => {
        const file = status?.files.find((f) => f.path === path);
        if (!file) return next(httpError(404, `"${path}" has no changes`));
        res.json(await readGitDiff(session.info.cwd, file));
      })
      .catch(next);
  });

  /** Status history for the timeline view, oldest first. */
  router.get('/:id/events', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!manager.get(id)) return next(httpError(404, `Unknown session "${id}"`));
    res.json({ events: manager.database.listEvents(id) });
  });

  router.post('/:id/remove', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!manager.get(id)) return next(httpError(404, `Unknown session "${id}"`));
    manager.remove(id);
    res.status(204).end();
  });

  /**
   * Fallback path for quick actions when the terminal socket is closed.
   * Keys are written verbatim: identical to typing them into the PTY.
   */
  /** Re-spawns a stopped session in place, keeping its id and history. */
  router.post('/:id/restart', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!manager.get(id)) return next(httpError(404, `Unknown session "${id}"`));

    // `?force=1` kills a live session first. Without it a running session is a
    // 400, so a mis-click cannot throw away work in progress.
    const force = req.query['force'] === '1' || req.query['force'] === 'true';
    manager
      .restart(id, { force })
      .then((session) => res.json({ session }))
      .catch((error: unknown) =>
        next(httpError(400, error instanceof Error ? error.message : String(error))),
      );
  });

  router.post('/:id/input', (req, res, next) => {
    const id = req.params.id ?? '';
    const session = manager.get(id);
    if (!session) return next(httpError(404, `Unknown session "${id}"`));

    const parsed = inputBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, firstIssue(parsed.error)));

    session.write(parsed.data.keys);
    res.status(204).end();
  });

  return router;
}
