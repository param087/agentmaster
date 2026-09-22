import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';

import { createSession, expectTerminalToContain, openSession, removeAllSessions, runCommand } from './helpers';

const PORT = 7392;
const BASE = `http://127.0.0.1:${PORT}`;
const SOCKET = 'agentmaster-e2e-restart';

let dir = '';
let server: ChildProcess | undefined;

/** A second, private server so the test can stop and start it at will. */
async function startServer(): Promise<APIRequestContext> {
  server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: resolve('server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENTMASTER_DB: join(dir, 'db.sqlite'),
      AGENTMASTER_HARNESSES: resolve('e2e/harnesses.yaml'),
      AGENTMASTER_STATE_DIR: join(dir, 'state'),
      AGENTMASTER_TMUX_SOCKET: SOCKET,
      AGENTMASTER_PTY_BACKEND: 'tmux',
    },
    stdio: 'ignore',
  });
  const api = await playwrightRequest.newContext({ baseURL: BASE });
  await expect.poll(async () => (await api.get('/api/health').catch(() => null))?.status(), { timeout: 20_000 }).toBe(200);
  return api;
}

async function stopServer(): Promise<void> {
  const proc = server;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((done) => {
    proc.once('exit', () => done());
    proc.kill('SIGTERM');
  });
}

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'am-e2e-persist-'));
});

test.afterEach(async () => {
  await stopServer();
  try {
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a running session survives a server restart; Delete removes it for good', async ({ page }) => {
  let api = await startServer();
  const res = await api.post('/api/sessions', { data: { harnessId: 'bash', cwd: '/tmp', title: 'survivor' } });
  const { session } = (await res.json()) as { session: { id: string } };
  await api.post(`/api/sessions/${session.id}/input`, { data: { keys: 'echo kept-$((20+22))\r' } });

  await stopServer();
  api = await startServer();

  await page.addInitScript(() => window.localStorage.setItem('e2e', '1'));
  await page.goto(`${BASE}/?session=${session.id}`);
  await page.waitForFunction(() => '__term' in window);
  await expect(page.getByRole('main').getByRole('button', { name: 'survivor' })).toBeVisible();
  await expectTerminalToContain(page, 'kept-42');
  await runCommand(page, 'echo alive-$((50+5))');
  await expectTerminalToContain(page, 'alive-55');

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('complementary').getByText('survivor')).toHaveCount(0);

  await stopServer();
  api = await startServer();
  const { sessions } = (await (await api.get('/api/sessions')).json()) as { sessions: unknown[] };
  expect(sessions).toEqual([]);
});

test('Settings can delete every session at once', async ({ page, request }) => {
  await removeAllSessions(request);
  const a = await createSession(request, { title: 'one' });
  await createSession(request, { title: 'two' });
  await openSession(page, a.id);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Background sessions' });
  await expect(section).toContainText('tmux');
  page.once('dialog', (dialog) => void dialog.accept());
  await section.getByRole('button', { name: 'Delete all sessions' }).click();
  await expect(section).toContainText('Deleted 2 sessions');
  await expect(page.getByRole('complementary').getByText('one', { exact: true })).toHaveCount(0);
});
