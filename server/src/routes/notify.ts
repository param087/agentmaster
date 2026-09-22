import { Router } from 'express';
import { z } from 'zod';

import { isValidClock } from '../notify/policy.js';
import type { SessionManager } from '../session/manager.js';
import { httpError } from './sessions.js';

const clock = z.string().refine(isValidClock, 'expected HH:MM (24h)');

const prefsBody = z
  .object({
    pushKinds: z.array(z.enum(['waiting', 'done', 'exited', 'killed', 'error'])),
    quietHours: z.object({ start: clock, end: clock }).strict().nullable(),
    mutedHarnesses: z.array(z.string().min(1)).max(100),
  })
  .strict();

/** Notification rules shared by every device. */
export function notifyRouter(manager: SessionManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ prefs: manager.getNotifyPrefs() });
  });

  router.put('/', (req, res, next) => {
    const parsed = prefsBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return next(httpError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid body'));
    }
    const unique = <T>(values: T[]): T[] => [...new Set(values)];
    res.json({
      prefs: manager.setNotifyPrefs({
        pushKinds: unique(parsed.data.pushKinds),
        quietHours: parsed.data.quietHours,
        mutedHarnesses: unique(parsed.data.mutedHarnesses),
      }),
    });
  });

  return router;
}

const generalBody = z
  .object({
    // Up to a year; fractional hours allowed so tests (and the impatient) can use minutes.
    pruneAfterHours: z.number().positive().max(24 * 365).nullable(),
  })
  .strict();

/** Server-wide preferences that are not notification rules. */
export function settingsRouter(manager: SessionManager): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ settings: manager.getGeneralSettings() });
  });
  router.put('/', (req, res, next) => {
    const parsed = generalBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return next(httpError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid body'));
    }
    res.json({ settings: manager.setGeneralSettings(parsed.data) });
  });
  return router;
}
