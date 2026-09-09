import { Router } from 'express';
import { z } from 'zod';

import type { SessionManager } from '../session/manager.js';
import { expandPath } from './fs.js';

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
  router.delete('/:id', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!manager.get(id)) return next(httpError(404, `Unknown session "${id}"`));
    manager.kill(id);
    res.status(204).end();
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
