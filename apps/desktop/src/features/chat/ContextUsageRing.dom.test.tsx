/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ContextUsageRing } from "./ModelControls";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

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

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    contextUsage: { tokens: 50_000, contextWindow: 100_000 },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

const ESTIMATED_BREAKDOWN = {
  systemPrompt: 1_000,
  toolDefinitions: 500,
  userPrompts: 500,
  assistantMessages: 1_000,
  toolResults: 500,
  summaries: 1_000,
  other: 500,
};

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

describe("ContextUsageRing panel", () => {
  beforeEach(() => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("opens on click and runs manual compaction", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.compact", {
        result: { summary: "s", tokensBefore: 50_000, estimatedTokensAfter: 5_000 },
        session: session(),
      }) as never,
    );
    const user = userEvent.setup();
    render(<ContextUsageRing />);

    expect(screen.queryByRole("button", { name: "Compact now" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "50k / 100k context tokens" }));
    await user.click(screen.getByRole("button", { name: "Compact now" }));

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("agent.compact", EXPECTED_CONTEXT, null, null);
    expect(
      useAppStore.getState().notifications.map(({ message, level }) => ({ message, level })),
    ).toEqual([{ message: "Context compacted: 50k → 5k tokens", level: "info" }]);
  });

  it("disables Compact now while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    const user = userEvent.setup();
    render(<ContextUsageRing />);

    await user.click(screen.getByRole("button", { name: "50k / 100k context tokens" }));

    expect(screen.getByRole("button", { name: "Compact now" })).toBeDisabled();
  });

  it("shows a local usage estimate immediately after compaction", async () => {
    useAppStore.getState().applySessionSnapshot(
      session({
        contextUsage: {
          tokens: null,
          contextWindow: 100_000,
          breakdown: ESTIMATED_BREAKDOWN,
        },
      }),
    );
    const user = userEvent.setup();
    render(<ContextUsageRing />);

    const usageButton = screen.getByRole("button", {
      name: "Approximately 5k / 100k context tokens",
    });
    expect(usageButton).toHaveTextContent("~5%");

    await user.click(usageButton);
    expect(screen.getByText("Approximately 5k / 100k context tokens")).toBeVisible();
    expect(
      screen.getByText(
        "Total and composition are estimated locally until the next model response.",
      ),
    ).toBeVisible();
  });

  it("keeps usage unknown when no exact or estimated total is available", () => {
    useAppStore
      .getState()
      .applySessionSnapshot(session({ contextUsage: { tokens: null, contextWindow: 100_000 } }));
    render(<ContextUsageRing />);

    const usageButton = screen.getByRole("button", {
      name: "Context usage unknown / 100k tokens",
    });
    expect(usageButton).toHaveTextContent("--");
  });

  it("toggles auto-compaction through the switch", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(
        envelope("agent.setAutoCompaction", session({ autoCompactionEnabled: false })) as never,
      );
    const user = userEvent.setup();
    render(<ContextUsageRing />);

    await user.click(screen.getByRole("button", { name: "50k / 100k context tokens" }));
    const toggle = screen.getByRole("switch", { name: "Toggle auto-compaction" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("agent.setAutoCompaction", EXPECTED_CONTEXT, {
      enabled: false,
    });
    await waitFor(() => expect(useAppStore.getState().session?.autoCompactionEnabled).toBe(false));
    expect(screen.getByRole("switch", { name: "Toggle auto-compaction" })).not.toBeChecked();
  });
});
