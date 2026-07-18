import { describe, expect, it } from "vitest";
import {
  applySessionSnapshot,
  applyWorkspaceSnapshot,
  beginHostEpoch,
  emptyEpoch,
  noteSequence,
} from "./epoch-store.js";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@pideck/protocol";

const host = (id: string): HostStatusSnapshot =>
  ({
    hostInstanceId: id,
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    protocolVersion: 1,
    sdkVersion: "0.80.7",
    nodeVersion: "v22",
    agentDir: "/tmp",
    phase: "waitingForWorkspace",
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      projectTrust: true,
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  }) as HostStatusSnapshot;

describe("epoch-store", () => {
  it("beginHostEpoch clears prior workspace/session/packages", () => {
    let s = emptyEpoch();
    s = {
      ...s,
      workspace: { id: "old" } as WorkspaceSnapshot,
      session: { sessionId: "s" } as SessionSnapshot,
    };
    s = beginHostEpoch(s, host("h2"));
    expect(s.host?.hostInstanceId).toBe("h2");
    expect(s.workspace).toBeNull();
    expect(s.session).toBeNull();
  });

  it("workspace id change clears session/tools/packages", () => {
    let s = emptyEpoch();
    s = applyWorkspaceSnapshot(s, {
      id: "a",
      cwd: "/a",
      canonicalCwd: "/a",
      revision: 1,
      trust: { required: false, decision: "notRequired" },
      servicesReady: true,
    });
    s = applySessionSnapshot(s, {
      sessionId: "s1",
      cwd: "/a",
      revision: 1,
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pending: { steering: [], followUp: [] },
      messages: [{ role: "user", content: "hi" }],
      tools: {
        revision: 1,
        workspaceId: "a",
        sessionId: "s1",
        sessionRevision: 1,
        tools: [],
        active: [],
      },
    });
    s = applyWorkspaceSnapshot(s, {
      id: "b",
      cwd: "/b",
      canonicalCwd: "/b",
      revision: 2,
      trust: { required: false, decision: "notRequired" },
      servicesReady: true,
    });
    expect(s.session).toBeNull();
    expect(s.tools).toBeNull();
  });

  it("sequence gap marks desynchronized and advances lastSequence", () => {
    let s = emptyEpoch();
    s = { ...s, lastSequence: 3 };
    const r = noteSequence(s, 6);
    expect(r.action).toBe("gap");
    expect(r.state.desynchronized).toBe(true);
    // Must advance watermark or every later event re-gaps forever
    expect(r.state.lastSequence).toBe(6);
    const next = noteSequence(r.state, 7);
    // still desync until rehydrate, but sequence action is apply (not gap again)
    expect(next.action).toBe("apply");
    expect(next.state.lastSequence).toBe(7);
  });

  it("null session is authoritative empty", () => {
    let s = emptyEpoch();
    s = applySessionSnapshot(s, {
      sessionId: "s",
      cwd: "/",
      revision: 1,
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pending: { steering: [], followUp: [] },
      messages: [],
      tools: {
        revision: 1,
        workspaceId: "w",
        sessionId: "s",
        sessionRevision: 1,
        tools: [],
        active: [],
      },
    });
    s = applySessionSnapshot(s, null);
    expect(s.session).toBeNull();
    expect(s.tools).toBeNull();
  });
});
