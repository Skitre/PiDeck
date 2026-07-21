import { describe, expect, it } from "vitest";
import type { ModelSummary } from "@pideck/protocol";
import { includeCurrentModel, modelOptionLabel, thinkingLevelsForModel } from "./ModelControls";

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

  it("does not reinsert a model from a disabled Provider", () => {
    expect(includeCurrentModel([], current, ["other-provider"])).toEqual([]);
  });

  it("keeps the current model when its Provider is one of several enabled", () => {
    expect(includeCurrentModel([], current, ["other-provider", "muapi"])).toEqual([current]);
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

describe("modelOptionLabel", () => {
  it("prefixes the display name with the Provider ID", () => {
    expect(modelOptionLabel(current)).toBe("muapi/Grok 4.5");
  });
});
