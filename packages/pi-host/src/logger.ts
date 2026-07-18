/**
 * Structured logging to stderr only — never stdout (protocol channel).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /authorization/i,
  /password/i,
  /secret/i,
  /bearer\s+\S+/i,
];

function redact(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(out)) {
      out = out.replace(/(["']?)(sk-|key-|Bearer\s+)[A-Za-z0-9._\-/+=]{8,}\1/gi, "[REDACTED]");
      out = out.replace(
        /(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"',\s}]+/gi,
        "$1=[REDACTED]",
      );
    }
  }
  return out;
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redact(message),
    ...(meta ? { meta: JSON.parse(redact(JSON.stringify(meta))) } : {}),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
