import { useEffect, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from 'lucide-react';

import { cn } from '../lib/cn';

/**
 * Control-code helper: `Ctrl`+`c` is byte 0x03, `Ctrl`+`a` is 0x01, and so on.
 *
 * Only ASCII letters and the handful of punctuation keys the terminal actually
 * maps are translated; anything else falls through unchanged, which is what a
 * real terminal does with an unmapped Ctrl combination.
 */
export function controlCode(key: string): string {
  if (key.length !== 1) return key;
  const upper = key.toUpperCase();
  const code = upper.charCodeAt(0);
  // A–Z → 0x01–0x1a
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
  // The classic punctuation control codes: [ \ ] ^ _ and ? → DEL.
  if (code >= 91 && code <= 95) return String.fromCharCode(code - 64);
  if (key === '?') return '\x7f';
  if (key === ' ') return '\x00';
  return key;
}

/**
 * Keys a phone keyboard does not have.
 *
 * Without these the dashboard is read-only on a phone: `⇧Tab` (plan mode),
 * `/model`, every arrow-key menu and `Ctrl-C` are simply unreachable.
 *
 * `Space` is here despite phones having one, because reaching for the soft
 * keyboard mid-menu dismisses the arrows you were just using.
 */
interface KeyDef {
  /** Stable React key and accessible name. */
  id: string;
  label?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Raw bytes written to the PTY. */
  bytes: string;
  title: string;
  wide?: boolean;
}

const KEYS: readonly KeyDef[] = [
  { id: 'Esc', label: 'Esc', bytes: '\x1b', title: 'Escape' },
  { id: 'Tab', label: 'Tab', bytes: '\t', title: 'Tab' },
  { id: 'ShiftTab', label: '⇧Tab', bytes: '\x1b[Z', title: 'Shift-Tab (plan mode)' },
  { id: 'Up', icon: ArrowUp, bytes: '\x1b[A', title: 'Arrow up' },
  { id: 'Down', icon: ArrowDown, bytes: '\x1b[B', title: 'Arrow down' },
  { id: 'Left', icon: ArrowLeft, bytes: '\x1b[D', title: 'Arrow left' },
  { id: 'Right', icon: ArrowRight, bytes: '\x1b[C', title: 'Arrow right' },
  // Scrolling back through a long agent transcript is the main reason to reach
  // for these on a phone — opencode and Claude both page with them.
  { id: 'PgUp', label: 'PgUp', bytes: '\x1b[5~', title: 'Page up' },
  { id: 'PgDn', label: 'PgDn', bytes: '\x1b[6~', title: 'Page down' },
  // Normal-mode sequences, matching what xterm.js emits for the physical keys.
  // An application-cursor-mode harness would want \x1bOH / \x1bOF, but nothing
  // we ship switches into it for Home/End.
  { id: 'Home', label: 'Home', bytes: '\x1b[H', title: 'Home (start of line)' },
  { id: 'End', label: 'End', bytes: '\x1b[F', title: 'End (end of line)' },
  { id: 'Space', label: 'Space', bytes: ' ', title: 'Space', wide: true },
  { id: 'Enter', icon: CornerDownLeft, bytes: '\r', title: 'Enter' },
  { id: 'Slash', label: '/', bytes: '/', title: 'Slash (commands)' },
  { id: 'CtrlC', label: 'Ctrl-C', bytes: '\x03', title: 'Interrupt (SIGINT)', wide: true },
];

/** 40px minimum touch target, per the platform guidelines and common sense. */
const KEY_CLASS =
  'inline-flex h-10 min-w-10 shrink-0 select-none items-center justify-center gap-1 ' +
  'rounded-md border border-base-700 bg-base-850 px-2.5 text-[12px] font-medium ' +
  'text-base-100 transition-colors active:bg-base-700 ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export interface KeyBarProps {
  /**
   * The live PTY writer from `useTerminal`, surfaced by `TerminalView`. There is
   * deliberately no second input path: these buttons are indistinguishable from
   * typing because they are literally the same socket.
   */
  send: ((data: string) => void) | null;
  /**
   * Installs a one-shot transform over the next chunk typed on the *soft
   * keyboard*. Sticky `Ctrl` needs this because the letter that follows it is
   * typed on the phone's own keyboard, which reaches the PTY through xterm's
   * `onData` and never passes through `send`.
   */
  setInputTransform: ((transform: ((data: string) => string) | null) => void) | null;
}

export function KeyBar({ send, setInputTransform }: KeyBarProps) {
  // Sticky modifier: latched by tapping `Ctrl`, consumed by the next key.
  const [ctrl, setCtrl] = useState(false);

  const disabled = send === null;

  /**
   * Buttons must never take focus.
   *
   * The terminal's hidden textarea is what the soft keyboard is attached to; if
   * a button steals focus the keyboard slides away on every single tap and the
   * bar becomes unusable. `preventDefault` on `pointerdown` is the only thing
   * that reliably stops that on iOS.
   */
  const hold = (event: React.PointerEvent): void => {
    event.preventDefault();
  };

  /** Latches or clears the modifier, on both input paths at once. */
  const toggleCtrl = (): void => {
    setCtrl((on) => {
      const next = !on;
      setInputTransform?.(
        next
          ? (data) => {
              setCtrl(false); // One use, then it clears — like a real sticky key.
              return controlCode(data);
            }
          : null,
      );
      return next;
    });
  };

  const press = (bytes: string, isCtrlKey = false): void => {
    if (!send) return;
    if (ctrl && !isCtrlKey) {
      setInputTransform?.(null);
      send(controlCode(bytes));
      setCtrl(false);
      return;
    }
    send(bytes);
  };

  // A latched modifier must not survive the socket going away, or the next
  // thing typed after a reconnect would silently become a control code.
  useEffect(() => {
    if (setInputTransform === null) setCtrl(false);
  }, [setInputTransform]);

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className={cn(
        'shrink-0 border-t border-base-800 bg-base-900 pb-[env(safe-area-inset-bottom)]',
        disabled && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-2 [scrollbar-width:none]">
        <button
          type="button"
          aria-pressed={ctrl}
          aria-label="Control modifier"
          title="Sticky Ctrl — tap, then tap a letter"
          disabled={disabled}
          onPointerDown={hold}
          onClick={toggleCtrl}
          className={cn(
            KEY_CLASS,
            ctrl && 'border-accent bg-accent/25 text-accent shadow-[0_0_0_1px] shadow-accent/40',
          )}
        >
          Ctrl
        </button>

        {KEYS.map(({ id, label, icon: Icon, bytes, title, wide }) => (
          <button
            key={id}
            type="button"
            title={title}
            aria-label={title}
            disabled={disabled}
            onPointerDown={hold}
            onClick={() => press(bytes, id === 'CtrlC')}
            className={cn(KEY_CLASS, wide && 'px-3')}
          >
            {Icon ? <Icon className="size-4" /> : label}
          </button>
        ))}
      </div>
    </div>
  );
}
