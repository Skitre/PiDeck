import { describe, expect, it, vi } from "vitest";
import { AgentSession, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { applyKnownThinkingProfiles, rebindCurrentSessionModel } from "./model-thinking.js";

describe("applyKnownThinkingProfiles", () => {
  it("applies Grok 4.5 levels without replacing an explicit map", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider("test-profile", {
      baseUrl: "http://localhost:8317/v1",
      apiKey: "test",
      api: "openai-completions",
      models: [
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
        {
          id: "grok-4.5-custom",
          name: "Grok custom",
          reasoning: true,
          thinkingLevelMap: { minimal: "tiny" },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    });

    expect(applyKnownThinkingProfiles(registry)).toBeGreaterThanOrEqual(1);
    expect(registry.find("test-profile", "grok-4.5")?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
    });
    expect(registry.find("test-profile", "grok-4.5-custom")?.thinkingLevelMap).toEqual({
      minimal: "tiny",
    });
  });

  it("rebinds a live session to the refreshed registry model", () => {
    const previous = { provider: "muapi", id: "grok-4.5" };
    const refreshed = {
      provider: "muapi",
      id: "grok-4.5",
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    };
    const state = { model: previous };
    const setThinkingLevel = vi.fn();
    const session = {
      model: previous,
      state,
      thinkingLevel: "high",
      setThinkingLevel,
    } as unknown as AgentSession;
    const registry = {
      find: () => refreshed,
    } as unknown as ModelRegistry;

    expect(rebindCurrentSessionModel(session, registry)).toBe(true);
    expect(state.model).toBe(refreshed);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
  });
});
