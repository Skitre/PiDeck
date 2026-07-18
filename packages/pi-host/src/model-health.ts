import type { ModelConfigHealth } from "@pi-desktop/protocol";

const MIGRATION_HINT = {
  code: "SESSION_AFFINITY_FORMAT_REQUIRED" as const,
  message:
    "Use sessionAffinityFormat; the old sendSessionIdHeader:false maps to sessionAffinityFormat:\"openai-nosession\".",
};

/**
 * Build ModelConfigHealth from ModelRegistry.getError() output.
 * Never includes raw headers/tokens.
 */
export function buildModelConfigHealth(errorMessage: string | null | undefined): ModelConfigHealth {
  if (!errorMessage) {
    return {
      state: "ok",
      source: "ModelRegistry.getError",
    };
  }

  // Sanitize: strip anything that looks like a secret-bearing value
  const message = sanitizeModelError(errorMessage);
  const health: ModelConfigHealth = {
    state: "error",
    source: "ModelRegistry.getError",
    message,
  };

  if (/sendSessionIdHeader/i.test(errorMessage)) {
    health.migrationHint = MIGRATION_HINT;
  }

  return health;
}

function sanitizeModelError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._\-/+=]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 2000);
}
