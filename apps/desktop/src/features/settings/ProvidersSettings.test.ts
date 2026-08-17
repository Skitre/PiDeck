import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from "@pideck/protocol";
import {
  automaticThinkingConfig,
  newProviderModel,
  providerDraftForSave,
  providerSaveFailureMessage,
  shouldOpenAdvancedEndpoint,
} from "./provider-settings-model";

describe("newProviderModel", () => {
  it("creates a conservative manual model draft for an unknown model", () => {
    expect(newProviderModel("vendor-new-model")).toEqual({
      id: "vendor-new-model",
      name: "vendor-new-model",
      reasoning: false,
      input: ["text"],
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      enabled: true,
      thinkingSource: "default",
    });
  });

  it("applies the maintained profile when the model is recognized", () => {
    expect(newProviderModel("grok-4.5")).toMatchObject({
      reasoning: true,
      thinkingSource: "profile",
      thinkingLevelMap: {
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
  });
});

describe("automaticThinkingConfig", () => {
  it("enables generic automatic reasoning for an unknown model", () => {
    expect(automaticThinkingConfig("vendor-new-model")).toEqual({
      reasoning: true,
      thinkingLevelMap: undefined,
      thinkingSource: "default",
    });
  });

  it("keeps the exact level map for a known model profile", () => {
    expect(automaticThinkingConfig("grok-4.5")).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      thinkingSource: "profile",
    });
  });

  it("uses off, high, and max for the GLM-5.2 Auto profile", () => {
    expect(automaticThinkingConfig("glm-5.2")).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      thinkingSource: "profile",
    });
  });

  it("uses the sourced GPT-5.6 effort matrix in Auto mode", () => {
    expect(automaticThinkingConfig("openai/gpt-5.6-terra")).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      thinkingSource: "profile",
    });
  });
});

describe("shouldOpenAdvancedEndpoint", () => {
  it("keeps unused optional endpoint settings collapsed", () => {
    expect(shouldOpenAdvancedEndpoint(undefined)).toBe(false);
    expect(shouldOpenAdvancedEndpoint("  ")).toBe(false);
  });

  it("reveals an existing custom Models URL", () => {
    expect(shouldOpenAdvancedEndpoint("https://catalog.example/v1/models")).toBe(true);
  });
});

describe("providerDraftForSave", () => {
  const baseDraft = {
    id: "relay",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
    modelsUrl: "",
    api: "openai-completions" as const,
    headers: { "User-Agent": "PiDeck/0.1" },
    compat: {
      supportsDeveloperRole: null,
      supportsReasoningEffort: null,
    },
    models: [],
  };

  it("builds a legacy-compatible payload when advanced options are unused", () => {
    expect(providerDraftForSave(baseDraft)).toEqual({
      id: "relay",
      name: "Relay",
      baseUrl: "https://relay.example/v1",
      api: "openai-completions",
      authHeader: true,
      headers: { "User-Agent": "PiDeck/0.1" },
      models: [],
    });
  });

  it("keeps new endpoint and compatibility fields when they are needed", () => {
    expect(
      providerDraftForSave(
        {
          ...baseDraft,
          modelsUrl: "  https://relay.example/catalog  ",
          api: "anthropic-messages",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: null,
          },
        },
        true,
      ),
    ).toMatchObject({
      modelsUrl: "https://relay.example/catalog",
      api: "anthropic-messages",
      authHeader: false,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: null,
      },
    });
  });

  it("explains how to recover when an old Host rejects advanced fields", () => {
    const provider = providerDraftForSave({
      ...baseDraft,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: null,
      },
    });
    expect(providerSaveFailureMessage("invalid provider.save params", provider)).toContain(
      "Restart Host in Host settings",
    );
  });
});
