import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHostAgentSession } from "./agent-session-factory.js";
import { clearSessionModel } from "./no-model.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function provider(id: string, modelIds: string[]) {
  return {
    name: id,
    baseUrl: `https://${id}.example/v1`,
    api: "openai-completions",
    models: modelIds.map((modelId) => ({ id: modelId })),
  };
}

async function setup(
  config: Record<string, unknown>,
  credentials: Record<string, unknown> = {
    disabled: { type: "api_key", key: "disabled-test-key" },
    enabled: { type: "api_key", key: "enabled-test-key" },
  },
) {
  const layout = createTempAgentLayout("pideck-agent-session-policy-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(config));
  writeFileSync(join(layout.agentDir, "auth.json"), JSON.stringify(credentials));
  const { modelRuntime } = await createTestModelServices(layout.agentDir);
  return { layout, modelRuntime };
}

describe("createHostAgentSession Provider policy", () => {
  it("replaces a saved model whose Provider is disabled", async () => {
    const { layout, modelRuntime } = await setup({
      pideckEnabledProviders: ["enabled"],
      providers: {
        disabled: provider("disabled", ["disabled-model"]),
        enabled: provider("enabled", ["enabled-model"]),
      },
    });
    const sessionManager = SessionManager.inMemory(layout.projectDir);
    sessionManager.appendModelChange("disabled", "disabled-model");
    sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });
    const settingsManager = SettingsManager.inMemory(
      { defaultProvider: "disabled", defaultModel: "disabled-model" },
      { projectTrusted: true },
    );

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
    });

    expect(session.model).toMatchObject({ provider: "enabled", id: "enabled-model" });
    session.dispose();
  });

  it("constructs a model-less Session when the enabled list is explicitly empty", async () => {
    const { layout, modelRuntime } = await setup({
      pideckEnabledProviders: [],
      providers: {
        disabled: provider("disabled", ["disabled-model"]),
        enabled: provider("enabled", ["enabled-model"]),
      },
    });
    const sessionManager = SessionManager.inMemory(layout.projectDir);
    sessionManager.appendModelChange("disabled", "disabled-model");
    sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      sessionManager,
    });

    expect(session.model).toMatchObject({ provider: "unknown", id: "unknown" });
    session.dispose();
  });

  it("can clear an active model when every Provider is disabled", async () => {
    const { layout, modelRuntime } = await setup({
      pideckEnabledProviders: ["enabled"],
      providers: { enabled: provider("enabled", ["enabled-model"]) },
    });
    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      sessionManager: SessionManager.inMemory(layout.projectDir),
    });

    expect(session.model).toMatchObject({ provider: "enabled", id: "enabled-model" });
    await clearSessionModel(session);
    expect(session.model).toMatchObject({ provider: "unknown", id: "unknown" });
    session.dispose();
  });

  it("does not persist the no-model sentinel as the default Provider", async () => {
    const { layout, modelRuntime } = await setup({
      pideckEnabledProviders: [],
      providers: {
        disabled: provider("disabled", ["disabled-model"]),
        enabled: provider("enabled", ["enabled-model"]),
      },
    });
    const settingsManager = SettingsManager.create(layout.projectDir, layout.agentDir, {
      projectTrusted: true,
    });
    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(layout.projectDir),
    });

    expect(session.model).toMatchObject({ provider: "unknown", id: "unknown" });
    await settingsManager.flush();
    const settings = JSON.parse(readFileSync(join(layout.agentDir, "settings.json"), "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    expect(settings.defaultProvider).not.toBe("unknown");
    expect(settings.defaultModel).not.toBe("unknown");
    session.dispose();
  });

  it("honors a configured model allow-list during restoration", async () => {
    const { layout, modelRuntime } = await setup(
      {},
      { anthropic: { type: "api_key", key: "anthropic-test-key" } },
    );
    const [hidden, allowed] = modelRuntime.getModels("anthropic");
    if (!hidden || !allowed) throw new Error("Missing builtin Anthropic test models");
    writeFileSync(
      join(layout.agentDir, "models.json"),
      JSON.stringify({ pideckProviderModels: { anthropic: [allowed.id] } }),
    );
    const sessionManager = SessionManager.inMemory(layout.projectDir);
    sessionManager.appendModelChange("anthropic", hidden.id);
    sessionManager.appendMessage({ role: "user", content: "restore me", timestamp: Date.now() });

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      sessionManager,
    });

    expect(session.model).toMatchObject({ provider: "anthropic", id: allowed.id });
    session.dispose();
  });

  it("preserves SDK-native selection when no PiDeck policy exists", async () => {
    const { layout, modelRuntime } = await setup(
      {},
      { anthropic: { type: "api_key", key: "anthropic-test-key" } },
    );
    const preferred = modelRuntime.getModels("anthropic")[0];
    if (!preferred) throw new Error("Missing builtin Anthropic test model");

    const { session } = await createHostAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(
        { defaultProvider: "anthropic", defaultModel: preferred.id },
        { projectTrusted: true },
      ),
      sessionManager: SessionManager.inMemory(layout.projectDir),
    });

    expect(session.model).toMatchObject({ provider: "anthropic", id: preferred.id });
    session.dispose();
  });
});
