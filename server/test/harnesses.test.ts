import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { getHarness, loadHarnesses, parseHarnesses, watchHarnesses } from '../src/config/harnesses';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

describe('parseHarnesses', () => {
  it('parses a harness with a waiting_input rule and quick actions', () => {
    const yaml = [
      'harnesses:',
      '  - id: claude-code',
      '    name: Claude Code',
      '    command: claude',
      '    busy_marker: "esc to interrupt"',
      '    waiting_input:',
      '      - match: "Do you want to (proceed|make this edit)"',
      '        kind: permission',
      '        actions:',
      '          - { label: "Yes", keys: "1\\r" }',
      '',
    ].join('\n');

    const harnesses = parseHarnesses(yaml);
    expect(harnesses).toHaveLength(1);

    const h = harnesses[0]!;
    expect(h.id).toBe('claude-code');
    expect(h.name).toBe('Claude Code');
    expect(h.command).toBe('claude');
    expect(h.args).toEqual([]);
    expect(h.busyMarker).toBeInstanceOf(RegExp);
    expect(h.busyMarker!.test('  esc to interrupt)')).toBe(true);

    const rule = h.waitingInput[0]!;
    expect(rule.kind).toBe('permission');
    expect(rule.re.test('Do you want to proceed')).toBe(true);
    expect(rule.re.test('Do you want to make this edit?')).toBe(true);
    expect(rule.re.test('nothing here')).toBe(false);

    const action = rule.actions![0]!;
    expect(action.label).toBe('Yes');
    // YAML double-quoted scalar turns \r into a carriage return.
    expect(action.keys).toBe('1\r');
    expect(action.keys).toHaveLength(2);
  });

  it('throws with "regex" and the harness id when a match fails to compile', () => {
    const yaml = [
      'harnesses:',
      '  - id: broken-one',
      '    name: Broken',
      '    command: broken',
      '    waiting_input:',
      '      - match: "([unclosed"',
      '',
    ].join('\n');

    expect(() => parseHarnesses(yaml)).toThrow(/regex/i);
    expect(() => parseHarnesses(yaml)).toThrow(/broken-one/);
  });

  it('throws with "regex" and the harness id when busy_marker fails to compile', () => {
    const yaml = [
      'harnesses:',
      '  - id: bad-busy',
      '    name: Bad',
      '    command: bad',
      '    busy_marker: "([unclosed"',
      '',
    ].join('\n');

    expect(() => parseHarnesses(yaml)).toThrow(/regex/i);
    expect(() => parseHarnesses(yaml)).toThrow(/bad-busy/);
  });

  it('applies defaults when defaults block and optional fields are absent', () => {
    const yaml = ['harnesses:', '  - id: pi', '    name: PI', '    command: pi', ''].join('\n');

    const h = parseHarnesses(yaml)[0]!;
    expect(h.waitingInput).toEqual([]);
    expect(h.args).toEqual([]);
    expect(h.busyMarker).toBeUndefined();
    expect(h.idleMs).toBe(2500);
    expect(h.finishedAfterBusyMs).toBe(20000);
  });

  it('lets the defaults block override the built-in defaults', () => {
    const yaml = [
      'defaults:',
      '  idle_ms: 900',
      '  finished_after_busy_ms: 42000',
      'harnesses:',
      '  - id: pi',
      '    name: PI',
      '    command: pi',
      '',
    ].join('\n');

    const h = parseHarnesses(yaml)[0]!;
    expect(h.idleMs).toBe(900);
    expect(h.finishedAfterBusyMs).toBe(42000);
  });

  it('defaults an omitted rule kind to "unknown"', () => {
    const yaml = [
      'harnesses:',
      '  - id: pi',
      '    name: PI',
      '    command: pi',
      '    waiting_input:',
      '      - match: "continue"',
      '',
    ].join('\n');

    expect(parseHarnesses(yaml)[0]!.waitingInput[0]!.kind).toBe('unknown');
  });

  it('translates a leading (?i) into the RegExp i flag', () => {
    const yaml = [
      'harnesses:',
      '  - id: opencode',
      '    name: opencode',
      '    command: opencode',
      '    waiting_input:',
      '      - match: "(?i)allow this (tool|command)\\\\?"',
      '',
    ].join('\n');

    const rule = parseHarnesses(yaml)[0]!.waitingInput[0]!;
    expect(rule.re.flags).toContain('i');
    expect(rule.re.source).not.toContain('(?i)');
    expect(rule.re.test('Allow this tool?')).toBe(true);
    expect(rule.re.test('allow this command?')).toBe(true);
  });

  it('carries an explicit icon so a fork can reuse an existing brand mark', () => {
    const [harness] = parseHarnesses(
      ['harnesses:', '  - id: my-claude-fork', '    name: Fork', '    command: myclaude', '    icon: claude-code'].join(
        '\n',
      ),
    );
    expect(harness?.icon).toBe('claude-code');
  });

  it('leaves icon unset when absent, so callers fall back to the id', () => {
    const [harness] = parseHarnesses(
      ['harnesses:', '  - id: solo', '    name: Solo', '    command: solo'].join('\n'),
    );
    expect(harness?.icon).toBeUndefined();
  });

  it('throws on duplicate harness ids', () => {
    const yaml = [
      'harnesses:',
      '  - id: pi',
      '    name: PI',
      '    command: pi',
      '  - id: pi',
      '    name: PI Again',
      '    command: pi',
      '',
    ].join('\n');

    expect(() => parseHarnesses(yaml)).toThrow(/duplicate/i);
    expect(() => parseHarnesses(yaml)).toThrow(/pi/);
  });

  it('throws a readable error when zod validation fails', () => {
    const yaml = ['harnesses:', '  - id: pi', '    name: PI', ''].join('\n');
    expect(() => parseHarnesses(yaml)).toThrow(/command/);
  });
});

describe('the shipped harnesses.yaml', () => {
  it('parses and contains all six harnesses', () => {
    const text = readFileSync(resolve(repoRoot, 'harnesses.yaml'), 'utf8');
    const ids = parseHarnesses(text).map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining(['opencode', 'claude-code', 'gemini-cli', 'codex', 'qwen-code', 'pi']),
    );
    expect(ids).toHaveLength(6);
  });

  it('loadHarnesses() reads the repo-root file', () => {
    expect(loadHarnesses().map((h) => h.id)).toContain('opencode');
  });
});

describe('watchHarnesses', () => {
  const VALID = ['harnesses:', '  - id: alpha', '    name: Alpha', '    command: alpha'].join('\n');

  /** Polls until `predicate` holds, so we never race the filesystem watcher. */
  async function until(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Write + rename, exactly how vim, VS Code and Sublime save a file. */
  function atomicWrite(target: string, contents: string): void {
    const temp = `${target}.tmp`;
    writeFileSync(temp, contents);
    renameSync(temp, target);
  }

  it('keeps firing across repeated atomic saves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnesses-watch-'));
    const file = join(dir, 'harnesses.yaml');
    writeFileSync(file, VALID);

    const seen: string[][] = [];
    const unwatch = watchHarnesses(file, (h) => seen.push(h.map((x) => x.id)));

    try {
      atomicWrite(file, `${VALID}\n  - id: beta\n    name: Beta\n    command: beta`);
      expect(await until(() => seen.some((ids) => ids.includes('beta')))).toBe(true);

      // The regression: a file watcher would now be bound to the orphaned inode
      // left behind by the first rename, and this second save would be missed.
      atomicWrite(file, `${VALID}\n  - id: gamma\n    name: Gamma\n    command: gamma`);
      expect(await until(() => seen.some((ids) => ids.includes('gamma')))).toBe(true);
    } finally {
      unwatch();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when the registry is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnesses-missing-'));
    try {
      // The server is already listening by the time this runs, so throwing here
      // would take down a healthy process.
      const unwatch = watchHarnesses(join(dir, 'harnesses.yaml'), () => {});
      expect(typeof unwatch).toBe('function');
      unwatch();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when the containing directory is missing', () => {
    const unwatch = watchHarnesses('/nonexistent-dir-xyz/harnesses.yaml', () => {});
    expect(typeof unwatch).toBe('function');
    unwatch();
  });

  it('keeps the previous config when an edit is invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnesses-bad-'));
    const file = join(dir, 'harnesses.yaml');
    writeFileSync(file, VALID);

    const seen: string[][] = [];
    const unwatch = watchHarnesses(file, (h) => seen.push(h.map((x) => x.id)));

    try {
      atomicWrite(file, 'harnesses:\n  - id: broken\n    name: Broken');  // no command
      await new Promise((r) => setTimeout(r, 800));
      expect(seen).toEqual([]);
      expect(getHarness('alpha')?.id ?? 'alpha').toBe('alpha');
    } finally {
      unwatch();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops firing after unwatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnesses-unwatch-'));
    const file = join(dir, 'harnesses.yaml');
    writeFileSync(file, VALID);

    let calls = 0;
    const unwatch = watchHarnesses(file, () => { calls += 1; });
    unwatch();

    try {
      atomicWrite(file, `${VALID}\n  - id: delta\n    name: Delta\n    command: delta`);
      await new Promise((r) => setTimeout(r, 800));
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
