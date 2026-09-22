export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Classifies unified-diff lines for colouring. Headers before the first hunk are `meta`. */
export function classifyDiff(diff: string): DiffLine[] {
  let inHunk = false;
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .filter((line, i, all) => !(line === '' && i === all.length - 1))
    .map((text) => {
      if (text.startsWith('@@')) {
        inHunk = true;
        return { kind: 'hunk', text };
      }
      if (!inHunk || text.startsWith('diff --git')) {
        inHunk = text.startsWith('diff --git') ? false : inHunk;
        return { kind: 'meta', text };
      }
      if (text.startsWith('+')) return { kind: 'add', text };
      if (text.startsWith('-')) return { kind: 'del', text };
      return { kind: 'context', text };
    });
}

/** Human label for a porcelain status code. */
export function describeCode(code: string): string {
  if (code === '??') return 'new';
  const c = code.trim()[0];
  switch (c) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflict';
    default:
      return code.trim() || 'changed';
  }
}
