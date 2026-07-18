import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStorage,
  ModelRegistry,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type { ModelConfigHealth, ProviderDraft } from "@pi-desktop/protocol";
import { createProviderHandlers } from "./provider-controller.js";
import { PiHostServer } from "./server.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

const layouts: TempAgentLayout[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function setup(initialModels: unknown) {
  const layout = createTempAgentLayout("pi-provider-test-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(initialModels, null, 2));
  const authStorage = AuthStorage.create(join(layout.agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(layout.agentDir, "models.json"));
  let health: ModelConfigHealth = {
    state: modelRegistry.getError() ? "error" : "ok",
    source: "ModelRegistry.getError",
    ...(modelRegistry.getError() ? { message: modelRegistry.getError() } : {}),
  };
  const factory = new WorkspaceGraphFactory({
    agentDir: layout.agentDir,
    authStorage,
    modelRegistry,
    trustStore: new ProjectTrustStore(layout.agentDir),
    getModelConfigHealth: () => health,
    refreshModelHealth: () => {
      modelRegistry.refresh();
      health = {
        state: modelRegistry.getError() ? "error" : "ok",
        source: "ModelRegistry.getError",
        ...(modelRegistry.getError() ? { message: modelRegistry.getError() } : {}),
      };
      return health;
    },
    packageUpdateCheck: false,
  });
  const server = new PiHostServer({
    agentDir: layout.agentDir,
    sdkVersion: "test",
    getModelConfigHealth: () => health,
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      projectTrust: true,
      sessionExport: false,
    },
    handlers: {},
  });
  factory.bindServer(server);
  return {
    layout,
    authStorage,
    handlers: createProviderHandlers(factory),
  };
}

function draft(models: ProviderDraft["models"]): ProviderDraft {
  return {
    id: "custom",
    name: "Custom Gateway",
    baseUrl: "http://127.0.0.1:8317/v1",
    api: "openai-responses",
    authHeader: true,
    headers: { "X-Client": "pi-desktop" },
    models,
  };
}

describe("Provider controller", () => {
  it("preserves unrelated configuration and keeps API keys out of models.json", async () => {
    const { layout, authStorage, handlers } = setup({
      version: 1,
      providers: {
        other: {
          baseUrl: "https://other.example/v1",
          api: "openai-completions",
          models: [{ id: "other-model" }],
        },
        custom: {
          name: "Old name",
          baseUrl: "https://old.example/v1",
          api: "openai-completions",
          compat: { supportsDeveloperRole: false },
          models: [
            { id: "keep", compat: { supportsReasoningEffort: false } },
            { id: "hide" },
          ],
        },
      },
    });

    const outcome = await handlers["provider.save"]!({
      id: "save-1",
      params: {
        originalId: "custom",
        provider: draft([
          {
            id: "keep",
            name: "Keep",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200_000,
            maxTokens: 20_000,
          },
        ]),
        apiKey: "secret-key",
      },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.providers.other.models[0].id).toBe("other-model");
    expect(persisted.providers.custom.compat.supportsDeveloperRole).toBe(false);
    expect(persisted.providers.custom.models).toHaveLength(1);
    expect(persisted.providers.custom.models[0].compat.supportsReasoningEffort).toBe(false);
    expect(persisted.providers.custom.apiKey).toBeUndefined();
    expect(authStorage.get("custom")).toEqual({ type: "api_key", key: "secret-key" });
    if (!("error" in outcome)) {
      expect((outcome.result as { provider: { auth: { configured: boolean } } }).provider.auth.configured).toBe(true);
    }
  });

  it("marks only already enabled remote models as selected", async () => {
    const catalogServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ id: "enabled-model" }, { id: "grok-4.5" }, { id: "remote-only" }] }),
      );
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [{ id: "enabled-model", name: "Enabled" }],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-1",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    if (!("error" in outcome)) {
      const models = (outcome.result as {
        models: Array<{
          id: string;
          enabled: boolean;
          thinkingSource: string;
          thinkingLevelMap?: Record<string, string | null>;
        }>;
      }).models;
      expect(models).toEqual([
        expect.objectContaining({ id: "enabled-model", enabled: true }),
        expect.objectContaining({
          id: "grok-4.5",
          enabled: false,
          thinkingSource: "profile",
          thinkingLevelMap: expect.objectContaining({
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
          }),
        }),
        expect.objectContaining({ id: "remote-only", enabled: false }),
      ]);
    }
  });
});
