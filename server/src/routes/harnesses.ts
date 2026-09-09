import { Router } from 'express';

import { loadHarnesses } from '../config/harnesses.js';

/**
 * Wire shape of a harness.
 *
 * Deliberately narrow: `Harness` carries compiled `RegExp` objects
 * (`busyMarker`, `waitingInput[].re`) which serialise to `{}` and are pure
 * server-side detection detail. The browser only ever needs to render a picker.
 */
export interface HarnessSummary {
  id: string;
  name: string;
  command: string;
}

export function harnessesRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const harnesses: HarnessSummary[] = loadHarnesses().map((h) => ({
      id: h.id,
      name: h.name,
      command: h.command,
    }));
    res.json({ harnesses });
  });

  return router;
}
