import { describe, expect, it, vi } from "vitest";
import type { ModelSummary } from "@pideck/protocol";
import {
  canRequestModelList,
  includeCurrentModel,
  modelOptionLabel,
  requestModelListWithRetry,
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

describe("requestModelListWithRetry", () => {
  it("retries transient failures until the model list succeeds", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "STALE_REVISION", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { models: [current] } });
    const wait = vi.fn(async () => {});

    const result = await requestModelListWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { models: [current] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });

  it("does not retry a non-retryable failure", async () => {
    const response = {
      ok: false as const,
      error: { code: "INTERNAL_ERROR", retryable: false },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestModelListWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops after five retryable failures", async () => {
    const response = {
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestModelListWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls).toEqual([[80], [160], [240], [320]]);
  });

  it("cancels retries when the request generation changes", async () => {
    let active = true;
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    }));
    const wait = vi.fn(async () => {
      active = false;
    });

    await expect(
      requestModelListWithRetry(request, wait, () => active),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
