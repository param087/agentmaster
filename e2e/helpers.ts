import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface CreatedSession {
  id: string;
  title: string;
}

/** Spawns a bash session through the REST API, in an isolated temp folder. */
export async function createSession(
  request: APIRequestContext,
  opts: { cwd?: string; title?: string } = {},
): Promise<CreatedSession> {
  const res = await request.post('/api/sessions', {
    data: { harnessId: 'bash', cwd: opts.cwd ?? '/tmp', ...(opts.title ? { title: opts.title } : {}) },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { session } = (await res.json()) as { session: CreatedSession };
  return session;
}

/** Removes every session so each test starts from an empty dashboard. */
export async function removeAllSessions(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/sessions');
  const { sessions } = (await res.json()) as { sessions: CreatedSession[] };
  for (const s of sessions) await request.post(`/api/sessions/${s.id}/remove`);
}

/** Opens the dashboard on a session with the terminal probe enabled. */
export async function openSession(page: Page, id: string): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('e2e', '1'));
  await page.goto(`/?session=${encodeURIComponent(id)}`);
  await page.waitForFunction(() => 'agentmasterTermReady' in window || '__term' in window);
}

export function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __term: { text: () => string } }).__term.text());
}

export async function expectTerminalToContain(page: Page, text: string): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toContain(text);
}

/** Types into the PTY through xterm's own input element, like a user would. */
export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type(text);
}

export async function runCommand(page: Page, command: string): Promise<void> {
  await typeInTerminal(page, command);
  await page.keyboard.press('Enter');
}
