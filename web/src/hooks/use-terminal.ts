import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

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
}

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

function terminalUrl(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws/term/${encodeURIComponent(sessionId)}`;
}

/**
 * Owns an xterm.js instance and a binary WebSocket to `/ws/term/:id`.
 *
 * Bytes are forwarded verbatim in both directions — no decoding, no line
 * buffering — which is what makes arrow keys, `⇧Tab`, `/model` and Ctrl-C work.
 */
export function useTerminal(sessionId: string | null): UseTerminalResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      cols: TERM_COLS,
      rows: TERM_ROWS,
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

    // WebGL context creation genuinely fails on some machines and in some
    // remote-display setups; falling back to the canvas renderer is far better
    // than white-screening the app.
    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webgl === addon) webgl = null;
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch (cause) {
      console.warn('[terminal] WebGL renderer unavailable, using canvas', cause);
    }

    const encoder = new TextEncoder();
    const dataListener = term.onData((data) => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
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

      const ws = new WebSocket(terminalUrl(sessionId));
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

      dataListener.dispose();
      webgl?.dispose();
      // Leaking a terminal leaks a WebGL context and a canvas; twenty session
      // switches would exhaust the browser's context pool.
      term.dispose();
    };
  }, [sessionId]);

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

  return { containerRef, connected, error, send, sendControl };
}
