import { readFileSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type { QuickAction, WaitKind } from '../status/types';
import {
  DEFAULT_FINISHED_AFTER_BUSY_MS,
  DEFAULT_IDLE_MS,
  formatZodError,
  harnessFileSchema,
} from './schema';

export interface WaitingRule {
  re: RegExp;
  kind: WaitKind;
  actions?: QuickAction[];
}

export interface Harness {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Brand mark to draw in the UI. Defaults to `id`. */
  icon?: string;
  busyMarker?: RegExp;
  waitingInput: WaitingRule[];
  idleMs: number;
  finishedAfterBusyMs: number;
}

const WATCH_DEBOUNCE_MS = 200;
/**
 * Leading inline flags, e.g. `(?i)`, `(?m)`, `(?im)`.
 *
 * JS has no inline flag syntax, so a leading group is stripped and translated
 * into real RegExp flags. `m` matters a lot here: rules run against a whole
 * rendered screen joined by newlines, so anchoring a pattern to a single screen
 * line requires multiline mode.
 */
const INLINE_FLAGS = /^\(\?([im]+)\)/;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default location of the registry: `harnesses.yaml` beside the server package. */
export const DEFAULT_HARNESSES_PATH = resolve(packageRoot, '..', 'harnesses.yaml');

/**
 * Compiles a YAML `match` / `busy_marker` string into a RegExp.
 * JS has no inline flags, so a leading `(?i)` / `(?m)` / `(?im)` is translated.
 */
function compileRegExp(pattern: string, harnessId: string, field: string): RegExp {
  const inline = INLINE_FLAGS.exec(pattern);
  const flags = inline?.[1] ?? '';
  const source = pattern.replace(INLINE_FLAGS, '');
  try {
    return new RegExp(source, flags);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Invalid regex in harness "${harnessId}" (${field}): ${JSON.stringify(pattern)} — ${reason}`,
      { cause },
    );
  }
}

/** Parses and validates registry YAML, compiling all detection patterns. */
export function parseHarnesses(yamlText: string): Harness[] {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`harnesses.yaml is not valid YAML: ${reason}`, { cause });
  }

  const parsed = harnessFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`harnesses.yaml failed validation:\n${formatZodError(parsed.error)}`);
  }

  const { defaults, harnesses } = parsed.data;
  const idleMs = defaults?.idle_ms ?? DEFAULT_IDLE_MS;
  const finishedAfterBusyMs = defaults?.finished_after_busy_ms ?? DEFAULT_FINISHED_AFTER_BUSY_MS;

  const seen = new Set<string>();
  return harnesses.map((raw) => {
    if (seen.has(raw.id)) {
      throw new Error(`Duplicate harness id "${raw.id}" in harnesses.yaml`);
    }
    seen.add(raw.id);

    const harness: Harness = {
      id: raw.id,
      name: raw.name,
      command: raw.command,
      args: raw.args,
      waitingInput: raw.waiting_input.map((rule, index) => {
        const compiled: WaitingRule = {
          re: compileRegExp(rule.match, raw.id, `waiting_input[${index}].match`),
          kind: rule.kind,
        };
        if (rule.actions) compiled.actions = rule.actions;
        return compiled;
      }),
      idleMs: raw.idle_ms ?? idleMs,
      finishedAfterBusyMs: raw.finished_after_busy_ms ?? finishedAfterBusyMs,
    };

    if (raw.busy_marker) {
      harness.busyMarker = compileRegExp(raw.busy_marker, raw.id, 'busy_marker');
    }
    if (raw.icon) harness.icon = raw.icon;
    return harness;
  });
}

const cache = new Map<string, Harness[]>();

/** Reads and parses the registry from disk, memoised per path. */
export function loadHarnesses(path: string = DEFAULT_HARNESSES_PATH): Harness[] {
  const cached = cache.get(path);
  if (cached) return cached;

  const harnesses = parseHarnesses(readFileSync(path, 'utf8'));
  cache.set(path, harnesses);
  return harnesses;
}

/** Looks up a harness by id in the default registry. */
export function getHarness(id: string): Harness | undefined {
  return loadHarnesses().find((h) => h.id === id);
}

/**
 * Watches the registry file and re-parses on change (debounced).
 * A parse error is logged and the previous config is kept; `onChange` is not called.
 * Returns an unwatch function.
 */
export function watchHarnesses(path: string, onChange: (h: Harness[]) => void): () => void {
  let timer: NodeJS.Timeout | undefined;

  const reload = (): void => {
    try {
      const harnesses = parseHarnesses(readFileSync(path, 'utf8'));
      cache.set(path, harnesses);
      onChange(harnesses);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[harnesses] reload failed, keeping previous config: ${reason}\n`);
    }
  };

  const watcher = watch(path, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, WATCH_DEBOUNCE_MS);
    timer.unref?.();
  });

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
