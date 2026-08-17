import { describe, expect, it } from "vitest";
import type { ModelSummary } from "@pideck/protocol";
import {
  canRequestModelList,
  clampModelMenuWidth,
  includeCurrentModel,
  modelMenuMaxWidth,
  modelOptionLabel,
  thinkingLevelLabel,
  thinkingLevelsForModel,
} from "./ModelControls";

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
    expect(thinkingLevelsForModel(models, current, ["off"])).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelsForModel(models, models[1], ["low"])).toEqual(["off"]);
  });
});

describe("modelOptionLabel", () => {
  it("prefixes the display name with the Provider ID", () => {
    expect(modelOptionLabel(current)).toBe("muapi/Grok 4.5");
  });
});

describe("model menu resize geometry", () => {
  it("keeps the current minimum while allowing a wider user-selected width", () => {
    expect(clampModelMenuWidth(80, 100, 1_000)).toBe(120);
    expect(clampModelMenuWidth(420, 100, 1_000)).toBe(420);
    expect(clampModelMenuWidth(900, 100, 1_000)).toBe(640);
  });

  it("reserves viewport room for the thinking-level submenu", () => {
    expect(modelMenuMaxWidth(100, 700)).toBe(468);
    expect(clampModelMenuWidth(600, 100, 700)).toBe(468);
  });
});

describe("thinkingLevelLabel", () => {
  it("keeps model thinking levels in English", () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh"].map(thinkingLevelLabel)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
    ]);
    expect(thinkingLevelLabel("provider-specific")).toBe("provider-specific");
  });
});

describe("canRequestModelList", () => {
  const ready = {
    hasHost: true,
    hasWorkspace: true,
    hasSession: true,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
  };

  it("waits until recovery has a synchronized Host generation", () => {
    expect(canRequestModelList(ready)).toBe(true);
    expect(canRequestModelList({ ...ready, connecting: true })).toBe(false);
    expect(canRequestModelList({ ...ready, rehydrating: true })).toBe(false);
    expect(canRequestModelList({ ...ready, desynchronized: true })).toBe(false);
    expect(canRequestModelList({ ...ready, hasSession: false })).toBe(false);
  });
});
