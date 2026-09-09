#!/usr/bin/env node
/**
 * Serves agentmaster to your phone over Tailscale.
 *
 *   npm run mobile
 *
 * Tailscale terminates TLS and reverse-proxies to 127.0.0.1, so the server
 * keeps binding to localhost only — that is strictly safer than binding
 * 0.0.0.0, and it is why nothing about the server needs to change here.
 *
 * HTTPS matters beyond privacy: service workers and the Web Push API only work
 * in a secure context, so push notifications on the phone depend on the ts.net
 * certificate rather than a raw tailnet IP.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT ?? 7180);
const HTTPS_PORT = Number(process.env.TS_PORT ?? 8443);

function ts(args, opts = {}) {
  return execFileSync('tailscale', args, { encoding: 'utf8', ...opts }).trim();
}

function fail(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// --- preflight -------------------------------------------------------------

let status;
try {
  status = JSON.parse(ts(['status', '--json']));
} catch {
  fail('Tailscale is not running or not installed.', 'Install it, then `tailscale up`.');
}

const self = status.Self ?? {};
const host = (self.DNSName ?? '').replace(/\.$/, '');
if (!host) fail('No MagicDNS name for this machine.', 'Enable MagicDNS in the Tailscale admin console.');

// Without HTTPS certs there is no secure context, so no service worker and no
// push — the phone would be able to view sessions but never notify.
const certs = status.CertDomains ?? [];
if (!certs.includes(host)) {
  fail(
    `HTTPS certificates are not enabled for ${host}.`,
    'Enable HTTPS in the Tailscale admin console (DNS → HTTPS Certificates). Push needs it.',
  );
}

if (!existsSync(join(ROOT, 'web/dist/index.html'))) {
  fail('web/dist is missing.', 'Run `npm run build` first — `npm run mobile` does this for you.');
}

// Someone else may already own `/` on this tailnet host (opencode serves its own
// UI there, for one), so agentmaster takes a dedicated HTTPS port rather than a
// path prefix. Path prefixes would also need base-path rewriting for assets and
// WebSocket URLs, which is a lot of fragility for no benefit.
const url = `https://${host}:${HTTPS_PORT}`;

// --- serve -----------------------------------------------------------------

console.log(`\n  starting agentmaster on 127.0.0.1:${PORT}`);
const server = spawn('npm', ['start'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });

const shutdown = () => {
  try {
    ts(['serve', '--https', String(HTTPS_PORT), 'off']);
    console.log('  tunnel closed');
  } catch {
    // Nothing to undo.
  }
  server.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await new Promise((r) => setTimeout(r, 2500));

try {
  ts(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${PORT}`]);
} catch (error) {
  fail(`Could not start the tunnel: ${error.message}`);
}

console.log(`\n  ${url}\n`);
try {
  // Scannable straight from the phone; no typing a ts.net hostname by hand.
  console.log(execFileSync('npx', ['--yes', 'qrcode-terminal', url], { encoding: 'utf8' }));
} catch {
  console.log('  (install qrcode-terminal for a scannable code)');
}

console.log('  Tailnet devices only — nothing is exposed to the internet.');
console.log('  On iPhone: open the URL in Safari, Share → Add to Home Screen.');
console.log('  iOS only allows web push for sites installed to the Home Screen.\n');
console.log('  Ctrl-C to stop and close the tunnel.\n');
