import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The existing suite exercises the classic direct PTY; tmux persistence
    // has its own tests that opt in explicitly.
    env: { AGENTMASTER_PTY_BACKEND: 'direct' },
  },
});
