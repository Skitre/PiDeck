/**
 * T9: 0.84.2 ProviderConfig.oauth.refreshToken(credentials, signal).
 *
 * Host has no first-party refreshToken. Search of Host, desktop, and
 * test-fixtures found only logger redaction and the fixture scanner field
 * name. Dynamic extensions may still register a one-argument callback; the
 * SDK composer must keep passing AbortSignal so abort is not dropped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function modelEntry(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

describe("extension OAuth refreshToken abort signal", () => {
  it("invokes a one-argument refreshToken with the operation AbortSignal", async () => {
    const layout = createTempAgentLayout("pideck-oauth-refresh-");
    layouts.push(layout);
    const { credentialStore, modelRuntime, modelRegistry } = await createTestModelServices(
      layout.agentDir,
    );
    const received: unknown[][] = [];
    modelRegistry.registerProvider("corp-oauth", {
      name: "Corp",
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      models: [modelEntry("m1")],
      oauth: {
        name: "Corp SSO",
        login: async () => ({
          refresh: "r-login",
          access: "a-login",
          expires: Date.now() + 3_600_000,
        }),
        refreshToken: async (credentials, ...rest) => {
          received.push([credentials, ...rest]);
          return { ...credentials, access: "a-rotated", expires: Date.now() + 3_600_000 };
        },
        getApiKey: (credentials) => credentials.access,
      },
    });
    await credentialStore.modify("corp-oauth", async () => ({
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: 1,
    }));
    const controller = new AbortController();

    const auth = await modelRuntime.getAuth(modelRegistry.find("corp-oauth", "m1")!, {
      signal: controller.signal,
    });

    expect(received).toHaveLength(1);
    expect(received[0]![1]).toBeInstanceOf(AbortSignal);
    expect(auth?.auth.apiKey).toBe("a-rotated");
  });

  it("rejects getAuth when the caller aborts a hanging one-argument refreshToken", async () => {
    const layout = createTempAgentLayout("pideck-oauth-abort-");
    layouts.push(layout);
    const { credentialStore, modelRuntime, modelRegistry } = await createTestModelServices(
      layout.agentDir,
    );
    modelRegistry.registerProvider("hang-oauth", {
      name: "Hang",
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      models: [modelEntry("m1")],
      oauth: {
        name: "Hang SSO",
        login: async () => ({
          refresh: "r-login",
          access: "a-login",
          expires: Date.now() + 3_600_000,
        }),
        refreshToken: async function refreshToken(_credentials) {
          await new Promise(() => {});
          return _credentials;
        },
        getApiKey: (credentials) => credentials.access,
      },
    });
    await credentialStore.modify("hang-oauth", async () => ({
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: 1,
    }));
    const controller = new AbortController();
    const pending = modelRuntime.getAuth(modelRegistry.find("hang-oauth", "m1")!, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});
