#!/usr/bin/env node
/**
 * PiDeck Host entry — owns all Pi SDK services.
 * Transport: JSONL on stdin/stdout; logs on stderr.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  ProjectTrustStore,
  VERSION as SDK_VERSION,
  DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import type { HostCapabilities } from "@pideck/protocol";
import { buildModelConfigHealth } from "./model-health.js";
import { logger } from "./logger.js";
import { PiHostServer } from "./server.js";
import { createWorkspaceHandlers } from "./workspace-controller.js";
import { createSessionHandlers } from "./session-controller.js";
import { createAgentHandlers } from "./agent-controller.js";
import { createPackageHandlers } from "./package-controller.js";
import { createSettingsHandlers } from "./settings-controller.js";
import { createProviderHandlers } from "./provider-controller.js";
import { createExtensionUiHandlers } from "./extension-ui-bridge.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { applyKnownThinkingProfiles } from "./model-thinking.js";

function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  const arg = process.argv.find((a) => a.startsWith("--agent-dir="));
  if (arg) return arg.slice("--agent-dir=".length);
  return join(homedir(), ".pi", "agent");
}

async function main(): Promise<void> {
  const agentDir = resolveAgentDir();
  mkdirSync(agentDir, { recursive: true });

  logger.info("Starting Pi Host", {
    agentDir,
    sdkVersion: SDK_VERSION,
    node: process.version,
  });

  // Cwd-independent services (PROJECT_SPEC §8.1)
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const trustStore = new ProjectTrustStore(agentDir);

  modelRegistry.refresh();
  applyKnownThinkingProfiles(modelRegistry);
  let modelConfigHealth = buildModelConfigHealth(modelRegistry.getError());

  // Capability detection — check prototype without constructing full PackageManager
  const packageUpdateCheck =
    typeof (DefaultPackageManager.prototype as { checkForAvailableUpdates?: unknown })
      .checkForAvailableUpdates === "function";

  const capabilities: HostCapabilities = {
    packageUpdateCheck,
    extensionUi: true,
    projectTrust: true,
    sessionExport: false,
  };

  const graphFactory = new WorkspaceGraphFactory({
    agentDir,
    authStorage,
    modelRegistry,
    trustStore,
    getModelConfigHealth: () => modelConfigHealth,
    refreshModelHealth: async () => {
      await modelRegistry.refresh();
      applyKnownThinkingProfiles(modelRegistry);
      modelConfigHealth = buildModelConfigHealth(modelRegistry.getError());
      return modelConfigHealth;
    },
    packageUpdateCheck,
  });

  const handlers = {
    ...createWorkspaceHandlers(graphFactory),
    ...createSessionHandlers(graphFactory),
    ...createAgentHandlers(graphFactory),
    ...createProviderHandlers(graphFactory),
    ...createPackageHandlers(graphFactory),
    ...createSettingsHandlers(graphFactory),
    ...createExtensionUiHandlers(graphFactory),
  };

  const server = new PiHostServer({
    agentDir,
    sdkVersion: SDK_VERSION,
    getModelConfigHealth: () => modelConfigHealth,
    capabilities,
    handlers,
    onShutdown: async () => {
      const { cancelAllPending } = await import("./extension-ui-bridge.js");
      cancelAllPending("Host shutdown");
      const g = graphFactory.getGraph();
      if (g) {
        await graphFactory.disposeGraph(g);
      }
    },
  });

  graphFactory.bindServer(server);

  // Re-emit status when model health is refreshed by controllers
  graphFactory.onModelHealthChanged = () => {
    server.emit("host.statusChanged", server.buildStatus());
  };

  // Process-level guards: a stray rejection must not kill live agent sessions;
  // an uncaught exception means unknown state — exit so the desktop shell restarts us.
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection in Pi Host", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception in Pi Host", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
  process.once("SIGINT", () => {
    void server.requestShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void server.requestShutdown("SIGTERM");
  });

  await server.start();
}

main().catch((err) => {
  logger.error("Fatal host startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.stderr.write(
    JSON.stringify({
      protocolVersion: 1,
      event: "host.fatal",
      sequence: 0,
      timestamp: Date.now(),
      hostInstanceId: "startup-failed",
      workspaceId: null,
      workspaceRevision: 0,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
      payload: {
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      },
    }) + "\n",
  );
  process.exit(1);
});
