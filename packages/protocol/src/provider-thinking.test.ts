import { describe, expect, it } from "vitest";
import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";
import { MODEL_THINKING_PROFILES } from "./model-thinking-profiles.js";
import { detectModelThinking } from "./provider-thinking.js";

const ALL_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function availableLevels(map: ThinkingLevelMap | undefined): ThinkingLevel[] {
  return ALL_LEVELS.filter((level) => map?.[level] !== null && map?.[level] !== undefined);
}

describe("detectModelThinking", () => {
  it.each([
    ["gpt-5.6-sol", ["off", "low", "medium", "high", "xhigh", "max"]],
    ["openai/gpt-5.5", ["off", "low", "medium", "high", "xhigh"]],
    ["gpt-5.5-pro", ["medium", "high", "xhigh"]],
    ["gpt-5.4-mini", ["off", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-pro", ["medium", "high", "xhigh"]],
    ["gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.2", ["off", "low", "medium", "high", "xhigh"]],
    ["gpt-5.2-pro", ["medium", "high", "xhigh"]],
    ["gpt-5.1", ["off", "low", "medium", "high"]],
    ["gpt-5-pro", ["high"]],
    ["gpt-5", ["minimal", "low", "medium", "high"]],
    ["openai/gpt-oss-120b", ["low", "medium", "high"]],
    ["anthropic/claude-3-7-sonnet", ["off", "minimal", "low", "medium", "high"]],
    ["claude-opus-4-5", ["off", "minimal", "low", "medium", "high"]],
    ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-sonnet-4-6", ["low", "medium", "high", "max"]],
    ["claude-mythos-preview", ["low", "medium", "high", "max"]],
    ["gemini-3.7-flash", ["low", "medium", "high"]],
    ["gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
    ["google/gemini-3.1-pro-preview", ["low", "medium", "high"]],
    ["gemini-3-pro-preview", ["low", "high"]],
    ["gemini-3-pro-image-preview", ["high"]],
    ["gemini-3.1-flash-image", ["minimal", "high"]],
    ["gemini-3.1-flash-lite-image-preview", ["minimal", "high"]],
    ["gemini-2.5-flash-lite", ["off", "minimal", "low", "medium", "high"]],
    ["gemma-4-31b-it", ["minimal", "high"]],
    ["xai/grok-4.3", ["off", "low", "medium", "high"]],
    ["grok-4.5-latest", ["low", "medium", "high"]],
    ["grok-4.6", ["low", "medium", "high", "xhigh"]],
    ["z-ai/glm-5.3", ["low", "high", "max"]],
    ["z-ai/glm-5.2-air", ["off", "high", "max"]],
    ["glm-5.1", ["off", "high"]],
    ["deepseek-v4-pro", ["off", "low", "high", "max"]],
    ["deepseek-reasoner", ["high"]],
    ["qwen3-235b-a22b-thinking-2507", ["high"]],
    ["qwen3.6-plus", ["off", "high"]],
    ["qwen3.8-max", ["off", "high"]],
    ["qwen3.8-2.4t-a95b", ["off", "high"]],
    ["qwq-plus", ["high"]],
    ["kimi-k3", ["low", "high", "max"]],
    ["kimi-k2.7-code", ["high"]],
    ["kimi-k2.6", ["off", "high"]],
    ["mistral-medium-3-5", ["off", "high"]],
  ] satisfies Array<[string, ThinkingLevel[]]>)(
    "uses the exact built-in profile for %s",
    (modelId, expected) => {
      const result = detectModelThinking(modelId);
      expect(result.source).toBe("profile");
      expect(result.reasoning).toBe(true);
      expect(availableLevels(result.thinkingLevelMap)).toEqual(expected);
    },
  );

  it("maps off to the provider's none effort where supported", () => {
    expect(detectModelThinking("gpt-5.6").thinkingLevelMap?.off).toBe("none");
    expect(detectModelThinking("grok-4.3").thinkingLevelMap?.off).toBe("none");
  });

  it("prefers capability metadata over a known profile", () => {
    const result = detectModelThinking("gpt-5.6", {
      supported_reasoning_efforts: ["off", "low", "high"],
    });
    expect(result.source).toBe("provider");
    expect(availableLevels(result.thinkingLevelMap)).toEqual(["off", "low", "high"]);
  });

  it.each([
    "gpt-5.2-codex",
    "claude-opus-4-9",
    "gemini-2.0-flash",
    "grok-4.20-non-reasoning",
    "glm-4-32b-0414-128k",
    "qwen2.5-72b-instruct",
    "qwen3-coder-next",
    "qwen3-30b-a3b-instruct-2507",
  ])("does not overmatch unsupported sibling %s", (modelId) => {
    expect(detectModelThinking(modelId).source).toBe("default");
  });

  it("marks unknown reasoning model names as inferred", () => {
    expect(detectModelThinking("vendor-reasoning-model")).toEqual({
      reasoning: true,
      source: "inferred",
    });
  });

  it("keeps an official documentation source on every profile", () => {
    for (const profile of MODEL_THINKING_PROFILES) {
      expect(profile.documentationUrl).toMatch(/^https:\/\//);
    }
  });
});
