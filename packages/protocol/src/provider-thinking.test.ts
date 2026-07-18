import { describe, expect, it } from "vitest";
import { detectModelThinking } from "./provider-thinking.js";

describe("detectModelThinking", () => {
  it("uses the Grok 4.5 profile without minimal or off", () => {
    expect(detectModelThinking("grok-4.5")).toEqual({
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
      source: "profile",
    });
  });

  it("prefers capability metadata over a known profile", () => {
    const result = detectModelThinking("grok-4.5", {
      supported_reasoning_efforts: ["off", "low", "high"],
    });
    expect(result.source).toBe("provider");
    expect(result.thinkingLevelMap).toMatchObject({
      off: "off",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
    });
  });

  it("marks unknown reasoning model names as inferred", () => {
    expect(detectModelThinking("vendor-reasoning-model")).toEqual({
      reasoning: true,
      source: "inferred",
    });
  });
});
