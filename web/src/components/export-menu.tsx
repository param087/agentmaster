import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';

import { downloadText, safeFilename } from '../lib/download';
import type { Session } from '../lib/types';

export interface TerminalExport {
  text: () => string;
  html: () => string;
}

export interface ExportMenuProps {
  session: Session;
  exporter: TerminalExport | null;
  buttonClassName: string;
  labelClassName: string;
}

/**
 * Text and HTML come from the browser's own terminal buffer (what you can
 * scroll back through); the recording comes from the server, which is the only
 * side that knows when each byte arrived.
 */
export function ExportMenu({ session, exporter, buttonClassName, labelClassName }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const name = safeFilename(session.title);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const item =
    'block w-full rounded px-2.5 py-1.5 text-left text-[12px] text-base-200 hover:bg-base-800 disabled:opacity-40';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Export"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >
        <Download className="size-3.5" />
        <span className={labelClassName}>Export</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Export as"
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-base-700 bg-base-900 p-1 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            disabled={exporter === null}
            className={item}
            onClick={() => {
              if (exporter) downloadText(`${name}.txt`, exporter.text(), 'text/plain;charset=utf-8');
              setOpen(false);
            }}
          >
            Text (.txt)
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={exporter === null}
            className={item}
            onClick={() => {
              if (exporter) downloadText(`${name}.html`, exporter.html(), 'text/html;charset=utf-8');
              setOpen(false);
            }}
          >
            Coloured HTML (.html)
          </button>
          <a
            role="menuitem"
            className={item}
            href={`/api/sessions/${encodeURIComponent(session.id)}/export.cast`}
            download={`${name}.cast`}
            onClick={() => setOpen(false)}
          >
            Recording (.cast)
          </a>
        </div>
      )}
    </div>
  );
}
