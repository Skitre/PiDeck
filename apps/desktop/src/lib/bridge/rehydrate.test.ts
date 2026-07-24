import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock, getHostInstanceIdMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  getHostInstanceIdMock: vi.fn(),
}));

vi.mock("./host-client", () => ({
  hostClient: {
    request: requestMock,
    getHostInstanceId: getHostInstanceIdMock,
  },
}));

import { fullRehydrate, resolveRehydrateHostInstanceId } from "./rehydrate";

beforeEach(() => {
  requestMock.mockReset();
  getHostInstanceIdMock.mockReset();
});

describe("resolveRehydrateHostInstanceId", () => {
  it("keeps the Host identity returned by hello during restart recovery", () => {
    expect(resolveRehydrateHostInstanceId("hello-host", null)).toBe("hello-host");
    expect(resolveRehydrateHostInstanceId("hello-host", "stale-host")).toBe(
      "hello-host",
    );
  });

  it("falls back to the client identity outside an explicit recovery", () => {
    expect(resolveRehydrateHostInstanceId(undefined, "current-host")).toBe(
      "current-host",
    );
    expect(resolveRehydrateHostInstanceId(undefined, null)).toBeNull();
  });
});

describe("fullRehydrate", () => {
  it("reads Host, Workspace, Session, tools, and packages in generation order", async () => {
    const host = {
      hostInstanceId: "host-2",
      workspaceId: "workspace-2",
      workspaceRevision: 4,
      sessionId: "session-2",
      sessionRevision: 6,
      packageRevision: 3,
    };
    const workspace = {
      id: "workspace-2",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    };
    const session = {
      sessionId: "session-2",
      revision: 6,
      tools: { revision: 1, tools: [], active: [] },
    };
    const tools = { revision: 2, tools: [], active: [] };
    const packages = {
      revision: 3,
      workspaceId: "workspace-2",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    };
    requestMock
      .mockResolvedValueOnce({ ok: true, result: host })
      .mockResolvedValueOnce({ ok: true, result: workspace })
      .mockResolvedValueOnce({ ok: true, result: session })
      .mockResolvedValueOnce({ ok: true, result: tools })
      .mockResolvedValueOnce({ ok: true, result: packages });

    await expect(fullRehydrate("host-2")).resolves.toEqual({
      host,
      workspace,
      session,
      tools,
      packages,
    });
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual([
      "system.getStatus",
      "workspace.getCurrent",
      "session.getSnapshot",
      "agent.getTools",
      "package.list",
    ]);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ expectedHostInstanceId: "host-2" });
    expect(requestMock.mock.calls[2]?.[1]).toMatchObject({
      expectedHostInstanceId: "host-2",
      expectedWorkspaceId: "workspace-2",
      expectedWorkspaceRevision: 4,
    });
    expect(requestMock.mock.calls[3]?.[1]).toMatchObject({
      expectedSessionId: "session-2",
      expectedSessionRevision: 6,
    });
  });

  it("stops after Workspace lookup when no Workspace is selected", async () => {
    const host = {
      hostInstanceId: "host-3",
      workspaceId: null,
      workspaceRevision: 0,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
    };
    getHostInstanceIdMock.mockReturnValue("host-3");
    requestMock
      .mockResolvedValueOnce({ ok: true, result: host })
      .mockResolvedValueOnce({ ok: true, result: null });

    await expect(fullRehydrate()).resolves.toEqual({
      host,
      workspace: null,
      session: null,
      packages: null,
      tools: null,
    });
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual([
      "system.getStatus",
      "workspace.getCurrent",
    ]);
  });
});
