import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsNarrow, useIsTouch } from '../hooks/use-media-query';
import { useTerminal, TERM_ROWS, type TerminalDims } from '../hooks/use-terminal';
import { Search } from 'lucide-react';

import { cn } from '../lib/cn';
import { isPrimaryModifier } from '../lib/keys';
import { formatPrompt } from '../lib/prompt';
import { TerminalSearch } from './terminal-search';

/** Reads the rendered pixel size of the xterm screen, or zeros before first paint. */
function measureTerminal(container: HTMLElement): { width: number; height: number } {
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  return {
    width: screen?.offsetWidth ?? container.offsetWidth ?? 0,
    height: screen?.offsetHeight ?? container.offsetHeight ?? 0,
  };
}

/** Available width for the terminal: the wrapper's content box, minus padding. */
const WRAPPER_PADDING_PX = 24;

/** Upscaling past this is pointless — the glyphs are already fuzzy at 2x. */
const MAX_SCALE = 3;

/** Two taps closer together than this, in the same spot, are a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
/** Movement under this is a tap, not a drag. */
const TAP_SLOP_PX = 8;

/** Fallback line height before xterm has painted, so a drag is never a no-op. */
const FALLBACK_LINE_PX = 16;

/** Per-frame velocity decay for the fling that follows a vertical drag. */
const MOMENTUM_DECAY = 0.94;
/** Below this (px/frame) the fling has visually stopped. */
const MOMENTUM_MIN_PX = 0.4;
/** A fling longer than this is almost always an accidental flick. */
const MOMENTUM_MAX_PX = 60;

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The live view of one session's PTY.
 *
 * The terminal is a fixed 120x32 pixel block, so it is **scaled**, never fitted:
 * fitting would resize the PTY and every other viewer along with it. On a
 * desktop pointer that is the whole story and the behaviour is unchanged — the
 * block is scaled down to fit the width, clamped at 1, in a scrollable box.
 *
 * On a touch pointer 0.45x is ~6px text, so the same block additionally gets
 * pinch-to-zoom and drag-to-pan, with double-tap back to fit. The PTY never
 * moves; only the viewport onto it does, which is why this is safe with several
 * viewers attached. Resizing the PTY for real is a separate, explicit,
 * confirmed action ("Fit to screen" in the session header).
 */
export interface TerminalViewProps {
  sessionId: string | null;
  /**
   * Explicit PTY geometry. `null` leaves the server's fixed 120x32 alone; a
   * value reconnects the socket with `?cols&rows`, which resizes the PTY for
   * *every* viewer.
   */
  dims?: TerminalDims | null;
  /**
   * Receives the live PTY writer whenever the socket state changes, so callers
   * (quick actions) can send keystrokes down the same socket the keyboard uses
   * instead of taking the slower REST fallback.
   */
  onSendReady?: (send: ((data: string) => void) | null) => void;
  /**
   * Receives the one-shot input transform installer, used by the key bar's
   * sticky `Ctrl` to rewrite the next soft-keyboard chunk.
   */
  onInputTransformReady?: (
    setTransform: ((transform: ((data: string) => string) | null) => void) | null,
  ) => void;
  /**
   * Receives a function that measures how many columns and rows would fill the
   * current viewport at the current font size, or `null` before the terminal
   * has painted. Drives the header's "Fit to screen".
   */
  onFitPlanReady?: (plan: (() => TerminalDims | null) | null) => void;
  /**
   * Whether this is the focused pane. Only the active view claims ⌘F; in a
   * split layout every other pane stays passive.
   */
  active?: boolean;
  /** Receives a prompt sender that honours the program's bracketed-paste mode. */
  onSendPromptReady?: (send: ((text: string) => void) | null) => void;
}

export function TerminalView({
  sessionId,
  dims = null,
  onSendReady,
  onInputTransformReady,
  onFitPlanReady,
  onSendPromptReady,
  active = true,
}: TerminalViewProps) {
  const {
    containerRef,
    connected,
    error,
    send,
    setInputTransform,
    scrollLines,
    scrollToBottom,
    atBottom,
    search,
    clearSearch,
    searchResults,
    bracketedPaste,
  } = useTerminal(sessionId, dims);

  useEffect(() => {
    if (!connected) {
      onSendPromptReady?.(null);
      return;
    }
    onSendPromptReady?.((text: string) => send(formatPrompt(text, bracketedPaste())));
    return () => onSendPromptReady?.(null);
  }, [connected, send, bracketedPaste, onSendPromptReady]);
  const [searchOpen, setSearchOpen] = useState(false);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    clearSearch();
    containerRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus();
  }, [clearSearch, containerRef]);

  // ⌘F opens find. Captured so the browser's own find bar — which cannot see
  // into a canvas-rendered terminal — never opens instead.
  useEffect(() => {
    if (!sessionId || !active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPrimaryModifier(event) || event.altKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sessionId, active]);

  useEffect(() => setSearchOpen(false), [sessionId]);
  // Gestures are enabled where the fit-scale is genuinely unreadable: a finger
  // pointer, or a phone-width viewport (which is also what a desktop browser in
  // device-emulation mode reports). A wide desktop window gets neither, so its
  // text selection, click-to-focus and native scrollbar are untouched.
  const touch = useIsTouch() || useIsNarrow();

  useEffect(() => {
    onSendReady?.(connected ? send : null);
    return () => onSendReady?.(null);
  }, [connected, send, onSendReady]);

  useEffect(() => {
    onInputTransformReady?.(connected ? setInputTransform : null);
    return () => onInputTransformReady?.(null);
  }, [connected, setInputTransform, onInputTransformReady]);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  /** `null` while following the fit; a number once the user has pinched. */
  const [userScale, setUserScale] = useState<number | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  const scale = userScale ?? fitScale;

  // Read inside pointer handlers, which are not re-created per render.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  const panRef = useRef(pan);
  panRef.current = pan;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container || !sessionId) {
      setFitScale(1);
      return;
    }

    const update = (): void => {
      const { width } = measureTerminal(container);
      if (width <= 0) return;
      const available = wrapper.clientWidth - WRAPPER_PADDING_PX;
      setFitScale(Math.min(1, Math.max(0.1, available / width)));
    };

    // Observing the container too: the terminal's own width only becomes real
    // after xterm has measured its font and painted, which is after this effect.
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    observer.observe(container);
    // ...and the `.xterm` element itself. The container is a block that spans
    // its parent, so its box never changes when the PTY is resized — only the
    // xterm child shrinks. Without this, "Fit to screen" resizes the terminal to
    // 52 columns and then keeps rendering it at the 120-column scale, using half
    // the screen width.
    const xterm = container.querySelector('.xterm');
    if (xterm) observer.observe(xterm);
    update();

    return () => observer.disconnect();
    // `dims` is a dependency because xterm mounts a *new* `.xterm` element on a
    // PTY resize, and the old observation would be pointing at a detached node.
  }, [sessionId, containerRef, dims?.cols, dims?.rows]);

  // A new session, or a real PTY resize, invalidates any zoom the user had.
  useEffect(() => {
    setUserScale(null);
    setPan({ x: 0, y: 0 });
  }, [sessionId, dims?.cols, dims?.rows]);

  /** Keeps the terminal from being dragged entirely out of view. */
  const clampPan = useCallback((next: Point, atScale: number): Point => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container) return { x: 0, y: 0 };
    const { width, height } = measureTerminal(container);
    const contentW = width * atScale;
    const contentH = height * atScale;
    const viewW = wrapper.clientWidth;
    const viewH = wrapper.clientHeight;
    // When the content is smaller than the viewport there is nothing to pan.
    const minX = Math.min(0, viewW - contentW - WRAPPER_PADDING_PX);
    const minY = Math.min(0, viewH - contentH - WRAPPER_PADDING_PX);
    return {
      x: Math.min(0, Math.max(minX, next.x)),
      y: Math.min(0, Math.max(minY, next.y)),
    };
  }, [containerRef]);

  const resetZoom = useCallback((): void => {
    setUserScale(null);
    setPan({ x: 0, y: 0 });
    panRef.current = { x: 0, y: 0 };
  }, []);

  /** Height of one terminal row *on screen*, i.e. after the zoom transform. */
  const lineHeightPx = useCallback((): number => {
    const container = containerRef.current;
    if (!container) return FALLBACK_LINE_PX;
    const { height } = measureTerminal(container);
    const rows = dims?.rows ?? TERM_ROWS;
    const cell = height > 0 && rows > 0 ? height / rows : FALLBACK_LINE_PX;
    return Math.max(4, cell * scaleRef.current);
  }, [containerRef, dims?.rows]);

  // Reports "how big could the PTY be" to the header. Deliberately a function
  // rather than a value: it must be measured at click time, after any rotation
  // or keyboard show/hide, not at whatever moment the last render happened.
  const fitPlan = useCallback((): TerminalDims | null => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container) return null;
    const { width, height } = measureTerminal(container);
    const cols = dims?.cols ?? 120;
    const rows = dims?.rows ?? 32;
    if (width <= 0 || height <= 0) return null;
    const cellW = width / cols;
    const cellH = height / rows;
    const nextCols = Math.floor((wrapper.clientWidth - WRAPPER_PADDING_PX) / cellW);
    const nextRows = Math.floor((wrapper.clientHeight - WRAPPER_PADDING_PX) / cellH);
    // The server rejects degenerate geometry, and so does every TUI.
    if (nextCols < 20 || nextRows < 8) return null;
    return { cols: Math.min(400, nextCols), rows: Math.min(200, nextRows) };
  }, [containerRef, dims?.cols, dims?.rows]);

  useEffect(() => {
    onFitPlanReady?.(sessionId ? fitPlan : null);
    return () => onFitPlanReady?.(null);
  }, [onFitPlanReady, fitPlan, sessionId]);

  // ---- pinch + pan -------------------------------------------------------
  //
  // Touch pointers only. A mouse keeps native text selection, native clicking
  // into the terminal and the native scrollbar; nothing below runs for it.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    startDistance: number;
    startScale: number;
    startPan: Point;
    anchor: Point;
  } | null>(null);
  const drag = useRef<{
    origin: Point;
    last: Point;
    moved: boolean;
    /** Locked in once the slop is broken, so a gesture never changes its mind. */
    axis: 'none' | 'vertical' | 'horizontal';
    /** Sub-line remainder, so slow drags still accumulate into whole lines. */
    scrollRemainder: number;
    velocity: number;
  } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const momentum = useRef<number | null>(null);

  const stopMomentum = useCallback((): void => {
    if (momentum.current !== null) cancelAnimationFrame(momentum.current);
    momentum.current = null;
  }, []);

  useEffect(() => stopMomentum, [stopMomentum, sessionId]);

  const setPanNow = useCallback((next: Point): void => {
    panRef.current = next;
    setPan(next);
  }, []);

  /**
   * Routes a vertical finger movement: pan first while the zoomed content still
   * has room to move, then spend whatever is left on the scrollback. Returns the
   * distance that was actually consumed, which is what the fling decays on.
   */
  const applyVerticalDelta = useCallback(
    (dy: number, state: { scrollRemainder: number }): number => {
      const before = panRef.current;
      const panned = clampPan({ x: before.x, y: before.y + dy }, scaleRef.current);
      const consumed = panned.y - before.y;
      if (consumed !== 0) setPanNow(panned);

      const leftover = dy - consumed;
      if (leftover === 0) return consumed;

      state.scrollRemainder += leftover;
      const step = lineHeightPx();
      const lines = Math.trunc(state.scrollRemainder / step);
      if (lines !== 0) {
        state.scrollRemainder -= lines * step;
        // Dragging *down* pulls older output into view, i.e. scrolls up.
        scrollLines(-lines);
      }
      return dy;
    },
    [clampPan, lineHeightPx, scrollLines, setPanNow],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!touch || event.pointerType === 'mouse') return;
    stopMomentum();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const points = [...pointers.current.values()];
    const [first, second] = points;
    if (points.length === 2 && first && second) {
      drag.current = null;
      const wrapper = wrapperRef.current;
      const rect = wrapper?.getBoundingClientRect();
      const mid = midpoint(first, second);
      gesture.current = {
        startDistance: Math.max(1, distance(first, second)),
        startScale: scaleRef.current,
        startPan: panRef.current,
        anchor: { x: mid.x - (rect?.left ?? 0), y: mid.y - (rect?.top ?? 0) },
      };
      return;
    }

    if (points.length === 1 && first) {
      drag.current = {
        origin: first,
        last: first,
        moved: false,
        axis: 'none',
        scrollRemainder: 0,
        velocity: 0,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!touch || event.pointerType === 'mouse') return;
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const points = [...pointers.current.values()];
    const [first, second] = points;
    const active = gesture.current;

    if (points.length >= 2 && first && second && active) {
      const ratio = distance(first, second) / active.startDistance;
      const next = Math.min(
        MAX_SCALE,
        Math.max(fitScaleRef.current, active.startScale * ratio),
      );
      // Keep the pinch midpoint pinned to the same terminal cell, or the
      // content slides out from under the fingers.
      const factor = next / active.startScale;
      const nextPan = {
        x: active.anchor.x - (active.anchor.x - active.startPan.x) * factor,
        y: active.anchor.y - (active.anchor.y - active.startPan.y) * factor,
      };
      setUserScale(next);
      setPanNow(clampPan(nextPan, next));
      return;
    }

    const dragging = drag.current;
    if (points.length === 1 && first && dragging) {
      const dx = first.x - dragging.origin.x;
      const dy = first.y - dragging.origin.y;
      if (dragging.axis === 'none') {
        if (Math.hypot(dx, dy) < TAP_SLOP_PX) return;
        dragging.axis = Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal';
        dragging.moved = true;
        dragging.last = first;
        return;
      }

      const stepX = first.x - dragging.last.x;
      const stepY = first.y - dragging.last.y;
      dragging.last = first;

      if (dragging.axis === 'vertical') {
        dragging.velocity = stepY;
        applyVerticalDelta(stepY, dragging);
        return;
      }

      // Horizontal: pan only. There is nothing to scroll sideways into — the
      // PTY is exactly `cols` wide — so this is purely about a zoomed viewport.
      setPanNow(
        clampPan({ x: panRef.current.x + stepX, y: panRef.current.y }, scaleRef.current),
      );
    }
  };

  /** Continues a flung vertical drag through the same pan-then-scroll pipeline. */
  const startMomentum = useCallback(
    (velocity: number): void => {
      let current = Math.max(-MOMENTUM_MAX_PX, Math.min(MOMENTUM_MAX_PX, velocity));
      if (Math.abs(current) < MOMENTUM_MIN_PX) return;
      const state = { scrollRemainder: 0 };
      const tick = (): void => {
        const consumed = applyVerticalDelta(current, state);
        current *= MOMENTUM_DECAY;
        if (consumed === 0 || Math.abs(current) < MOMENTUM_MIN_PX) {
          momentum.current = null;
          return;
        }
        momentum.current = requestAnimationFrame(tick);
      };
      momentum.current = requestAnimationFrame(tick);
    },
    [applyVerticalDelta],
  );

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!touch || event.pointerType === 'mouse') return;
    const finished = drag.current;
    const wasDragging = finished?.moved ?? false;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) drag.current = null;

    if (
      finished &&
      finished.axis === 'vertical' &&
      event.type === 'pointerup' &&
      pointers.current.size === 0
    ) {
      startMomentum(finished.velocity);
    }

    if (wasDragging || event.type === 'pointercancel') {
      lastTap.current = null;
      return;
    }

    const point = { x: event.clientX, y: event.clientY };
    const previous = lastTap.current;
    const now = Date.now();
    if (
      previous &&
      now - previous.at < DOUBLE_TAP_MS &&
      distance(previous.point, point) < DOUBLE_TAP_SLOP_PX
    ) {
      lastTap.current = null;
      resetZoom();
      return;
    }
    lastTap.current = { at: now, point };
  };

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-base-400">
        Select or create a session to see its terminal.
      </div>
    );
  }

  const status = error ?? (connected ? null : 'Connecting…');
  const zoomed = userScale !== null && userScale > fitScale + 0.001;

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-base-950">
      {status !== null && (
        <div
          className={cn(
            'absolute right-3 top-3 z-10 rounded border px-2 py-1 text-xs',
            error === 'Session not found' || error === 'Disconnected from server'
              ? 'border-status-error/40 bg-status-error/10 text-status-error'
              : 'border-base-700 bg-base-850 text-base-300',
          )}
        >
          {status}
        </div>
      )}

      {zoomed && (
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={resetZoom}
          className="absolute bottom-3 right-3 z-10 rounded-md border border-base-700 bg-base-850/90 px-2 py-1 text-[11px] text-base-200"
        >
          {Math.round(scale * 100)}% · Reset
        </button>
      )}

      {searchOpen && (
        <TerminalSearch results={searchResults} onSearch={search} onClose={closeSearch} />
      )}

      {touch && !searchOpen && (
        <button
          type="button"
          aria-label="Find in terminal"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setSearchOpen(true)}
          className="absolute bottom-3 left-3 z-10 inline-flex size-8 items-center justify-center rounded-md border border-base-700 bg-base-850/90 text-base-200"
        >
          <Search className="size-4" />
        </button>
      )}

      {!atBottom && (
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            stopMomentum();
            scrollToBottom();
          }}
          className={cn(
            'absolute z-10 rounded-md border border-base-700 bg-base-850/90 px-2 py-1 text-[11px] text-base-200',
            zoomed ? 'bottom-3 right-28' : 'bottom-3 right-3',
          )}
        >
          ↓ Live
        </button>
      )}

      <div
        ref={wrapperRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        className={cn(
          'h-full w-full',
          // Touch: we own the gesture, so the box never scrolls natively and the
          // transform carries both zoom and pan.
          // Desktop: byte-for-byte the original behaviour.
          touch ? 'overflow-hidden [touch-action:none]' : 'overflow-auto',
        )}
      >
        <div className="w-full p-3">
          <div
            ref={containerRef}
            className="w-fit"
            style={{
              transform: touch
                ? `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
                : `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </div>
  );
}
