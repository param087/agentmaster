import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * The PTY is fixed at 120x32 server-side so two browsers viewing the same
 * session can never fight over its geometry. The client therefore never fits —
 * it scales (see `TerminalView`).
 */
export const TERM_COLS = 120;
export const TERM_ROWS = 32;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

/** Server closes with 4004 when the session id is unknown. Retrying cannot help. */
const CLOSE_UNKNOWN_SESSION = 4004;
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;

/** Mirrors the palette in `index.css`. */
const TERMINAL_THEME = {
  background: '#0a0b0d',
  foreground: '#e2e6ea',
  cursor: '#5b9dff',
  cursorAccent: '#0a0b0d',
  selectionBackground: '#2f5c9e',
  black: '#16191d',
  red: '#f0553c',
  green: '#5fc27e',
  yellow: '#f0a52e',
  blue: '#4c8dff',
  magenta: '#c98bff',
  cyan: '#4ecdc4',
  white: '#c3cad3',
  brightBlack: '#4d5661',
  brightRed: '#ff7a66',
  brightGreen: '#87dda2',
  brightYellow: '#ffc766',
  brightBlue: '#7db1ff',
  brightMagenta: '#dcb0ff',
  brightCyan: '#7fe3dc',
  brightWhite: '#f5f7f9',
} as const;

/**
 * How long alt-tabbing must settle before a focus frame goes out.
 *
 * Switching windows fires `blur` then `visibilitychange` then `focus` in quick
 * succession; without this the server would see a burst of contradictory
 * frames for a single user action.
 */
const FOCUS_DEBOUNCE_MS = 150;

/** A control message on the terminal socket. Sent as a TEXT frame, never binary. */
export type TerminalControlMessage = { type: 'focus'; focused: boolean };

export interface UseTerminalResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  connected: boolean;
  error: string | null;
  /** Writes verbatim to the PTY, exactly as if typed. Used by quick actions. */
  send: (data: string) => void;
  /** Sends a JSON control message. Never reaches the PTY. */
  sendControl: (message: TerminalControlMessage) => void;
  /**
   * Installs a one-shot transform over the *next* chunk the user types.
   *
   * This exists for the virtual key bar's sticky `Ctrl`: the letter that
   * follows it comes from the phone's soft keyboard, i.e. through xterm's own
   * `onData`, not through `send`. Rewriting it here keeps a single input path —
   * the alternative would be a second, divergent keyboard implementation.
   *
   * Consumed and cleared automatically after one chunk. Pass `null` to cancel.
   */
  setInputTransform: (transform: ((data: string) => string) | null) => void;
  /**
   * Scrolls the scrollback by `delta` lines (negative scrolls towards older
   * output). On the alternate screen there *is* no scrollback — a full-screen
   * TUI owns the whole grid — so the request is translated into cursor keys,
   * which is what a native terminal's "alternate scroll mode" does.
   */
  scrollLines: (delta: number) => void;
  /** Jumps back to live output. */
  scrollToBottom: () => void;
  /** False while the user is looking at scrollback. Always true on the alt screen. */
  atBottom: boolean;
  /** Plain text of scrollback + screen, trailing whitespace trimmed per line. */
  exportText: () => string;
  /** The same, as a standalone coloured HTML document. */
  exportHtml: () => string;
  /** Whether the program in the PTY has enabled bracketed paste (DECSET 2004). */
  bracketedPaste: () => boolean;
  /** Finds `query` in the scrollback; returns false when there is no match. */
  search: (query: string, direction: 'next' | 'previous', options?: SearchOptions) => boolean;
  clearSearch: () => void;
  /** Match position for the last search; `null` until one has run. */
  searchResults: SearchResults | null;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  /** Keep the current match if it still matches — used while typing. */
  incremental?: boolean;
}

export interface SearchResults {
  /** Zero-based, or -1 when the cursor match is beyond the highlight limit. */
  index: number;
  count: number;
}

/** Highlight colours for search matches, in the terminal palette. */
const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#4d5661',
  matchBorder: '#4d5661',
  matchOverviewRuler: '#f0a52e',
  activeMatchBackground: '#f0a52e',
  activeMatchBorder: '#ffc766',
  activeMatchColorOverviewRuler: '#ffc766',
};

/**
 * Control messages the *server* sends, as text frames.
 *
 * `reset` arrives when a session is restarted in place: the terminal is still
 * showing the dead run's output, and without clearing it the new run's output
 * would be appended to a corpse.
 */
type ServerControlMessage = { type: 'reset' };

function handleControl(raw: string, term: Terminal): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return; // Unparseable control is ignored, never rendered.
  }
  if (typeof message !== 'object' || message === null) return;
  const { type } = message as Partial<ServerControlMessage>;
  if (type === 'reset') term.reset();
}

/**
 * Whether the user can actually see this tab.
 *
 * Both halves matter: a visible tab in an unfocused window is not being looked
 * at, and that is exactly the case that used to auto-acknowledge alerts.
 */
function isViewerFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * An explicit PTY geometry requested by the user via "Fit to screen".
 *
 * `null` means "leave the PTY alone", which is the default and the safe one:
 * the server only resizes when *both* `cols` and `rows` are present on the
 * query string, and a resize is visible to every other viewer of the session.
 */
export interface TerminalDims {
  cols: number;
  rows: number;
}

/**
 * Read-only terminal probe for the e2e suite, enabled by `localStorage.e2e`.
 *
 * The WebGL renderer paints to a canvas, so there is no DOM text to assert on;
 * this exposes the buffer instead. Never enabled for real users.
 */
interface TerminalProbe {
  text: () => string;
  viewportY: () => number;
  baseY: () => number;
  bufferType: () => string;
}

function exposeForTests(term: Terminal, sessionId: string): () => void {
  let enabled = false;
  try {
    enabled = window.localStorage.getItem('e2e') === '1';
  } catch {
    return () => {};
  }
  if (!enabled) return () => {};
  const probe: TerminalProbe = {
    text: () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i += 1) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    viewportY: () => term.buffer.active.viewportY,
    baseY: () => term.buffer.active.baseY,
    bufferType: () => term.buffer.active.type,
  };
  const host = window as unknown as { __term?: TerminalProbe; __terms?: Record<string, TerminalProbe> };
  host.__term = probe;
  host.__terms = { ...host.__terms, [sessionId]: probe };
  return () => {
    if (host.__term === probe) delete host.__term;
    if (host.__terms?.[sessionId] === probe) delete host.__terms[sessionId];
  };
}

/**
 * The byte sequence for an arrow key. Programs that enable application cursor
 * keys (DECCKM, `ESC [ ? 1 h`) — vim, less, most TUIs — expect `ESC O A`;
 * everything else expects `ESC [ A`.
 */
export function arrowKey(direction: 'up' | 'down', applicationMode: boolean): string {
  const final = direction === 'up' ? 'A' : 'B';
  return applicationMode ? `\x1bO${final}` : `\x1b[${final}`;
}

function terminalUrl(sessionId: string, dims: TerminalDims | null): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${scheme}://${window.location.host}/ws/term/${encodeURIComponent(sessionId)}`;
  if (!dims) return base;
  return `${base}?cols=${dims.cols}&rows=${dims.rows}`;
}

/**
 * Owns an xterm.js instance and a binary WebSocket to `/ws/term/:id`.
 *
 * Bytes are forwarded verbatim in both directions — no decoding, no line
 * buffering — which is what makes arrow keys, `⇧Tab`, `/model` and Ctrl-C work.
 */
export function useTerminal(
  sessionId: string | null,
  dims: TerminalDims | null = null,
): UseTerminalResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const inputTransformRef = useRef<((data: string) => string) | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Destructured so the effect depends on the numbers, not on the identity of a
  // freshly-built object — otherwise every parent render would tear the
  // terminal down and reconnect the socket.
  const cols = dims?.cols ?? TERM_COLS;
  const rows = dims?.rows ?? TERM_ROWS;
  const explicitDims = dims !== null;

  useEffect(() => {
    setConnected(false);
    setError(null);
    if (!sessionId) return;

    const container = containerRef.current;
    if (!container) return;

    // Guards every async continuation (socket callbacks, reconnect timers)
    // against a teardown that already happened — including StrictMode's
    // deliberate mount/unmount/mount cycle in development.
    let cancelled = false;

    // A previous StrictMode pass may have left its element behind mid-dispose.
    container.replaceChildren();

    const term = new Terminal({
      cols,
      rows,
      convertEol: false,
      scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      allowProposedApi: true,
      cursorBlink: true,
      theme: { ...TERMINAL_THEME },
    });

    term.open(container);
    termRef.current = term;
    const unexpose = exposeForTests(term, sessionId);

    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);
    serializeRef.current = serializeAddon;

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchRef.current = searchAddon;
    setSearchResults(null);
    const searchListener = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!cancelled) setSearchResults({ index: resultIndex, count: resultCount });
    });

    // ---- scroll position tracking ----------------------------------------
    //
    // Drives the "jump to live" affordance. The alt screen has no scrollback,
    // so it is always "at the bottom" by definition.
    const syncAtBottom = (): void => {
      if (cancelled) return;
      const buffer = term.buffer.active;
      setAtBottom(buffer.type === 'alternate' || buffer.viewportY >= buffer.baseY);
    };
    const scrollListener = term.onScroll(syncAtBottom);
    const writeListener = term.onWriteParsed(syncAtBottom);
    const bufferListener = term.buffer.onBufferChange(syncAtBottom);
    syncAtBottom();

    // WebGL context creation genuinely fails on some machines and in some
    // remote-display setups; falling back to the canvas renderer is far better
    // than white-screening the app.
    //
    // Loaded on the next frame rather than inline: `term.open()` starts async
    // font measurement, and attaching WebGL before that settles binds the
    // renderer to a half-measured grid.
    let webgl: WebglAddon | null = null;
    // Imported on demand: the renderer is a sizeable chunk and only useful once
    // a terminal is actually on screen.
    const webglFrame = requestAnimationFrame(() => {
      if (cancelled || container.clientWidth === 0) return;
      void import('@xterm/addon-webgl')
        .then(({ WebglAddon: Addon }) => {
          if (cancelled) return;
          const addon = new Addon();
          addon.onContextLoss(() => {
            addon.dispose();
            if (webgl === addon) webgl = null;
          });
          term.loadAddon(addon);
          webgl = addon;
        })
        .catch((cause: unknown) => {
          console.warn('[terminal] WebGL renderer unavailable, using canvas', cause);
        });
    });

    const encoder = new TextEncoder();
    const dataListener = term.onData((raw) => {
      const ws = socketRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      // Read-and-clear before applying, so a transform that throws cannot latch
      // itself permanently over the user's keyboard.
      const transform = inputTransformRef.current;
      inputTransformRef.current = null;
      const data = transform ? transform(raw) : raw;
      ws.send(encoder.encode(data));
    });

    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // ---- focus reporting -------------------------------------------------
    //
    // The server treats a session as unwatched until a `focused: true` arrives,
    // which is the safe default: an unwatched session keeps its amber alert
    // instead of being silently acknowledged by a background tab.
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    // `undefined` (not `false`) so the first push always transmits — the socket
    // starts unfocused server-side and we must not suppress the opening `true`.
    let reportedFocus: boolean | undefined;

    /** Sends a TEXT frame. Binary is reserved for keystrokes. */
    const sendControlFrame = (message: TerminalControlMessage): void => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const pushFocus = (): void => {
      if (cancelled) return;
      const focused = isViewerFocused();
      if (focused === reportedFocus) return;
      const ws = socketRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      reportedFocus = focused;
      sendControlFrame({ type: 'focus', focused });
    };

    const scheduleFocusPush = (): void => {
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      focusTimer = setTimeout(pushFocus, FOCUS_DEBOUNCE_MS);
    };

    // `visibilitychange` only fires on `document`; `focus`/`blur` do not bubble
    // to `document`, so both targets are needed.
    document.addEventListener('visibilitychange', scheduleFocusPush);
    window.addEventListener('focus', scheduleFocusPush);
    window.addEventListener('blur', scheduleFocusPush);

    const connect = (): void => {
      if (cancelled) return;

      const ws = new WebSocket(
        terminalUrl(sessionId, explicitDims ? { cols, rows } : null),
      );
      ws.binaryType = 'arraybuffer';
      socketRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        setConnected(true);
        setError(null);
        // A fresh socket is unfocused server-side regardless of what the last
        // one reported, so forget the previous value before pushing.
        reportedFocus = undefined;
        pushFocus();
      };

      ws.onmessage = (event: MessageEvent<unknown>) => {
        if (cancelled) return;
        // Opcode decides meaning, in both directions: binary is terminal bytes,
        // text is control. Only binary is ever written to xterm, so a control
        // message can never be rendered as garbage in the user's session.
        if (event.data instanceof ArrayBuffer) {
          // The first frame is the replayed scrollback; the rest is live output.
          term.write(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data === 'string') handleControl(event.data, term);
      };

      ws.onerror = () => {
        // `onclose` always follows and carries the actionable code.
      };

      ws.onclose = (event: CloseEvent) => {
        if (cancelled) return;
        setConnected(false);
        if (socketRef.current === ws) socketRef.current = null;

        if (event.code === CLOSE_UNKNOWN_SESSION) {
          setError('Session not found');
          return;
        }
        if (event.code === CLOSE_NORMAL || event.code === CLOSE_GOING_AWAY) return;

        attempts += 1;
        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          setError('Disconnected from server');
          return;
        }
        setError(`Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})…`);
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (focusTimer !== undefined) clearTimeout(focusTimer);

      document.removeEventListener('visibilitychange', scheduleFocusPush);
      window.removeEventListener('focus', scheduleFocusPush);
      window.removeEventListener('blur', scheduleFocusPush);

      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        // Closing the socket detaches the viewer server-side, which clears its
        // focus too — so an explicit `focused: false` here would be redundant.
        // Drop handlers first so a close during teardown cannot schedule a retry.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }

      cancelAnimationFrame(webglFrame);
      dataListener.dispose();
      scrollListener.dispose();
      writeListener.dispose();
      bufferListener.dispose();
      webgl?.dispose();
      unexpose();
      searchListener.dispose();
      searchRef.current = null;
      serializeRef.current = null;
      termRef.current = null;
      // Leaking a terminal leaks a WebGL context and a canvas; twenty session
      // switches would exhaust the browser's context pool.
      term.dispose();
    };
  }, [sessionId, cols, rows, explicitDims]);

  // Keystrokes are BINARY. A string here would be read as a control message by
  // the server and silently dropped, so the user's typing would vanish.
  const send = useCallback((data: string): void => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  }, []);

  // Control messages are TEXT. Never routed to the PTY.
  const sendControl = useCallback((message: TerminalControlMessage): void => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const setInputTransform = useCallback(
    (transform: ((data: string) => string) | null): void => {
      inputTransformRef.current = transform;
    },
    [],
  );

  const scrollLines = useCallback((delta: number): void => {
    const term = termRef.current;
    if (!term || delta === 0) return;
    if (term.buffer.active.type === 'alternate') {
      // Full-screen TUIs (Claude Code, vim, less, tmux) keep no scrollback of
      // their own: the only way to move within them is to give them the key
      // they already understand, in the form they asked for (DECCKM).
      const key = arrowKey(delta < 0 ? 'up' : 'down', term.modes.applicationCursorKeysMode);
      send(key.repeat(Math.min(Math.abs(delta), 20)));
      return;
    }
    term.scrollLines(delta);
  }, [send]);

  const scrollToBottom = useCallback((): void => {
    termRef.current?.scrollToBottom();
  }, []);

  const search = useCallback(
    (query: string, direction: 'next' | 'previous', options: SearchOptions = {}): boolean => {
      const addon = searchRef.current;
      if (!addon) return false;
      if (query === '') {
        addon.clearDecorations();
        setSearchResults(null);
        return false;
      }
      const opts: ISearchOptions = { ...options, decorations: SEARCH_DECORATIONS };
      try {
        return direction === 'next' ? addon.findNext(query, opts) : addon.findPrevious(query, opts);
      } catch {
        // An invalid regex mid-typing ("foo(") is not an error worth surfacing.
        setSearchResults({ index: -1, count: 0 });
        return false;
      }
    },
    [],
  );

  const exportText = useCallback((): string => {
    const term = termRef.current;
    if (!term) return '';
    const buffer = term.buffer.normal;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // Wrapped rows continue the previous logical line rather than start one.
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return `${lines.join('\n')}\n`;
  }, []);

  const exportHtml = useCallback(
    (): string => serializeRef.current?.serializeAsHTML({ includeGlobalBackground: true }) ?? '',
    [],
  );

  const bracketedPaste = useCallback(
    (): boolean => termRef.current?.modes.bracketedPasteMode ?? false,
    [],
  );

  const clearSearch = useCallback((): void => {
    searchRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    setSearchResults(null);
  }, []);

  return {
    exportText,
    exportHtml,
    bracketedPaste,
    search,
    clearSearch,
    searchResults,
    containerRef,
    connected,
    error,
    send,
    sendControl,
    setInputTransform,
    scrollLines,
    scrollToBottom,
    atBottom,
  };
}
