/**
 * R7: app-store epoch wiring — host/workspace changes clear stale state.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "./app-store";
import type {
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { emptySessionCatalog } from "./session-catalog";

function host(id: string): HostStatusSnapshot {
  return {
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
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(id: string, rev: number): WorkspaceSnapshot {
  return {
    id,
    cwd: `/p/${id}`,
    canonicalCwd: `/p/${id}`,
    revision: rev,
    servicesReady: true,
  };
}

function session(id: string): SessionSnapshot {
  return {
    sessionId: id,
    cwd: "/p",
    revision: 1,
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
    messages: [{ role: "user", content: "hi" }],
    tools: {
      revision: 1,
      workspaceId: "w",
      sessionId: id,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("app-store epoch wiring", () => {
  beforeEach(() => {
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      packages: null,
      tools: null,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      sessionDrafts: {},
      notifications: [],
      desynchronized: false,
      lastSequence: 0,
      hostFatal: null,
      rehydrating: false,
    });
  });

  it("beginHostEpoch clears prior workspace/session/packages/tools", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applyPackageSnapshot({
      revision: 1,
      workspaceId: "w1",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });

    useAppStore.getState().beginHostEpoch(host("h2"));
    const s = useAppStore.getState();
    expect(s.host?.hostInstanceId).toBe("h2");
    expect(s.workspace).toBeNull();
    expect(s.session).toBeNull();
    expect(s.packages).toBeNull();
    expect(s.tools).toBeNull();
  });

  it("setHost with new hostInstanceId begins epoch", () => {
    useAppStore.getState().setHost(host("h1"));
    useAppStore.getState().setWorkspace(workspace("w1", 1));
    useAppStore.getState().setSession(session("s1"));
    useAppStore.getState().setHost(host("h2"));
    const s = useAppStore.getState();
    expect(s.session).toBeNull();
    expect(s.workspace).toBeNull();
  });

  it("workspace A→B clears session/tools/packages", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("A", 1));
    useAppStore.getState().applySessionSnapshot(session("sA"));
    useAppStore.getState().applyPackageSnapshot({
      revision: 1,
      workspaceId: "A",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });
    useAppStore.getState().applyWorkspaceSnapshot(workspace("B", 2));
    const s = useAppStore.getState();
    expect(s.workspace?.id).toBe("B");
    expect(s.session).toBeNull();
    expect(s.packages).toBeNull();
    expect(s.tools).toBeNull();
  });

  it("sequence gap marks desynchronized", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    expect(useAppStore.getState().noteSequence(1)).toBe("apply");
    expect(useAppStore.getState().noteSequence(2)).toBe("apply");
    expect(useAppStore.getState().noteSequence(5)).toBe("gap");
    expect(useAppStore.getState().desynchronized).toBe(true);
    expect(useAppStore.getState().lastSequence).toBe(5);
  });

  it("gap then rehydrate then next sequence applies (not infinite re-gap)", () => {
    // Spec: last=3, note(6)=gap, rehydrate, note(7)=apply
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.setState({ lastSequence: 3, desynchronized: false });
    expect(useAppStore.getState().noteSequence(6)).toBe("gap");
    expect(useAppStore.getState().desynchronized).toBe(true);
    expect(useAppStore.getState().lastSequence).toBe(6);

    useAppStore.getState().completeRehydrate({
      host: host("h1"),
      lastSequence: 6, // from hostClient.getLastSequence() after rehydrate
    });
    expect(useAppStore.getState().desynchronized).toBe(false);
    expect(useAppStore.getState().lastSequence).toBe(6);
    expect(useAppStore.getState().noteSequence(7)).toBe("apply");
    expect(useAppStore.getState().lastSequence).toBe(7);
    expect(useAppStore.getState().desynchronized).toBe(false);
  });

  it("duplicate sequence drops", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    expect(useAppStore.getState().noteSequence(1)).toBe("apply");
    expect(useAppStore.getState().noteSequence(1)).toBe("drop");
  });

  it("stores keyed Extension widgets and clears them on session generation change", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setExtensionWidget({
      key: "summary",
      widget: { text: "ready" },
      placement: "belowEditor",
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    });
    expect(useAppStore.getState().extensionWidgets.summary?.widget).toEqual({ text: "ready" });
    expect(useAppStore.getState().extensionWidgets.summary?.placement).toBe("belowEditor");
    useAppStore.getState().requestExtensionWidgetAttention("run-before-switch", "summary");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().extensionWidgets).toEqual({});
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBeNull();
  });

  it("opens once per widget attention run and closes on navigation or final clear", () => {
    const widget = {
      key: "brainstorm",
      widget: ["active"],
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    };

    useAppStore.getState().setExtensionWidget(widget);
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);

    useAppStore.getState().setExtensionWidgetsOpen(false);
    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-2", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);

    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
    useAppStore.getState().requestExtensionWidgetAttention("run-3", "brainstorm");
    useAppStore.getState().setPage("chat");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-missing", "missing");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().setExtensionWidgetsOpen(true);
    useAppStore.getState().setExtensionWidget({ ...widget, widget: null });
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
  });

  it("keeps extension statuses by key and clears them independently", () => {
    useAppStore.getState().setExtensionStatus("planner", "Planning");
    useAppStore.getState().setExtensionStatus("review", "Reviewing");
    expect(useAppStore.getState().extensionStatuses).toEqual({
      planner: "Planning",
      review: "Reviewing",
    });
    expect(useAppStore.getState().extensionStatus).toBe("Reviewing");

    useAppStore.getState().setExtensionStatus("review", "");
    expect(useAppStore.getState().extensionStatuses).toEqual({ planner: "Planning" });
    expect(useAppStore.getState().extensionStatus).toBe("Planning");
  });

  it("queues concurrent Extension UI requests with their response contexts", () => {
    const context = {
      expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
      expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "33333333-3333-4333-8333-333333333333",
      expectedSessionRevision: 1,
    };
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      title: "First",
      context,
    });
    useAppStore.getState().setExtensionUiRequest({
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input",
      title: "Second",
      context: { ...context, expectedSessionRevision: 2 },
    });

    expect(useAppStore.getState().extensionUiRequest?.title).toBe("First");
    expect(useAppStore.getState().extensionUiQueue).toHaveLength(1);
    useAppStore.getState().setExtensionUiRequest(null);
    expect(useAppStore.getState().extensionUiRequest?.title).toBe("Second");
    expect(useAppStore.getState().extensionUiRequest?.context.expectedSessionRevision).toBe(2);
  });

  it("keeps background Extension UI queued until its Session becomes active", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().enqueueExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      title: "Background request",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s2",
        expectedSessionRevision: 1,
      },
    });

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionUiQueue).toHaveLength(1);

    useAppStore.getState().applySessionSnapshot(session("s2"));

    expect(useAppStore.getState().extensionUiRequest?.title).toBe("Background request");
    expect(useAppStore.getState().extensionUiQueue).toEqual([]);
  });

  it("stores Package progress globally and clears it on a new Host epoch", () => {
    useAppStore.getState().setPackageProgress({
      operationId: "11111111-1111-4111-8111-111111111111",
      type: "progress",
      action: "install",
      source: "npm:test",
      message: "working",
      lastEventAt: 123,
    });
    expect(useAppStore.getState().packageProgress?.message).toBe("working");

    useAppStore.getState().beginHostEpoch(host("h2"));
    expect(useAppStore.getState().packageProgress).toBeNull();
  });

  it("applies Package and Session mutation results through generation cleanup", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setThinkingLevels(["off", "high"]);
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s1",
        expectedSessionRevision: 1,
      },
    });

    useAppStore.getState().applyPackageMutationResult({
      operationId: "55555555-5555-4555-8555-555555555555",
      status: "committed",
      packageSnapshot: {
        revision: 2,
        workspaceId: "w",
        scope: "all",
        configured: [],
        resources: [],
        updateCheck: { supported: false },
        diagnostics: [],
      },
      session: { ...session("s2"), revision: 2 },
      warnings: [],
      reconcileRequired: false,
    });

    const state = useAppStore.getState();
    expect(state.packages?.revision).toBe(2);
    expect(state.session?.sessionId).toBe("s2");
    expect(state.extensionUiRequest).toBeNull();
    expect(state.extensionUiQueue).toEqual([]);
    expect(state.thinkingLevels).toEqual([]);
  });

  it("owns thinking levels for the active session generation", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setThinkingLevels(["off", "high"]);
    expect(useAppStore.getState().thinkingLevels).toEqual(["off", "high"]);

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().thinkingLevels).toEqual([]);
  });

  it("invalidates the chat model catalog after Provider changes", () => {
    expect(useAppStore.getState().providerConfigRevision).toBe(0);
    useAppStore.getState().refreshProviderConfig();
    useAppStore.getState().refreshProviderConfig();
    expect(useAppStore.getState().providerConfigRevision).toBe(2);
  });

  it("keeps Package retry state across navigation until reconciliation clears", () => {
    useAppStore.getState().setPackageRetry({
      method: "package.install",
      params: { source: "npm:test", scope: "user" },
    });
    useAppStore.getState().setPage("chat");
    useAppStore.getState().setPage("packages");
    expect(useAppStore.getState().packageRetry?.method).toBe("package.install");

    useAppStore.getState().applyPackageSnapshot({
      revision: 2,
      workspaceId: "w1",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });
    expect(useAppStore.getState().packageRetry).toBeNull();
  });

  it("keeps the Session Catalog and per-Session drafts across page navigation", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().replaceSessionCatalog("w1", [
      {
        sessionId: "s1",
        sessionPath: "/sessions/s1.jsonl",
        name: "Catalog session",
        cwd: "/p/w1",
        updatedAt: 1,
        messageCount: 2,
      },
    ]);
    useAppStore.getState().setSessionDraft("s1", "unfinished prompt");

    useAppStore.getState().setPage("packages");
    useAppStore.getState().setPage("settings");
    useAppStore.getState().setPage("chat");

    const state = useAppStore.getState();
    expect(state.sessionCatalog.entries.s1?.name).toBe("Catalog session");
    expect(state.sessionDrafts.s1).toBe("unfinished prompt");
  });

  it("projects the active Pi snapshot into the Session Catalog runtime state", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(
      session("s1"),
    );
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("idle");

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      isIdle: false,
      isStreaming: true,
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe(
      "running",
    );

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe(
      "inactive",
    );
    expect(useAppStore.getState().sessionCatalog.entries.s2?.runtimeState).toBe("idle");

    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 20);
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe(
      "running",
    );
  });

  it("clears the Session Catalog only when the workspace epoch changes", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().replaceSessionCatalog("w1", [
      {
        sessionId: "s1",
        sessionPath: "/sessions/s1.jsonl",
        cwd: "/p/w1",
        updatedAt: 1,
      },
    ]);

    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    expect(useAppStore.getState().sessionCatalog).toEqual(emptySessionCatalog());
  });

  it("retains a bounded notification history with dismiss and clear actions", () => {
    for (let index = 0; index < 51; index += 1) {
      useAppStore.getState().pushNotification(`message-${index}`, index === 50 ? "error" : "info");
    }
    const retained = useAppStore.getState().notifications;
    expect(retained).toHaveLength(50);
    expect(retained[0]?.message).toBe("message-1");
    expect(retained.at(-1)).toMatchObject({ message: "message-50", level: "error" });
    expect(typeof retained.at(-1)?.createdAt).toBe("number");

    useAppStore.getState().dismissNotification(retained.at(-1)!.id);
    expect(useAppStore.getState().notifications).toHaveLength(49);
    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toEqual([]);
  });
});
