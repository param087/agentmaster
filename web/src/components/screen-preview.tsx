/** Lines shown before the preview is expanded. */
export const COLLAPSED_PREVIEW_LINES = 4;

/** The last `count` lines, which is where a prompt's question and options sit. */
export function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export interface ScreenPreviewProps {
  preview: string;
  label: string;
}

/**
 * The screen as it was when a session stopped for you, so the decision can be
 * made from the sidebar. Collapsed to the last few lines; expands in place.
 */
export function ScreenPreview({ preview, label }: ScreenPreviewProps) {
  const lineCount = preview.split('\n').length;
  const short = lastLines(preview, COLLAPSED_PREVIEW_LINES);
  const body = (text: string) => (
    <pre className="overflow-x-auto whitespace-pre px-2 py-1 font-mono text-[10px] leading-[1.35] text-base-300">
      {text}
    </pre>
  );

  if (lineCount <= COLLAPSED_PREVIEW_LINES) {
    return (
      <div aria-label={label} className="mx-2 mb-1 rounded border border-base-800 bg-base-950/80">
        {body(preview)}
      </div>
    );
  }

  return (
    <details aria-label={label} className="group mx-2 mb-1 rounded border border-base-800 bg-base-950/80">
      <summary className="cursor-pointer list-none">
        <span className="group-open:hidden">{body(short)}</span>
        <span className="block px-2 pb-1 text-[10px] text-base-500 group-open:hidden">
          Show {lineCount - COLLAPSED_PREVIEW_LINES} more lines
        </span>
        <span className="hidden px-2 pt-1 text-[10px] text-base-500 group-open:block">Show less</span>
      </summary>
      {body(preview)}
    </details>
  );
}
