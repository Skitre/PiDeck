import { describe, expect, it } from "vitest";
import { automaticThinkingConfig } from "./ProvidersSettings";

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
});
