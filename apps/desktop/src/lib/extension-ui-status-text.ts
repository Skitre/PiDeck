/** Visible status chip text. Keep the Extension's own characters; do not prefix the key. */
export function statusChipText(key: string, text: string): string {
  const body = text.trim();
  if (body) return body;
  const fallback = key.trim();
  return fallback === "default" ? "" : fallback;
}
