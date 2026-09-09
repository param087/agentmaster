// @xterm/headless ships a CJS UMD bundle with no ESM export map, so Node's
// cjs-module-lexer cannot statically detect the `Terminal` named export and a
// named import throws at load time under plain node/tsx. Vite/Vitest papers
// over this with its own interop, which is why the test suite never sees it.
// Default-import then destructure works in both.
import xtermHeadless from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';

const { Terminal } = xtermHeadless;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const SCROLLBACK = 200;

/**
 * Headless terminal emulator wrapper.
 *
 * Status detection regexes must run against the *rendered* screen, not the raw
 * PTY byte stream: harnesses repeatedly overwrite the same line with `\r\x1b[K`,
 * so erased text ("Thinking…") stays in the stream forever while being visually
 * gone. Feeding the stream through xterm and reading the character grid back is
 * the only way to see what the user actually sees.
 */
export class ScreenModel {
  private readonly term: TerminalType;

  constructor(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: SCROLLBACK });
  }

  /**
   * xterm's write is asynchronous and batched; the promise resolves only once
   * the data has been parsed into the buffer. Callers must await it before
   * reading `text()` / `tail()` or they will observe a stale screen.
   */
  write(data: string | Uint8Array): Promise<void> {
    const payload = typeof data === 'string' ? data : toPlainBytes(data);
    return new Promise<void>((resolve) => {
      this.term.write(payload, resolve);
    });
  }

  /** Full visible screen, rows joined by '\n', trailing blank lines dropped. */
  text(): string {
    return this.visibleLines().join('\n');
  }

  /** Last `n` visible lines (after trailing blanks are dropped). */
  tail(n: number): string {
    if (n <= 0) return '';
    const lines = this.visibleLines();
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  reset(): void {
    this.term.reset();
  }

  dispose(): void {
    this.term.dispose();
  }

  private visibleLines(): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
}

/**
 * xterm's typings accept `Uint8Array`, but `Buffer` is a subclass whose
 * `.buffer` may be a shared pooled ArrayBuffer. Copy into a plain Uint8Array so
 * the parser never sees neighbouring pool bytes.
 */
function toPlainBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}
