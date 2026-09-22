import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => {
  await removeAllSessions(request);
  await request.put('/api/settings', { data: { pruneAfterHours: null } });
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings', { data: { pruneAfterHours: null } });
});

test('auto-prune removes long-stopped sessions once enabled', async ({ page, request }) => {
  const stopped = await createSession(request, { title: 'stopped' });
  const live = await createSession(request, { title: 'live' });
  await request.delete(`/api/sessions/${stopped.id}`);
  // Interactive bash ignores SIGTERM; the kill escalates to SIGKILL after 3s.
  await expect
    .poll(async () => {
      const { sessions } = (await (await request.get('/api/sessions')).json()) as { sessions: Array<{ id: string; status: string }> };
      return sessions.find((s) => s.id === stopped.id)?.status;
    }, { timeout: 10_000 })
    .toBe('killed');
  await openSession(page, live.id);
  await expect(page.getByRole('complementary').getByText('stopped')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Housekeeping' }).getByRole('combobox').selectOption('After 1 hour');
  // Not old enough yet: nothing disappears.
  await expect(page.getByRole('complementary').getByText('stopped')).toBeVisible();

  // A threshold of ~0 (via API) prunes it immediately; the live one survives.
  const res = await request.put('/api/settings', { data: { pruneAfterHours: 0.00001 } });
  expect(res.status(), await res.text()).toBe(200);
  await expect(page.getByRole('complementary').getByText('stopped')).toHaveCount(0);
  await expect(page.getByRole('complementary').getByText('live', { exact: true })).toBeVisible();
});
