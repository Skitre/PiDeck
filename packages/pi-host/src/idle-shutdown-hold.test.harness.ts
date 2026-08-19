/**
 * Test-only Host entry. Production `main.ts` never reads PIDECK_TEST_* hold
 * state; this harness wraps dispose so spawned integration tests can block
 * idle shutdown with an explicit file gate.
 */
import { existsSync } from "node:fs";
import { SessionRuntimeCache } from "./session-runtime-cache.js";

const HOLD_ENV = "PIDECK_TEST_HOLD_IDLE_SHUTDOWN";
const HOLD_TIMEOUT_MS = 30_000;
const HOLD_POLL_MS = 25;

async function waitForTestIdleShutdownHold(): Promise<void> {
  const holdPath = process.env[HOLD_ENV]?.trim();
  if (!holdPath || !existsSync(holdPath)) return;
  const deadline = Date.now() + HOLD_TIMEOUT_MS;
  while (existsSync(holdPath)) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
  }
}

const originalDispose = SessionRuntimeCache.prototype.disposeAgentSessionOnly;
SessionRuntimeCache.prototype.disposeAgentSessionOnly = async function (session) {
  await waitForTestIdleShutdownHold();
  return originalDispose.call(this, session);
};

await import("./main.js");
