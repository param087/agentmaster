#!/usr/bin/env node
// node-pty ships spawn-helper without the executable bit when npm blocks
// dependency install scripts (npm >= 11 default). Without +x, every
// pty.spawn() fails with "posix_spawnp failed".
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

for (const p of platforms) {
  const helper = join(root, 'node_modules/node-pty/prebuilds', p, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
const built = join(root, 'node_modules/node-pty/build/Release/spawn-helper');
if (existsSync(built)) chmodSync(built, 0o755);
