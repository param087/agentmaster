import { expect, test } from '@playwright/test';

import { createSession, openSession, removeAllSessions } from './helpers';

test.beforeEach(async ({ request }) => removeAllSessions(request));

test('a blocked session shows its screen in the attention queue', async ({ page, request }) => {
  const blocked = await createSession(request, { title: 'blocked' });
  const watching = await createSession(request, { title: 'watching' });
  // Printed via printf so the marker only appears in the output, not the echo.
  await request.post(`/api/sessions/${blocked.id}/input`, {
    data: { keys: 'printf "deploying\\nProceed%s [y/n] " "?"; read answer\r' },
  });

  await openSession(page, watching.id);
  const queue = page.getByRole('region', { name: 'Needs attention' });
  await expect(queue).toContainText('blocked', { timeout: 10_000 });
  const preview = queue.getByLabel('Screen of blocked');
  await expect(preview).toContainText('deploying');
  await expect(preview).toContainText('Proceed? [y/n]');
});
