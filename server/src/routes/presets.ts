import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import type { SessionManager } from '../session/manager.js';
import { expandPath } from './fs.js';
import { httpError } from './sessions.js';

const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 20_000;

const presetBody = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    harnessId: z.string().min(1),
    cwd: z.string().min(1),
    prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  })
  .strict();

/**
 * Saved launch configurations. Stored server-side so a preset made on the
 * laptop is there on the phone too.
 */
export function presetsRouter(manager: SessionManager): Router {
  const router = Router();
  const db = manager.database;

  router.get('/', (_req, res) => {
    res.json({ presets: db.listPresets() });
  });

  router.post('/', (req, res, next) => {
    const parsed = presetBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return next(httpError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid body'));
    }
    const prompt = parsed.data.prompt?.trim() ? parsed.data.prompt : null;
    const preset = {
      id: nanoid(10),
      name: parsed.data.name,
      harnessId: parsed.data.harnessId,
      cwd: expandPath(parsed.data.cwd),
      prompt,
      createdAt: Date.now(),
    };
    db.insertPreset(preset);
    res.status(201).json({ preset });
  });

  router.delete('/:id', (req, res, next) => {
    if (!db.deletePreset(req.params.id ?? '')) return next(httpError(404, 'Unknown preset'));
    res.status(204).end();
  });

  /** Starts a session from a preset, queuing its prompt for when the harness is ready. */
  router.post('/:id/launch', (req, res, next) => {
    const preset = db.getPreset(req.params.id ?? '');
    if (!preset) return next(httpError(404, 'Unknown preset'));
    try {
      const session = manager.create({
        harnessId: preset.harnessId,
        cwd: preset.cwd,
        title: preset.name,
        ...(preset.prompt ? { initialPrompt: preset.prompt } : {}),
      });
      res.status(201).json({ session });
    } catch (error) {
      next(httpError(400, error instanceof Error ? error.message : String(error)));
    }
  });

  return router;
}
