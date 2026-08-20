/**
 * Auth compatibility against the real 0.82.1 runtime (PR-4).
 *
 * Each test drives the exact resolution path a request uses in production —
 * ModelRuntime.getAuth / ModelRegistry.getApiKeyAndHeaders over a real
 * models.json and the PiDeck FileCredentialStore — never a reimplementation.
 * Covers the §11 gate "API key 重启后丢失" and the environment / header-only /
 * custom-header rows of the PR-4 matrix.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices, putApiKey } from "./test-helpers/model-runtime.js";

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function modelEntry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...extra,
  };
}

function layoutWithProviders(providers: Record<string, unknown>): TempAgentLayout {
  const layout = createTempAgentLayout("pideck-auth-compat-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify({ providers }, null, 2));
  return layout;
}

describe("API key persistence across a Host restart", () => {
  it("resolves the same stored key through a freshly created runtime", async () => {
    const layout = layoutWithProviders({
      custom: {
        name: "Custom",
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        models: [modelEntry("m1")],
      },
    });

    const first = await createTestModelServices(layout.agentDir);
    await putApiKey(first.credentialStore, "custom", "sk-survives-restart");
    const before = await first.modelRegistry.getApiKeyAndHeaders(
      first.modelRegistry.find("custom", "m1")!,
    );
    expect(before).toMatchObject({ ok: true, apiKey: "sk-survives-restart" });

    // A restart is a new ModelRuntime and a new FileCredentialStore over the
    // same agent directory — nothing carried over in memory.
    const second = await createTestModelServices(layout.agentDir);
    const after = await second.modelRegistry.getApiKeyAndHeaders(
      second.modelRegistry.find("custom", "m1")!,
    );
    expect(after).toMatchObject({ ok: true, apiKey: "sk-survives-restart" });
  });
});

describe("environment-backed auth", () => {
  it("resolves a models.json $VAR api key from the process environment", async () => {
    const layout = layoutWithProviders({
      envkey: {
        name: "Env Key",
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        apiKey: "$PIDECK_AUTH_COMPAT_ENV",
        models: [modelEntry("m1")],
      },
    });

    process.env.PIDECK_AUTH_COMPAT_ENV = "from-process-env";
    try {
      const { modelRegistry } = await createTestModelServices(layout.agentDir);
      const auth = await modelRegistry.getApiKeyAndHeaders(modelRegistry.find("envkey", "m1")!);
      expect(auth).toMatchObject({ ok: true, apiKey: "from-process-env" });
    } finally {
      delete process.env.PIDECK_AUTH_COMPAT_ENV;
    }
  });

  it("resolves a builtin provider from its ambient env var with no stored credential", async () => {
    const layout = layoutWithProviders({});
    const previous = process.env.ANTHROPIC_API_KEY;
    // A developer machine may carry ANTHROPIC_AUTH_TOKEN, which the runtime
    // prefers over ANTHROPIC_API_KEY — stash it so the test sees only the key.
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ambient-never-real";
    try {
      const { modelRuntime, modelRegistry } = await createTestModelServices(layout.agentDir);
      const model = modelRegistry.getAll().find((m) => m.provider === "anthropic");
      expect(model).toBeDefined();

      const resolution = await modelRuntime.getAuth(model!);
      expect(resolution?.auth.apiKey).toBe("sk-ambient-never-real");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
      if (previousToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
  });
});

describe("header-only provider", () => {
  it("pins the compat/stream divergence: getApiKeyAndHeaders succeeds, getAuth does not resolve", async () => {
    const layout = layoutWithProviders({
      headeronly: {
        name: "Header Only",
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        headers: { "X-Gateway-Token": "gw-token-never-real" },
        models: [modelEntry("m1")],
      },
    });

    const { modelRuntime, modelRegistry } = await createTestModelServices(layout.agentDir);
    const model = modelRegistry.find("headeronly", "m1")!;

    // Compatibility surface: headers without a key are a success...
    const compat = await modelRegistry.getApiKeyAndHeaders(model);
    expect(compat).toEqual({ ok: true, headers: { "X-Gateway-Token": "gw-token-never-real" } });

    // ...but the streaming path (prepareRequest → getAuth) does not resolve,
    // so chat and compaction would report "Provider is not configured". A
    // connection check must not be read as proof that requests will work.
    expect(await modelRuntime.getAuth(model)).toBeUndefined();
  });
});

describe("custom headers", () => {
  it("merges per-model headers over provider headers case-insensitively", async () => {
    const layout = layoutWithProviders({
      headed: {
        name: "Headed",
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        headers: { "X-Shared": "provider-level", "X-Provider-Only": "keep" },
        models: [modelEntry("m1", { headers: { "x-shared": "model-level" } })],
      },
    });

    const { credentialStore, modelRuntime, modelRegistry } = await createTestModelServices(
      layout.agentDir,
    );
    await putApiKey(credentialStore, "headed", "sk-headed");
    const model = modelRegistry.find("headed", "m1")!;

    const resolution = await modelRuntime.getAuth(model);
    expect(resolution?.auth.apiKey).toBe("sk-headed");
    const headers = resolution?.auth.headers ?? {};
    const shared = Object.entries(headers).filter(([k]) => k.toLowerCase() === "x-shared");
    // Exactly one survivor, and the model-level value won.
    expect(shared).toEqual([[expect.any(String), "model-level"]]);
    expect(headers["X-Provider-Only"]).toBe("keep");
  });

  it("keeps Model.headers null sentinels for the SDK request surface", async () => {
    // 0.84.2 ProviderHeaders is Record<string, string | null>. The SDK stream
    // path must see null so it can delete an inherited header. Host-built HTTP
    // headers still drop nulls before they become a wire value.
    const layout = layoutWithProviders({});
    const { modelRegistry } = await createTestModelServices(layout.agentDir);
    modelRegistry.registerProvider("nulled", {
      name: "Nulled",
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      apiKey: "sk-nulled",
      models: [modelEntry("m1")] as never,
    });

    const model = modelRegistry.find("nulled", "m1")!;
    const withSentinel = {
      ...model,
      headers: { "X-Keep": "1", "X-Drop": null },
    } as unknown as typeof model;

    const auth = await modelRegistry.getApiKeyAndHeaders(withSentinel);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.headers?.["X-Keep"]).toBe("1");
      expect(auth.headers?.["X-Drop"]).toBeNull();
    }
  });
});
