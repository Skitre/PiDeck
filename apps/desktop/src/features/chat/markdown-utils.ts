export function sanitizeAgentText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/<dcp-id>[\s\S]*?<\/dcp-id>/gi, "")
    .replace(/^Thinking:\s*/i, "");
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function codeLineCount(value: string): number {
  if (!value) return 0;
  return value.replace(/\n$/, "").split("\n").length;
}
