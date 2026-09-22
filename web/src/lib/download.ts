/** Saves `content` as a file via a temporary object URL. */
export function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: Safari cancels the download if revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Mirrors the server's filename rule so all three exports are named alike. */
export function safeFilename(title: string): string {
  const cleaned = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 80) || 'session';
}
