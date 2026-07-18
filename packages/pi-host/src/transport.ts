import type { Readable } from "node:stream";

/**
 * JSONL line reader with partial-line buffering.
 */
export function createLineReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  let buffer = "";

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", onData);

  return () => {
    stream.off("data", onData);
    // flush incomplete line if any
    if (buffer.trim()) {
      onLine(buffer);
      buffer = "";
    }
  };
}

export function encodeJsonl(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}
