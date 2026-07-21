#!/usr/bin/env node
/**
 * PiDeck Host entry — owns all Pi SDK services.
 * Transport: JSONL on stdin/stdout; logs on stderr.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  VERSION as SDK_VERSION,
  DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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

function resolveInitialCwd(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--initial-cwd="));
  const value = arg?.slice("--initial-cwd=".length).trim();
  return value ? value : null;
}

/**
 * Deterministic core-release model. It is opt-in and never enabled for a
 * normal Host process; the desktop E2E runner sets PIDECK_TEST_FAUX=1.
 */
function installTestFauxProvider(modelRegistry: ModelRegistry): void {
  if (process.env.PIDECK_TEST_FAUX !== "1") return;

  const faux = createFauxCore({
    api: "pideck-faux-api",
    provider: "pideck-faux",
    models: [
      {
        id: "pideck-core",
        name: "PiDeck Core Test Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    tokensPerSecond: 24,
    tokenSize: { min: 1, max: 4 },
  });

  // prompt: tool call -> tool result turn -> final answer -> title refinement
  // abort: a deliberately long response that remains observable while stopping
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "pideck-core-e2e.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxText(
          "PIDECK_STREAM_START Core chat stream completed after a deterministic tool call. PIDECK_CORE_CHAT_COMPLETE",
        ),
      ],
      { stopReason: "stop" },
    ),
    fauxAssistantMessage(fauxText("Core chat smoke"), { stopReason: "stop" }),
    fauxAssistantMessage(
      fauxText(
        "PIDECK_ABORT_STREAM " +
          "This deterministic response is intentionally long enough to exercise the Stop action and abort recovery. ".repeat(24),
      ),
      { stopReason: "stop" },
    ),
    fauxAssistantMessage(fauxText("PIDECK_ABORT_RECOVERED"), {
      stopReason: "stop",
    }),
  ]);

  modelRegistry.registerProvider("pideck-faux", {
    name: "PiDeck Core Test Model",
    api: faux.api,
    apiKey: "pideck-e2e",
    baseUrl: "http://pideck-faux.invalid",
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  logger.info("Installed deterministic faux provider for core E2E");
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
  installTestFauxProvider(modelRegistry);
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
    sessionExport: false,
  };

  const graphFactory = new WorkspaceGraphFactory({
    agentDir,
    authStorage,
    modelRegistry,
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
      await graphFactory.disposeRetainedGraphs();
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

  // Preload the last-used workspace BEFORE the server starts reading stdin
  // and announces ready: the expensive first graph build (user packages,
  // extensions) overlaps WebView/frontend startup, and early client requests
  // simply wait in the stdin buffer — no identity races. Failures are
  // non-fatal: the frontend falls back to its own workspace.setCurrent.
  const initialCwd = resolveInitialCwd();
  if (initialCwd) {
    const preloadStarted = Date.now();
    try {
      const preload = await graphFactory.setCurrent(initialCwd, randomUUID());
      if ("error" in preload) {
        logger.warn("initial workspace preload failed", {
          cwd: initialCwd,
          error: preload.error.message,
        });
      } else {
        logger.info("initial workspace preloaded", {
          cwd: initialCwd,
          ms: Date.now() - preloadStarted,
        });
      }
    } catch (err) {
      logger.warn("initial workspace preload crashed", {
        cwd: initialCwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
