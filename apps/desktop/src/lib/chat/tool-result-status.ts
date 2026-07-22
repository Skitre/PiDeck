function resultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;

  const content = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)
      ? (value as { content: unknown[] }).content
      : null;
  if (!content) return undefined;

  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function isAbortedToolResult(value: unknown, isError: boolean): boolean {
  if (
    value &&
    typeof value === "object" &&
    "aborted" in value &&
    Boolean((value as { aborted?: unknown }).aborted)
  ) {
    return true;
  }
  if (!isError) return false;

  // Pi encodes an interrupted tool as a regular error result without an
  // `aborted` field, so status must also use its canonical result text.
  const text = resultText(value)?.trim().toLowerCase();
  return text === "operation aborted" || text === "operation aborted.";
}
