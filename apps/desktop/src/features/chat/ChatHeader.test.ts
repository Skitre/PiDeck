import { describe, expect, it } from "vitest";
import type { ModelSummary } from "@pideck/protocol";
import { includeCurrentModel, thinkingLevelsForModel } from "./ChatHeader";

const current: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5",
  name: "Grok 4.5",
};

describe("includeCurrentModel", () => {
  it("shows the selected model before model.list completes", () => {
    expect(includeCurrentModel([], current)).toEqual([current]);
  });

  it("does not duplicate a selected model returned by model.list", () => {
    expect(includeCurrentModel([current], current)).toEqual([current]);
  });

  it("uses the selected model's own thinking levels", () => {
    const models: ModelSummary[] = [
      { ...current, thinkingLevels: ["low", "medium", "high"] },
      {
        provider: "muapi",
        modelId: "grok-composer-2.5-fast",
        name: "Grok Composer",
        thinkingLevels: ["off"],
      },
    ];
    expect(thinkingLevelsForModel(models, current, ["off"])).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(thinkingLevelsForModel(models, models[1], ["low"])).toEqual(["off"]);
  });
});
