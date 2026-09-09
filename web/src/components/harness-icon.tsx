import { cn } from '../lib/cn';

/**
 * Hand-picked two-letter abbreviations for the harnesses we ship.
 *
 * These exist only because the derived fallback would produce collisions or
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

/** djb2 — stable across reloads and machines, which is the whole requirement. */
function hash(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = (h * 33) ^ value.charCodeAt(i);
  return h >>> 0;
}

export function harnessAbbreviation(harnessId: string): string {
  const known = ABBREVIATION[harnessId];
  if (known) return known;
  const letters = harnessId.replace(/[^a-z0-9]/gi, '');
  return (letters.slice(0, 2) || '??').toUpperCase();
}

/**
 * A hue derived from the id, so adding a harness to `harnesses.yaml` gives it a
 * stable colour with no code change. Saturation and lightness are pinned low so
 * badges never compete with the status dots.
 */
export function harnessHue(harnessId: string): number {
  return hash(harnessId) % 360;
}

export interface HarnessIconProps {
  harnessId: string;
  title?: string;
  className?: string;
}

export function HarnessIcon({ harnessId, title, className }: HarnessIconProps) {
  const hue = harnessHue(harnessId);

  return (
    <span
      title={title ?? harnessId}
      className={cn(
        'inline-flex size-6 shrink-0 select-none items-center justify-center rounded',
        'border text-[10px] font-semibold tracking-wider tabular-nums',
        className,
      )}
      style={{
        color: `hsl(${hue} 48% 70%)`,
        backgroundColor: `hsl(${hue} 40% 60% / 0.12)`,
        borderColor: `hsl(${hue} 40% 60% / 0.28)`,
      }}
    >
      {harnessAbbreviation(harnessId)}
    </span>
  );
}
