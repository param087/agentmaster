import { describe, expect, it } from 'vitest';

import { allowedOrigins, isAllowedOrigin } from '../src/ws/origin.js';

const PORT = 7180;
const noEnv: NodeJS.ProcessEnv = {};

describe('isAllowedOrigin', () => {
  it('accepts every loopback spelling of the dashboard itself', () => {
    for (const origin of [
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
      `http://[::1]:${PORT}`,
    ]) {
      expect(isAllowedOrigin(origin, PORT, noEnv)).toBe(true);
    }
  });

  it('rejects a foreign origin — the cross-site hijack this exists to stop', () => {
    expect(isAllowedOrigin('https://evil.example', PORT, noEnv)).toBe(false);
  });

  it('rejects the right host on the wrong port', () => {
    // Another local service must not be able to drive our PTYs.
    expect(isAllowedOrigin('http://localhost:3000', PORT, noEnv)).toBe(false);
  });

  it('rejects a look-alike host', () => {
    expect(isAllowedOrigin(`http://localhost.evil.example:${PORT}`, PORT, noEnv)).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1.evil.example:${PORT}`, PORT, noEnv)).toBe(false);
  });

  it('rejects https on the loopback origin, which the dashboard never serves', () => {
    expect(isAllowedOrigin(`https://localhost:${PORT}`, PORT, noEnv)).toBe(false);
  });

  it('allows a missing origin, which only a non-browser client sends', () => {
    // Browsers always set Origin on a WebSocket handshake, so its absence is
    // not the threat being defended against here.
    expect(isAllowedOrigin(undefined, PORT, noEnv)).toBe(true);
    expect(isAllowedOrigin('', PORT, noEnv)).toBe(true);
  });

  it('honours an extra origin, as the Tailscale tunnel needs', () => {
    const env = { AGENTMASTER_ALLOWED_ORIGINS: 'https://host.ts.net:8443' };
    expect(isAllowedOrigin('https://host.ts.net:8443', PORT, env)).toBe(true);
    // The port is part of the origin: the same host on another port is not it.
    expect(isAllowedOrigin('https://host.ts.net', PORT, env)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', PORT, env)).toBe(false);
  });

  it('accepts several extra origins and tolerates spacing and trailing slashes', () => {
    const env = { AGENTMASTER_ALLOWED_ORIGINS: ' https://a.ts.net:8443/ , https://b.ts.net:8443 ' };
    expect(isAllowedOrigin('https://a.ts.net:8443', PORT, env)).toBe(true);
    expect(isAllowedOrigin('https://b.ts.net:8443', PORT, env)).toBe(true);
  });

  it('ignores empty entries rather than allowing everything', () => {
    const env = { AGENTMASTER_ALLOWED_ORIGINS: ',,  ,' };
    expect(allowedOrigins(PORT, env)).toHaveLength(3);
    expect(isAllowedOrigin('https://evil.example', PORT, env)).toBe(false);
  });

  it('compares case-insensitively, as hostnames are', () => {
    expect(isAllowedOrigin(`HTTP://LOCALHOST:${PORT}`, PORT, noEnv)).toBe(true);
  });

  it('tracks the port it is given', () => {
    expect(isAllowedOrigin('http://localhost:9999', 9999, noEnv)).toBe(true);
    expect(isAllowedOrigin('http://localhost:9999', PORT, noEnv)).toBe(false);
  });
});
