#!/usr/bin/env node
/**
 * Live end-to-end scenario matrix against real harnesses.
 *
 * Exercises the whole status journey through the real HTTP + WebSocket API:
 * startup -> busy -> done -> acknowledge -> waiting_input -> killed.
 */
import WebSocket from 'ws';

const API = 'http://127.0.0.1:7180';
const CWD = '/tmp/amtest';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  id: string;
  status: string;
  waitKind?: string;
  matchedRule?: string;
  actions?: { label: string; keys: string }[];
}

async function create(harnessId: string): Promise<string> {
  const r = await fetch(`${API}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harnessId, cwd: CWD }),
  });
  if (!r.ok) throw new Error(`create ${harnessId}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { session: Session }).session.id;
}

async function get(id: string): Promise<Session> {
  const r = await fetch(`${API}/api/sessions`);
  const { sessions } = (await r.json()) as { sessions: Session[] };
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new Error(`session ${id} gone`);
  return s;
}

const input = (id: string, keys: string) =>
  fetch(`${API}/api/sessions/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys }),
  });

/** Polls until the status matches, or gives up. Returns the final session. */
async function waitFor(id: string, want: string, timeoutMs = 90_000): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const s = await get(id);
    if (s.status !== last) {
      process.stdout.write(`      ${last || '(start)'} -> ${s.status}\n`);
      last = s.status;
    }
    if (s.status === want) return s;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${want}, stuck at ${last}`);
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Opens a viewer socket, as the browser does when you select a session. */
function attach(id: string): Promise<WebSocket> {
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws/term/${id}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve) => ws.on('open', () => resolve(ws)));
}

async function scenario(harnessId: string, turnPrompt: string, menuKeys?: string): Promise<void> {
  console.log(`\n=== ${harnessId} ===`);
  const id = await create(harnessId);

  console.log('  [1] startup should settle to idle, not green');
  const started = await waitFor(id, 'idle', 40_000);
  check('startup -> idle', started.status === 'idle');

  console.log('  [2] a submitted turn, unwatched, should go DONE (green)');
  await input(id, turnPrompt);
  const done = await waitFor(id, 'done');
  check('submitted turn -> done', done.status === 'done');

  console.log('  [3] opening the session should acknowledge it back to idle');
  const ws = await attach(id);
  await sleep(1200);
  const acked = await get(id);
  check('attach acknowledges done -> idle', acked.status === 'idle', `now ${acked.status}`);
  ws.close();
  await sleep(500);

  if (menuKeys) {
    console.log('  [4] a selection widget should go WAITING_INPUT (amber)');
    await input(id, menuKeys);
    const waiting = await waitFor(id, 'waiting_input', 120_000);
    check('menu -> waiting_input', waiting.status === 'waiting_input');
    check('waitKind is menu', waiting.waitKind === 'menu', String(waiting.waitKind));
    check('matchedRule reported', Boolean(waiting.matchedRule), waiting.matchedRule ?? 'none');
    check('quick actions present', (waiting.actions?.length ?? 0) > 0,
      JSON.stringify(waiting.actions));

    console.log('  [5] dismissing the widget should leave waiting_input');
    await input(id, '\u001b');
    await sleep(4000);
    const after = await get(id);
    check('dismiss leaves waiting_input', after.status !== 'waiting_input', `now ${after.status}`);
  }

  console.log('  [6] Kill should report KILLED, not exited');
  await fetch(`${API}/api/sessions/${id}`, { method: 'DELETE' });
  const killed = await waitFor(id, 'killed', 20_000);
  check('kill -> killed', killed.status === 'killed');

  await fetch(`${API}/api/sessions/${id}/remove`, { method: 'POST' });
}

await scenario('opencode', 'say hi in exactly one word\r',
  'Ask me a multiple choice question about which database to use. Use your question tool.\r');
await scenario('pi', 'say hi in exactly one word\r', '/');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
