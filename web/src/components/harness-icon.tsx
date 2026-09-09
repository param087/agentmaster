import { cn } from '../lib/cn';
import { HARNESS_MARKS } from './harness-marks';

/**
 * Two-letter abbreviations for harnesses with no vendored brand mark.
 *
 * These exist only because the derived fallback would collide or produce
 * unhelpful pairs (`codex` and `claude-code` both start `C`).
 */
const ABBREVIATION: Record<string, string> = {
  opencode: 'OC',
  'claude-code': 'CC',
  'gemini-cli': 'GM',
  codex: 'CX',
  'qwen-code': 'QW',
  pi: 'PI',
};

export function harnessAbbreviation(harnessId: string): string {
  const known = ABBREVIATION[harnessId];
  if (known) return known;
  const letters = harnessId.replace(/[^a-z0-9]/gi, '');
  return (letters.slice(0, 2) || '??').toUpperCase();
}

export interface HarnessIconProps {
  harnessId: string;
  /**
   * Mark to draw, from the harness's optional `icon:` field in harnesses.yaml.
   * Lets a fork reuse an existing brand mark. Defaults to `harnessId`.
   */
  icon?: string | undefined;
  title?: string;
  className?: string;
}

/**
 * A harness badge: the official brand mark where we have one, otherwise a
 * two-letter fallback so an unknown CLI still gets a stable badge with no code
 * change.
 *
 * Deliberately monochrome, including the fallback. Colour in the sidebar means
 * *status* — amber "needs you", green "done" — and a brand palette next to those
 * dots would dilute the only signal that asks the user to act. The marks are
 * distinctive enough as shapes.
 *
 * Both branches render the same 24px box, so swapping one for the other can
 * never shift a row.
 */
export function HarnessIcon({ harnessId, icon, title, className }: HarnessIconProps) {
  const mark = HARNESS_MARKS[icon ?? harnessId] ?? HARNESS_MARKS[harnessId];
  const label = title ?? mark?.label ?? harnessId;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-6 shrink-0 select-none items-center justify-center rounded',
        'border border-base-700 bg-base-800 text-base-300',
        // Brightens with the row rather than on its own, so the badge reads as
        // part of the session, not as a separate control.
        'transition-colors group-hover:text-base-100',
        className,
      )}
    >
      {mark ? (
        <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
          <path d={mark.path} />
        </svg>
      ) : (
        <span className="text-[10px] font-semibold tracking-wider tabular-nums" aria-hidden="true">
          {harnessAbbreviation(harnessId)}
        </span>
      )}
    </span>
  );
}
