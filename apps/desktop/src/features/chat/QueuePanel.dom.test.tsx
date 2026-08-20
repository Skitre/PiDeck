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
import { buildAttachmentReferenceBlock } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { QueuePanel } from "./QueuePanel";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "agentBusy",
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

function session(sessionId: string, followUp: string[]): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision: 3,
    isStreaming: true,
    isIdle: false,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 7, steering: ["steer"], followUp },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function runNowResponse(): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "run-now-test",
    method: "agent.runNow",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result: {
      started: true,
      runId: RUN_ID,
      settled: true,
      queueRestored: true,
      partialFailure: false,
      queue: { revision: 8, steering: ["steer"], followUp: ["later"] },
    },
  };
}

describe("QueuePanel Run Now", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session(SESSION_A, ["run this", "later"]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("uses one Session-pinned transaction and ignores its result after a Session switch", async () => {
    let resolveRequest!: (response: HostResponseEnvelope) => void;
    const response = new Promise<HostResponseEnvelope>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi.spyOn(hostClient, "request").mockImplementation(() => response as never);
    const user = userEvent.setup();
    render(<QueuePanel />);

    await user.click(
      screen.getAllByRole("button", {
        name: "Interrupt current run and run this now",
      })[0]!,
    );

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      "agent.runNow",
      {
        expectedHostInstanceId: HOST_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedWorkspaceRevision: 1,
        expectedSessionId: SESSION_A,
        expectedSessionRevision: 3,
      },
      { expectedRevision: 7, followUpIndex: 0 },
    );

    useAppStore.getState().applySessionSnapshot(session(SESSION_B, []));
    resolveRequest(runNowResponse());

    await waitFor(() => {
      expect(useAppStore.getState().session?.sessionId).toBe(SESSION_B);
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["agent.runNow"]);
  });

  it("does not replace a newer queue event with an older Run Now response", async () => {
    let resolveRequest!: (response: HostResponseEnvelope) => void;
    const response = new Promise<HostResponseEnvelope>((resolve) => {
      resolveRequest = resolve;
    });
    vi.spyOn(hostClient, "request").mockImplementation(() => response as never);
    const user = userEvent.setup();
    render(<QueuePanel />);
    const runButton = screen.getAllByRole("button", {
      name: "Interrupt current run and run this now",
    })[0]!;

    await user.click(runButton);
    const newer = session(SESSION_A, ["already advanced"]);
    newer.pending.revision = 9;
    useAppStore.getState().applySessionSnapshot(newer);
    resolveRequest(runNowResponse());

    await waitFor(() => expect(runButton).toBeEnabled());
    expect(useAppStore.getState().session?.pending).toEqual({
      revision: 9,
      steering: ["steer"],
      followUp: ["already advanced"],
    });
  });

  it("hides and preserves managed attachment references while editing", async () => {
    const marker = buildAttachmentReferenceBlock([
      {
        id: "66666666-6666-4666-8666-666666666666",
        name: "brief.pdf",
        mediaType: "application/pdf",
        sizeBytes: 2048,
        status: "ready",
        unit: "page",
        unitCount: 2,
      },
    ]);
    useAppStore.getState().applySessionSnapshot(session(SESSION_A, [`review this\n\n${marker}`]));
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { queue: { revision: 8, steering: ["steer"], followUp: [] } },
    } as never);
    const user = userEvent.setup();
    render(<QueuePanel />);

    expect(screen.getByText("review this")).toBeVisible();
    expect(screen.queryByText(/pideck-attachments/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit queued message" });
    await user.clear(editor);
    await user.type(editor, "review carefully");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const queued = request.mock.calls[0]?.[2] as { followUp: string[] };
    expect(queued.followUp[0]).toContain("review carefully");
    expect(queued.followUp[0]).toContain("<pideck-attachments");
    expect(queued.followUp[0]).toContain("brief.pdf");
  });
});
