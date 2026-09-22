import { describe, expect, it } from 'vitest';

import { classifyDiff, describeCode } from '../src/lib/diff';

describe('classifyDiff', () => {
  it('separates headers, hunks, additions, deletions and context', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '',
    ].join('\n');
    expect(classifyDiff(diff).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add']);
  });
});

describe('describeCode', () => {
  it('names porcelain codes', () => {
    expect(describeCode('??')).toBe('new');
    expect(describeCode(' M')).toBe('modified');
    expect(describeCode('R ')).toBe('renamed');
  });
});
