/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  ModelSummary,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ModelControls } from "./ModelControls";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5",
  name: "Grok 4.5",
  thinkingLevels: ["off", "high"],
};

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    model: MODEL,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    contextUsage: { tokens: 0, contextWindow: 100_000 },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("ModelControls model menu resizing", () => {
  const initialInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: initialInnerWidth,
    });
    useAppStore.getState().setDesktopSettings(null);
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
  });

  it("keeps the measured default and widens from the fixed left edge", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "muapi/Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });
    const resizeHandle = screen.getByRole("separator", { name: "Resize model menu" });
    const menuShell = resizeHandle.parentElement;
    expect(menuShell).toHaveStyle({ width: "120px" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "120");

    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      right: 220,
      top: 100,
      bottom: 300,
      width: 120,
      height: 200,
      toJSON: () => ({}),
    });
    Object.assign(resizeHandle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 220, pointerId: 7 });
    fireEvent.pointerMove(resizeHandle, { clientX: 520, pointerId: 7 });

    await waitFor(() => expect(menuShell).toHaveStyle({ width: "420px" }));
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "420");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(menuShell).toHaveStyle({ width: "440px" });
    fireEvent.pointerUp(resizeHandle, { pointerId: 7 });
    expect(resizeHandle.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
