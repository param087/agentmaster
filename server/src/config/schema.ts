import { z } from 'zod';

export const waitKindSchema = z.enum(['permission', 'question', 'menu', 'unknown']);

export const quickActionSchema = z
  .object({
    label: z.string().min(1),
    keys: z.string().min(1),
  })
  .strict();

export const waitingRuleSchema = z
  .object({
    match: z.string().min(1),
    kind: waitKindSchema.default('unknown'),
    actions: z.array(quickActionSchema).optional(),
  })
  .strict();

export const harnessSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /**
     * Which brand mark the dashboard should draw. Defaults to the harness id.
     * Set it when a fork or renamed CLI should reuse an existing icon, e.g.
     * `icon: claude` for a Claude Code wrapper.
     */
    icon: z.string().min(1).optional(),
    busy_marker: z.string().min(1).optional(),
    waiting_input: z.array(waitingRuleSchema).default([]),
    idle_ms: z.number().int().positive().optional(),
    finished_after_busy_ms: z.number().int().positive().optional(),
  })
  .strict();

export const defaultsSchema = z
  .object({
    idle_ms: z.number().int().positive().optional(),
    finished_after_busy_ms: z.number().int().positive().optional(),
  })
  .strict();

export const harnessFileSchema = z
  .object({
    defaults: defaultsSchema.optional(),
    harnesses: z.array(harnessSchema).min(1),
  })
  .strict();

export type HarnessFileInput = z.input<typeof harnessFileSchema>;
export type HarnessFile = z.output<typeof harnessFileSchema>;
export type RawHarness = z.output<typeof harnessSchema>;
export type RawWaitingRule = z.output<typeof waitingRuleSchema>;

export const DEFAULT_IDLE_MS = 2500;
export const DEFAULT_FINISHED_AFTER_BUSY_MS = 20000;

/** Turns a ZodError into a single readable multi-line message. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
}
