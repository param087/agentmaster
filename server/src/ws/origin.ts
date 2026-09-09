/**
 * Origin allowlist for WebSocket upgrades.
 *
 * Browsers do not apply the same-origin policy to WebSockets. They will happily
 * open `ws://127.0.0.1:7180/...` from any page and simply set an `Origin`
 * header, so binding to loopback protects nothing on its own: any site visited
 * while agentmaster is running could connect to `/ws/events`, read the full
 * session inventory, then attach to `/ws/term/:id` and both read the mirrored
 * terminal and type into the PTY. Typing into a PTY running an agent is
 * arbitrary command execution.
 *
 * The REST API does not need this — the browser's own CORS rules stop a page
 * from reading those responses — but the upgrade path has no such protection,
 * so it has to be checked explicitly.
 */

/** Comma-separated extra origins, e.g. a Tailscale `https://host.ts.net:8443`. */
const ENV_KEY = 'AGENTMASTER_ALLOWED_ORIGINS';

function normalize(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/** Loopback spellings a browser may use for the dashboard's own origin. */
function localOrigins(port: number): string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
}

export function allowedOrigins(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env[ENV_KEY] ?? '')
    .split(',')
    .map(normalize)
    .filter((value) => value !== '');
  return [...localOrigins(port).map(normalize), ...extra];
}

/**
 * Whether an upgrade carrying this `Origin` may proceed.
 *
 * A *missing* Origin is allowed: browsers always send one on a WebSocket
 * handshake, so its absence means a non-browser client (a test, a script, a
 * terminal tool), which was never the threat here. Everything else must match
 * the dashboard's own origin or be listed in AGENTMASTER_ALLOWED_ORIGINS.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (origin === undefined || origin === '') return true;
  return allowedOrigins(port, env).includes(normalize(origin));
}
