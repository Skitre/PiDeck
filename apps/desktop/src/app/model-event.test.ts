import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pi-desktop/protocol";
import { useAppStore } from "../lib/stores/app-store";
import { applyModelChanged } from "./App";

function session(): SessionSnapshot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "C:\\workspace",
    revision: 7,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    pending: { steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 3,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionRevision: 7,
      tools: [],
      active: [],
    },
  };
}

describe("model.changed projection", () => {
  beforeEach(() => {
    useAppStore.setState({
      session: session(),
      thinkingLevels: ["off"],
    });
  });

  it("updates selected model, thinking level, and same-generation options", () => {
    applyModelChanged({
      model: {
        provider: "test-provider",
        modelId: "test-model",
        name: "Test Model",
      },
      thinkingLevel: "high",
      availableThinkingLevels: ["off", "low", "high"],
    });

    const state = useAppStore.getState();
    expect(state.session?.revision).toBe(7);
    expect(state.session?.model).toMatchObject({
      provider: "test-provider",
      modelId: "test-model",
    });
    expect(state.session?.thinkingLevel).toBe("high");
    expect(state.thinkingLevels).toEqual(["off", "low", "high"]);
  });
});
