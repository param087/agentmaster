import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsNarrow, useIsTouch } from '../hooks/use-media-query';
import { useTerminal, type TerminalDims } from '../hooks/use-terminal';
import { cn } from '../lib/cn';

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
}

export function TerminalView({
  sessionId,
  dims = null,
  onSendReady,
  onInputTransformReady,
  onFitPlanReady,
}: TerminalViewProps) {
  const { containerRef, connected, error, send, setInputTransform } = useTerminal(sessionId, dims);
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
  }, []);

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
  const drag = useRef<{ origin: Point; startPan: Point; moved: boolean } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!touch || event.pointerType === 'mouse') return;
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
      drag.current = { origin: first, startPan: panRef.current, moved: false };
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
      setPan(clampPan(nextPan, next));
      return;
    }

    const dragging = drag.current;
    if (points.length === 1 && first && dragging) {
      const dx = first.x - dragging.origin.x;
      const dy = first.y - dragging.origin.y;
      if (!dragging.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return;
      // Only take over the gesture once the content genuinely overflows;
      // otherwise a one-finger drag stays a selection, exactly as before.
      const clamped = clampPan(
        { x: dragging.startPan.x + dx, y: dragging.startPan.y + dy },
        scaleRef.current,
      );
      if (clamped.x === panRef.current.x && clamped.y === panRef.current.y && !dragging.moved) {
        return;
      }
      dragging.moved = true;
      setPan(clamped);
    }
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!touch || event.pointerType === 'mouse') return;
    const wasDragging = drag.current?.moved ?? false;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) drag.current = null;

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
