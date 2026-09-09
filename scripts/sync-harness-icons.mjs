#!/usr/bin/env node
/**
 * Regenerates `web/src/components/harness-marks.ts` from simple-icons.
 *
 * simple-icons is CC0-1.0, so vendoring its path data is explicitly permitted.
 * We vendor rather than depend because the package is ~50 MB installed and we
 * need six icons.
 *
 *   node scripts/sync-harness-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'web/src/components/harness-marks.ts');
const CDN = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons';

/** harnessId -> [simple-icons slug, upstream source of truth]. */
const MARKS = [
  ['opencode', 'opencode', 'https://github.com/anomalyco/opencode/blob/main/packages/identity/mark.svg'],
  ['claude-code', 'claude', 'https://claude.ai'],
  ['gemini-cli', 'googlegemini', 'https://gemini.google.com'],
  ['codex', 'openai', 'https://openai.com'],
  ['qwen-code', 'qwen', 'https://qwen.ai'],
  ['pi', 'pi', 'https://pi.dev/favicon.svg'],
];

async function fetchMark(slug) {
  const res = await fetch(`${CDN}/${slug}.svg`);
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const svg = await res.text();

  const title = /<title>([^<]*)<\/title>/.exec(svg)?.[1];
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map((m) => m[1]);
  // A multi-path mark would silently render only its first fragment, so fail loudly.
  if (!title || paths.length !== 1) {
    throw new Error(`${slug}: expected one titled path, got ${paths.length}`);
  }
  return { title, path: paths[0] };
}

const entries = [];
for (const [harnessId, slug, source] of MARKS) {
  const { title, path } = await fetchMark(slug);
  entries.push({ harnessId, title, path, source });
  console.log(`  ${harnessId.padEnd(12)} ${title.padEnd(15)} ${String(path.length).padStart(5)}B`);
}

const body = entries
  .map(
    ({ harnessId, title, path, source }) =>
      `  ${JSON.stringify(harnessId)}: {\n` +
      `    label: ${JSON.stringify(title)},\n` +
      `    // ${source}\n` +
      `    path: ${JSON.stringify(path)},\n` +
      `  },`,
  )
  .join('\n');

writeFileSync(
  OUT,
  `/**
 * Official brand marks for the harnesses we ship.
 *
 * Path data is vendored from simple-icons (https://simple-icons.org), which is
 * licensed CC0-1.0, so copying it is explicitly permitted. Vendoring six paths
 * (~2 KB) avoids a ~50 MB dependency for six icons.
 *
 * Each mark is a single path on a 24x24 viewBox, drawn with \`currentColor\`, so
 * colour stays a styling decision. We render them monochrome: in the sidebar,
 * colour means status and nothing else.
 *
 * The brand logos themselves remain trademarks of their respective owners and
 * are used here only to identify the tool each session is running.
 *
 * GENERATED — do not edit by hand. Run \`npm run icons:sync\`.
 */
export interface HarnessMark {
  /** Brand name, for tooltips and alt text. */
  label: string;
  /** Single \`d\` attribute on a 24x24 viewBox. */
  path: string;
}

export const HARNESS_MARKS: Record<string, HarnessMark> = {
${body}
};
`,
);

console.log(`\nwrote ${OUT}`);
