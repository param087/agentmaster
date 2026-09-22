import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 7390;
const BASE = `http://127.0.0.1:${PORT}`;
// Absolute: `npm start` runs the server from its own workspace directory.
const TMP = resolve('e2e/.tmp');
const HARNESSES = resolve('e2e/harnesses.yaml');

/**
 * End-to-end suite: a production build served by the real server, with an
 * isolated database and a bash-only harness registry, on its own port so it
 * never collides with a dev instance on 7180.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  use: { baseURL: BASE, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    command:
      `rm -rf "${TMP}" && mkdir -p "${TMP}" && npm run build && ` +
      `PORT=${PORT} AGENTMASTER_DB="${TMP}/db.sqlite" AGENTMASTER_HARNESSES="${HARNESSES}" npm start`,
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
