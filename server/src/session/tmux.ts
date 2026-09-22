import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isCommandAvailable } from '../config/availability.js';

/**
 * tmux-backed persistence.
 *
 * Each harness runs inside its own tmux session on a *private* tmux server
 * (`tmux -L <socket>`), so the user's own tmux sessions are never touched and
 * never see ours. agentmaster only runs a tmux *client* in its PTY; when the
 * server process goes away the client dies and the session — and the agent —
 * keeps running, ready to be re-attached on the next start.
 */

export type PtyBackend = 'direct' | 'tmux';

/** Lines of history restored into the browser after a re-attach. */
export const RESTORE_HISTORY_LINES = 5000;
const TMUX_TIMEOUT_MS = 5000;

/**
 * The client-side config. Everything here exists to make tmux invisible:
 * no status bar, no prefix key (every keystroke belongs to the harness), and no
 * alternate screen in the *outer* terminal, so the browser keeps its scrollback.
 */
const TMUX_CONF = `# Written by agentmaster. Edits are overwritten on start.
set -g status off
set -g prefix None
set -g prefix2 None
unbind-key -a
set -g escape-time 0
set -g history-limit ${RESTORE_HISTORY_LINES}
set -g default-terminal "xterm-256color"
set -g window-size latest
set -g aggressive-resize on
set -g mouse off
set -g set-clipboard off
set -g focus-events on
# Lets Shift+Enter and other modified keys reach the agent (pi warns without it).
set -g extended-keys on
set -g remain-on-exit off
set -g exit-empty on
set -g destroy-unattached off
set -ga terminal-overrides ',*:smcup@:rmcup@'
`;

export function tmuxSocket(): string {
  return process.env['AGENTMASTER_TMUX_SOCKET'] ?? 'agentmaster';
}

export function stateDir(): string {
  return process.env['AGENTMASTER_STATE_DIR'] ?? join(homedir(), '.agentmaster');
}

export function tmuxAvailable(): boolean {
  return isCommandAvailable('tmux');
}

/**
 * `AGENTMASTER_PTY_BACKEND=tmux|direct`. Unset means tmux when installed,
 * otherwise the classic direct PTY. An explicit `tmux` without tmux installed
 * falls back too, with a warning, rather than refusing to start.
 */
export function resolveBackend(raw = process.env['AGENTMASTER_PTY_BACKEND']): PtyBackend {
  if (raw === 'direct') return 'direct';
  if (tmuxAvailable()) return 'tmux';
  if (raw === 'tmux') process.stderr.write('[tmux] AGENTMASTER_PTY_BACKEND=tmux but tmux is not installed; using direct\n');
  return 'direct';
}

export function tmuxSessionName(id: string): string {
  return `am-${id}`;
}

export function exitFilePath(id: string): string {
  return join(stateDir(), 'exit', id);
}

let confPath: string | undefined;

/** Writes the config once per process and returns its path. */
export function tmuxConfPath(): string {
  if (confPath) return confPath;
  const dir = stateDir();
  mkdirSync(join(dir, 'exit'), { recursive: true });
  const path = join(dir, 'tmux.conf');
  writeFileSync(path, TMUX_CONF);
  confPath = path;
  return path;
}

/** Common leading arguments: private socket, our config, force UTF-8. */
export function tmuxBaseArgs(): string[] {
  return ['-L', tmuxSocket(), '-f', tmuxConfPath(), '-u'];
}

/**
 * The command run *inside* tmux: the harness, wrapped so its real exit code
 * survives the session (tmux itself does not keep it once the pane is gone).
 */
export function wrappedCommand(id: string, command: string, args: readonly string[]): string[] {
  const script = 'f=$1; shift; "$@"; c=$?; printf %s "$c" > "$f"; exit $c';
  return ['sh', '-c', script, 'agentmaster', exitFilePath(id), command, ...args];
}

export function newSessionArgs(id: string, cwd: string, command: string, args: readonly string[]): string[] {
  return [
    ...tmuxBaseArgs(),
    'new-session',
    '-A',
    '-s',
    tmuxSessionName(id),
    '-c',
    cwd,
    '--',
    ...wrappedCommand(id, command, args),
  ];
}

export function attachArgs(id: string): string[] {
  return [...tmuxBaseArgs(), 'attach-session', '-t', `=${tmuxSessionName(id)}`];
}

function tmux(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('tmux', [...tmuxBaseArgs(), ...args], {
    encoding: 'utf8',
    timeout: TMUX_TIMEOUT_MS,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

export function hasTmuxSession(id: string): boolean {
  return tmux(['has-session', '-t', `=${tmuxSessionName(id)}`]).ok;
}

/** Ends the agent and its session. A no-op when it is already gone. */
export function killTmuxSession(id: string): void {
  tmux(['kill-session', '-t', `=${tmuxSessionName(id)}`]);
}

/** Session ids (without the `am-` prefix) currently alive on our tmux server. */
export function listTmuxSessionIds(): string[] {
  const { ok, stdout } = tmux(['list-sessions', '-F', '#{session_name}']);
  if (!ok) return [];
  return stdout
    .split('\n')
    .filter((name) => name.startsWith('am-'))
    .map((name) => name.slice(3));
}

/**
 * Scrollback above the visible screen, with colours, as terminal bytes. The
 * visible screen is excluded because tmux repaints it on attach.
 */
export function captureHistory(id: string): string {
  try {
    const out = execFileSync(
      'tmux',
      [
        ...tmuxBaseArgs(),
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-S',
        `-${RESTORE_HISTORY_LINES}`,
        '-E',
        '-1',
        '-t',
        // Pane commands need the trailing ':' — `=name` alone is a session
        // target and capture-pane rejects it ("can't find pane").
        `=${tmuxSessionName(id)}:`,
      ],
      { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const trimmed = out.replace(/\n+$/, '');
    return trimmed === '' ? '' : `${trimmed.replace(/\n/g, '\r\n')}\r\n`;
  } catch {
    return '';
  }
}

/** Exit code recorded by {@link wrappedCommand}, or null if the agent never got to write it. */
export function readExitCode(id: string): number | null {
  try {
    const code = Number.parseInt(readFileSync(exitFilePath(id), 'utf8'), 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

export function removeExitFile(id: string): void {
  rmSync(exitFilePath(id), { force: true });
}

export interface PaneModes {
  /** The program inside tmux is on the alternate screen (vim, less, opencode). */
  alt: boolean;
  /** It asked for application cursor keys (DECCKM). */
  appCursor: boolean;
}

/**
 * The *inner* program's terminal modes. The browser only sees tmux's client,
 * which never switches the outer terminal to the alternate screen (that is
 * disabled so shell output keeps its scrollback), so it has to be told.
 */
export function readPaneModes(id: string): Promise<PaneModes | null> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      [...tmuxBaseArgs(), 'display-message', '-p', '-t', `=${tmuxSessionName(id)}:`, '#{alternate_on} #{keypad_cursor_flag}'],
      { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve(null);
        const [alt, cursor] = stdout.trim().split(' ');
        resolve({ alt: alt === '1', appCursor: cursor === '1' });
      },
    );
  });
}
