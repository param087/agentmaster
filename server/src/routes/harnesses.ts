import { Router } from 'express';
import { z } from 'zod';

import { isCommandAvailable } from '../config/availability.js';
import { loadHarnesses } from '../config/harnesses.js';
import type { Db } from '../db/index.js';
import { httpError } from './sessions.js';

export interface HarnessSummary {
  id: string;
  name: string;
  command: string;
  /** Brand mark to draw. Always resolved, so the client never guesses. */
  icon: string;
  /** The command resolves to an executable on PATH. */
  available: boolean;
  /** Shown in the new-session picker. */
  enabled: boolean;
}

const enabledBody = z.object({ enabled: z.boolean() });

/**
 * Resolves the registry against availability and stored preferences.
 *
 * A harness with no stored preference is enabled *iff* it is installed, so a
 * newly installed CLI appears in the picker on its own and an uninstalled one
 * never clutters it. Only an explicit toggle is persisted.
 */
export function listHarnessSummaries(db: Db): HarnessSummary[] {
  const prefs = db.getHarnessPrefs();
  return loadHarnesses().map((h) => {
    const available = isCommandAvailable(h.command);
    return {
      id: h.id,
      name: h.name,
      command: h.command,
      icon: h.icon ?? h.id,
      available,
      enabled: prefs.get(h.id) ?? available,
    };
  });
}

export function harnessesRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ harnesses: listHarnessSummaries(db) });
  });

  router.post('/:id/enabled', (req, res, next) => {
    const id = req.params.id ?? '';
    if (!loadHarnesses().some((h) => h.id === id)) {
      return next(httpError(404, `Unknown harness "${id}"`));
    }

    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) return next(httpError(400, 'Expected { enabled: boolean }'));

    db.setHarnessEnabled(id, parsed.data.enabled);
    const harness = listHarnessSummaries(db).find((h) => h.id === id);
    res.json({ harness });
  });

  return router;
}
