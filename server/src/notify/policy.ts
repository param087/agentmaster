import type { NotifyKind, NotifyPrefs, QuietHours } from '../status/types.js';

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidClock(value: string): boolean {
  return HH_MM.test(value);
}

function minutesOf(value: string): number {
  const match = HH_MM.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether `at` (server local time) falls inside the quiet window.
 * The window is half-open, `[start, end)`; `start > end` wraps midnight, and
 * `start === end` means "never" rather than "always", which is the safer read.
 */
export function inQuietHours(quiet: QuietHours | null, at: Date): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export interface NotifyContext {
  kind: NotifyKind;
  harnessId: string;
  sessionMuted: boolean;
}

/** Silenced everywhere: desktop and phone. */
export function isMuted(prefs: NotifyPrefs, ctx: NotifyContext): boolean {
  return ctx.sessionMuted || prefs.mutedHarnesses.includes(ctx.harnessId);
}

/** Whether a phone push goes out, on top of not being muted. */
export function shouldPush(prefs: NotifyPrefs, ctx: NotifyContext, at: Date): boolean {
  if (isMuted(prefs, ctx)) return false;
  if (!prefs.pushKinds.includes(ctx.kind)) return false;
  return !inQuietHours(prefs.quietHours, at);
}
