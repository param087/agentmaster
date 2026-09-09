import { useEffect, useRef, useState } from 'react';

import { useTerminal } from '../hooks/use-terminal';
import { cn } from '../lib/cn';

/** Reads the rendered pixel width of the xterm screen, or 0 before first paint. */
function measureTerminalWidth(container: HTMLElement): number {
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  return screen?.offsetWidth ?? container.offsetWidth ?? 0;
}

/** Available width for the terminal: the wrapper's content box, minus padding. */
const WRAPPER_PADDING_PX = 24;

/**
 * The live view of one session's PTY.
 *
 * The terminal is a fixed 120x32 pixel block, so it is **scaled**, never fitted:
 * fitting would resize the PTY and every other viewer along with it. Scale is
 * clamped at 1 because upscaled text is blurrier than empty margin is ugly.
 */
export interface TerminalViewProps {
  sessionId: string | null;
  /**
   * Receives the live PTY writer whenever the socket state changes, so callers
   * (quick actions) can send keystrokes down the same socket the keyboard uses
   * instead of taking the slower REST fallback.
   */
  onSendReady?: (send: ((data: string) => void) | null) => void;
}

export function TerminalView({ sessionId, onSendReady }: TerminalViewProps) {
  const { containerRef, connected, error, send } = useTerminal(sessionId);

  useEffect(() => {
    onSendReady?.(connected ? send : null);
    return () => onSendReady?.(null);
  }, [connected, send, onSendReady]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container || !sessionId) {
      setScale(1);
      return;
    }

    const update = (): void => {
      const termWidth = measureTerminalWidth(container);
      if (termWidth <= 0) return;
      const available = wrapper.clientWidth - WRAPPER_PADDING_PX;
      setScale(Math.min(1, Math.max(0.1, available / termWidth)));
    };

    // Observing the container too: the terminal's own width only becomes real
    // after xterm has measured its font and painted, which is after this effect.
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    observer.observe(container);
    update();

    return () => observer.disconnect();
  }, [sessionId, containerRef]);

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-base-400">
        Select or create a session to see its terminal.
      </div>
    );
  }

  const status = error ?? (connected ? null : 'Connecting…');

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

      <div ref={wrapperRef} className="h-full w-full overflow-auto">
        <div className="w-full p-3">
          <div
            ref={containerRef}
            className="w-fit"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
          />
        </div>
      </div>
    </div>
  );
}
