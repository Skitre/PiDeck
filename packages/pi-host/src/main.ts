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
  ModelRegistry,
  ModelRuntime,
  VERSION as SDK_VERSION,
  DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createHostError, type HostCapabilities } from "@pideck/protocol";
import { buildDegradedModelConfigHealth, buildModelConfigHealth } from "./model-health.js";
import { recoverProviderJournals } from "./provider-journal.js";
import { logger } from "./logger.js";
import { PiHostServer } from "./server.js";
import { createWorkspaceHandlers } from "./workspace-controller.js";
import { WorkspaceFileService } from "./workspace-files.js";
import { createSessionHandlers } from "./session-controller.js";
import { createAgentHandlers } from "./agent-controller.js";
import { createPackageHandlers } from "./package-controller.js";
import { createProviderHandlers } from "./provider-controller.js";
import { createExtensionUiHandlers } from "./extension-ui-bridge.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { applyKnownThinkingProfiles } from "./model-thinking.js";
import { FileCredentialStore } from "./credential-store.js";
import { ExtensionProviderOwnership } from "./extension-provider-ownership.js";
import { refreshModelsLocal } from "./model-runtime-refresh.js";
import { ensureMigrationBackup, MIGRATION_ID } from "./migration-backup.js";
import { migrateLegacyPideckData } from "./pideck-data.js";
import { applyHostNetworkSettings, ensureGlobalSettingsFile } from "./network-bootstrap.js";
import { AttachmentStore } from "./attachment-store.js";
import { createAttachmentHandlers } from "./attachment-controller.js";
import { createGitHandlers } from "./git-controller.js";
import { GitService } from "./git-service.js";
import { getInternalRuntime } from "./internal-runtime.js";

function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  const arg = process.argv.find((a) => a.startsWith("--agent-dir="));
  if (arg) return arg.slice("--agent-dir=".length);
  return join(homedir(), ".pi", "agent");
}

function resolveArg(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  const value = arg?.slice(prefix.length).trim();
  return value ? value : null;
}

function resolveInitialCwd(): string | null {
  return resolveArg("--initial-cwd=");
}

function resolveInitialSessionBootstrap(): {
  sessionPath?: string;
  continueRecent?: boolean;
} {
  const sessionPath = resolveArg("--initial-session=");
  const continueRecent = process.argv.includes("--continue-recent");
  return {
    ...(sessionPath ? { sessionPath } : {}),
    ...(continueRecent ? { continueRecent: true } : {}),
  };
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
    fauxAssistantMessage(fauxToolCall("read", { path: "pideck-core-e2e.txt" }), {
      stopReason: "toolUse",
    }),
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
          "This deterministic response is intentionally long enough to exercise the Stop action and abort recovery. ".repeat(
            24,
          ),
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

  // Synchronous, before any network activity: proxy/idle-timeout from global
  // settings (never applied by the SDK on the library path) and a guaranteed
  // settings file for the desktop "Open settings.json" affordance.
  ensureGlobalSettingsFile(agentDir);
  applyHostNetworkSettings(agentDir);

  logger.info("Starting Pi Host", {
    agentDir,
    sdkVersion: SDK_VERSION,
    node: process.version,
  });

  // Keep the shared Pi directory native-compatible: adopt PiDeck-owned data
  // into one private namespace before recovery reads any persisted state.
  await migrateLegacyPideckData(agentDir, MIGRATION_ID);
  const attachmentStore = new AttachmentStore({ agentDir });
  await attachmentStore.initialize();

  // Before anything can rewrite user data. The 0.82.1 runtime introduces
  // models-store.json and recomposes providers, so a downgrade is only safe
  // while the pre-migration bytes still exist.
  const migrationBackup = await ensureMigrationBackup(agentDir);

  // Cwd-independent services (PROJECT_SPEC §8.1)
  const credentialStore = FileCredentialStore.forAgentDir(agentDir);

  // Resolve any provider mutation the previous run did not finish, before the
  // runtime reads models.json or auth.json. An unresolved journal means the two
  // files may disagree, which no amount of refreshing can detect.
  const unresolvedRecovery = await recoverProviderJournals(agentDir, credentialStore);

  // The single authoritative runtime. `allowModelNetwork: false` keeps startup
  // offline; only an explicit user refresh may reach the network later.
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  await migrationBackup?.recordMilestone("runtimeCreate");
  const modelRegistry = new ModelRegistry(modelRuntime);

  // Wraps the runtime's provider registration before anything registers:
  // startup registrations (faux provider) become host-owned; workspace
  // extension registrations become suspendable per graph.
  const providerOwnership = new ExtensionProviderOwnership(modelRuntime);

  installTestFauxProvider(modelRegistry);
  // Awaited: the previous fire-and-forget refresh could still be running when
  // the first workspace graph read the registry.
  await refreshModelsLocal(modelRuntime);
  await migrationBackup?.recordMilestone("localRefresh");
  providerOwnership.runNeutral(() => applyKnownThinkingProfiles(modelRegistry));
  // Degraded outranks a parse check and is sticky: the Host cannot re-derive
  // whether the configuration became coherent, so it stops claiming health
  // until a restart finds no journal.
  const resolveModelConfigHealth = () =>
    unresolvedRecovery
      ? buildDegradedModelConfigHealth(unresolvedRecovery)
      : buildModelConfigHealth(modelRuntime.getError());
  let modelConfigHealth = resolveModelConfigHealth();

  // Capability detection — check prototype without constructing full PackageManager
  const packageUpdateCheck =
    typeof (DefaultPackageManager.prototype as { checkForAvailableUpdates?: unknown })
      .checkForAvailableUpdates === "function";

  const capabilities: HostCapabilities = {
    packageUpdateCheck,
    extensionUi: true,
    sessionExport: true,
  };

  const graphFactory = new WorkspaceGraphFactory({
    agentDir,
    attachmentStore,
    credentialStore,
    modelRuntime,
    modelRegistry,
    providerOwnership,
    getModelConfigHealth: () => modelConfigHealth,
    refreshModelHealth: async (signal) => {
      // Reconciliation only. A network catalog fetch is a separate, explicitly
      // authorised call; it must never be triggered by a health refresh.
      await refreshModelsLocal(modelRuntime, { signal });
      // Neutral: the profile pass re-registers existing providers and must
      // not become a co-owner that pins another workspace's provider alive.
      providerOwnership.runNeutral(() => applyKnownThinkingProfiles(modelRegistry));
      modelConfigHealth = resolveModelConfigHealth();
      return modelConfigHealth;
    },
    ...(migrationBackup
      ? {
          recordMigrationMilestone: (milestone) => migrationBackup.recordMilestone(milestone),
        }
      : {}),
    packageUpdateCheck,
  });
  // Late Path-B registrations (an extension calling pi.registerProvider in
  // the middle of an agent turn) are attributed to the active workspace.
  providerOwnership.setFallbackOwnerSource(() => graphFactory.getGraph()?.providerOwner ?? null);
  const workspaceFiles = new WorkspaceFileService();
  const runtime = getInternalRuntime();
  const gitService = new GitService(runtime.gitExecutable ?? "git", runtime.env);

  const handlers = {
    ...createWorkspaceHandlers(graphFactory, workspaceFiles, gitService),
    ...createGitHandlers(graphFactory, gitService),
    ...createAttachmentHandlers(graphFactory),
    ...createSessionHandlers(graphFactory),
    ...createAgentHandlers(graphFactory),
    ...createProviderHandlers(graphFactory),
    ...createPackageHandlers(graphFactory),
    ...createExtensionUiHandlers(graphFactory),
  };

  const server = new PiHostServer({
    agentDir,
    sdkVersion: SDK_VERSION,
    getModelConfigHealth: () => modelConfigHealth,
    capabilities,
    handlers,
    getRehydrateState: () => {
      const graph = graphFactory.getGraph();
      const session = graph?.sessionSnapshot ?? null;
      return {
        workspace: graph ? graphFactory.buildWorkspaceSnapshot(graph) : null,
        session,
        tools: session?.tools ?? null,
        packages: graph?.packageSnapshot ?? null,
      };
    },
    onShutdown: async () => {
      workspaceFiles.dispose();
      gitService.dispose();
      const { cancelAllPending } = await import("./extension-ui-bridge.js");
      cancelAllPending("Host shutdown");
      const g = graphFactory.getGraph();
      if (g) {
        await graphFactory.disposeGraph(g);
      }
      await graphFactory.disposeRetainedGraphs();
      await attachmentStore.waitForIdle();
      // Last milestone: only a clean teardown proves the migrated runtime did
      // not leave the agent directory in a state that needs the backup.
      await migrationBackup?.recordMilestone("cleanShutdown");
    },
  });

  graphFactory.bindServer(server);

  // Re-emit status when model health is refreshed by controllers
  graphFactory.onModelHealthChanged = () => {
    server.emit("host.statusChanged", server.buildStatus());
  };

  // Unknown detached-task failures invalidate Host authority. Publish fatal,
  // perform bounded cleanup, and let the desktop apply its restart policy.
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error("Unhandled promise rejection in Pi Host", {
      error: message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void server.requestFatalShutdown(
      createHostError("INTERNAL_ERROR", `Unhandled asynchronous failure: ${message}`),
      "unhandled promise rejection",
    );
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
      const preload = await graphFactory.setCurrent(
        initialCwd,
        randomUUID(),
        resolveInitialSessionBootstrap(),
      );
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
