import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearAvailabilityCache, isCommandAvailable } from '../src/config/availability.js';
import { openDb, type Db } from '../src/db/index.js';

describe('isCommandAvailable', () => {
  let dir: string;
  const originalPath = process.env['PATH'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-avail-'));
    clearAvailabilityCache();
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
    clearAvailabilityCache();
  });

  it('finds an executable on PATH', () => {
    const bin = join(dir, 'fakeharness');
    writeFileSync(bin, '#!/bin/sh\necho hi\n');
    chmodSync(bin, 0o755);
    process.env['PATH'] = dir;
    expect(isCommandAvailable('fakeharness')).toBe(true);
  });

  it('reports a missing command as unavailable', () => {
    process.env['PATH'] = dir;
    expect(isCommandAvailable('definitely-not-installed-xyz')).toBe(false);
  });

  it('ignores a non-executable file of the same name', () => {
    const bin = join(dir, 'notexec');
    writeFileSync(bin, 'text');
    chmodSync(bin, 0o644);
    process.env['PATH'] = dir;
    expect(isCommandAvailable('notexec')).toBe(false);
  });

  it('ignores a directory that shares the command name', () => {
    mkdtempSync(join(dir, 'shadow-'));
    process.env['PATH'] = dir;
    // A directory called `bin` on PATH must not count as the command `bin`.
    expect(isCommandAvailable('shadow-')).toBe(false);
  });

  it('checks an absolute path directly rather than searching PATH', () => {
    const bin = join(dir, 'abs');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    process.env['PATH'] = '';
    expect(isCommandAvailable(bin)).toBe(true);
    expect(isCommandAvailable(join(dir, 'missing'))).toBe(false);
  });

  it('resolves /bin/sh, which exists everywhere this runs', () => {
    expect(isCommandAvailable('/bin/sh')).toBe(true);
  });
});

describe('harness preferences', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('starts with no stored preferences, so callers fall back to availability', () => {
    expect(db.getHarnessPrefs().size).toBe(0);
  });

  it('persists an explicit toggle in both directions', () => {
    db.setHarnessEnabled('opencode', false);
    expect(db.getHarnessPrefs().get('opencode')).toBe(false);

    db.setHarnessEnabled('opencode', true);
    expect(db.getHarnessPrefs().get('opencode')).toBe(true);
  });

  it('upserts rather than duplicating on repeated toggles', () => {
    for (let i = 0; i < 5; i += 1) db.setHarnessEnabled('pi', i % 2 === 0);
    const prefs = db.getHarnessPrefs();
    expect(prefs.size).toBe(1);
    expect(prefs.get('pi')).toBe(true);
  });

  it('keeps preferences for different harnesses independent', () => {
    db.setHarnessEnabled('opencode', false);
    db.setHarnessEnabled('pi', true);
    const prefs = db.getHarnessPrefs();
    expect(prefs.get('opencode')).toBe(false);
    expect(prefs.get('pi')).toBe(true);
  });
});
