import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Whether a harness command can actually be executed.
 *
 * Without this, choosing an uninstalled harness fails with an opaque
 * `spawn ENOENT` *after* you have picked a folder and pressed Create. Resolving
 * up front turns that into something the picker can show, and means a wrong
 * command name in the registry degrades to "not installed" rather than a crash.
 */
const CACHE_MS = 5_000;

const cache = new Map<string, { at: number; available: boolean }>();

function isExecutableFile(path: string): boolean {
  try {
    // A directory on PATH can share a command's name; only files count.
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolve(command: string): boolean {
  // An explicit path is checked directly; PATH lookup does not apply to it.
  if (command.includes('/')) return isExecutableFile(command);

  const pathVar = process.env['PATH'] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    if (isExecutableFile(join(isAbsolute(dir) ? dir : join(process.cwd(), dir), command))) {
      return true;
    }
  }
  return false;
}

/**
 * Cached for a few seconds: this is a stat per PATH entry per harness, and the
 * picker asks for every harness at once. Short enough that installing a CLI
 * shows up almost immediately.
 */
export function isCommandAvailable(command: string, now = Date.now()): boolean {
  const hit = cache.get(command);
  if (hit && now - hit.at < CACHE_MS) return hit.available;

  const available = resolve(command);
  cache.set(command, { at: now, available });
  return available;
}

/** Test seam; also useful after installing something mid-session. */
export function clearAvailabilityCache(): void {
  cache.clear();
}
