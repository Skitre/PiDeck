import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "./bridge/host-client";
import { useAppStore } from "./stores/app-store";
import { exportFileName, requestExport } from "./export-actions";

const saveMock = vi.fn<() => Promise<string | null>>();
const invokeMock = vi.fn(async () => undefined);

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...(args as [])),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
}));

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
    name: "My session",
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

function exportEnvelope(path: string): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method: "session.export",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result: { path },
  } as HostResponseEnvelope;
}

describe("exportFileName", () => {
  it("uses the session name and strips filesystem-hostile characters", () => {
    expect(exportFileName('a/b:c?"d"', SESSION_ID, "html")).toBe("a-b-c--d-.html");
    expect(exportFileName(undefined, SESSION_ID, "jsonl")).toBe("session-33333333.jsonl");
  });
});

describe("requestExport", () => {
  beforeEach(() => {
    saveMock.mockReset();
    invokeMock.mockClear();
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
  });

  function notifications() {
    return useAppStore.getState().notifications.map(({ message, level }) => ({
      message,
      level,
    }));
  }

  it("exports to the chosen path and reveals the file", async () => {
    saveMock.mockResolvedValue("/tmp/out.html");
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(exportEnvelope("/tmp/out.html") as never);

    await expect(requestExport("html")).resolves.toBe(true);

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "My session.html" }),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "session.export",
      EXPECTED_CONTEXT,
      { format: "html", path: "/tmp/out.html" },
      null,
    );
    expect(notifications()).toEqual([{ message: "Exported to /tmp/out.html", level: "info" }]);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_open_path", {
        path: "/tmp/out.html",
      }),
    );
  });

  it("does nothing when the save dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    const request = vi.spyOn(hostClient, "request");

    await expect(requestExport("jsonl")).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  it("refuses while the agent is busy without opening the dialog", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false }));

    await expect(requestExport("html")).resolves.toBe(false);

    expect(saveMock).not.toHaveBeenCalled();
    expect(notifications()).toEqual([
      { message: "Wait for the agent to finish before exporting", level: "info" },
    ]);
  });

  it("surfaces host export errors", async () => {
    saveMock.mockResolvedValue("/tmp/out.jsonl");
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...exportEnvelope("/tmp/out.jsonl"),
      ok: false,
      result: undefined,
      error: { code: "INTERNAL_ERROR", message: "disk full" },
    } as never);

    await expect(requestExport("jsonl")).resolves.toBe(false);

    expect(notifications()).toEqual([{ message: "disk full", level: "error" }]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
