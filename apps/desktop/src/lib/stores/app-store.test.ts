/**
 * R7: app-store epoch wiring — host/workspace changes clear stale state.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "./app-store";
import {
  deriveExtensionUiWaitingBySession,
  isExtensionDecisionBlockingSession,
} from "./extension-ui-state";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@pideck/protocol";
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
    sdkVersion: "0.84.2",
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

function session(id: string, revision = 1): SessionSnapshot {
  return {
    sessionId: id,
    cwd: "/p",
    revision,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "hi" }],
    tools: {
      revision: 1,
      workspaceId: "w",
      sessionId: id,
      sessionRevision: revision,
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
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionStatusOrigins: {},
      lastExtensionWidgetAttentionRunId: null,
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      transcriptDrafts: {},
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
      notifications: [],
      desynchronized: false,
      lastSequence: 0,
      hostFatal: null,
      rehydrating: false,
    });
  });

  it("retains redacted decision group steps until Host completion", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const groupKey = "tool:0123456789abcdef";
    const first = {
      requestId: "11111111-1111-4111-8111-111111111111",
      kind: "select" as const,
      groupKey,
      presentation: "inline" as const,
      context,
    };
    const second = {
      requestId: "22222222-2222-4222-8222-222222222222",
      kind: "input" as const,
      groupKey,
      presentation: "inline" as const,
      context: { ...context, expectedSessionRevision: 2 },
    };

    useAppStore.getState().setExtensionUiRequest(first);
    useAppStore.getState().closeExtensionUiRequest(first.requestId, "answered");

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toMatchObject({
      activeRequestId: null,
      answeredCount: 1,
      status: "active",
      steps: [{ requestId: first.requestId, kind: "select", status: "answered" }],
    });
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).not.toHaveProperty("value");

    useAppStore.getState().setExtensionUiRequest(second);
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toMatchObject({
      activeRequestId: second.requestId,
      context: { expectedSessionRevision: 2 },
      answeredCount: 1,
      steps: [
        { requestId: first.requestId, kind: "select", status: "answered" },
        { requestId: second.requestId, kind: "input", status: "active" },
      ],
    });

    useAppStore.getState().closeExtensionDecisionGroup(groupKey, "completed");
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]?.status).toBe("completed");
    useAppStore.getState().closeExtensionUiRequest(second.requestId, "answered");
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toBeUndefined();
  });

  it("bounds retained group steps while preserving the answered count", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const groupKey = "tool:bounded";
    for (let index = 0; index < 105; index += 1) {
      const requestId = `request-${index}`;
      useAppStore.getState().setExtensionUiRequest({
        requestId,
        kind: "input",
        groupKey,
        presentation: "inline",
        context,
      });
      useAppStore.getState().closeExtensionUiRequest(requestId, "answered");
    }

    const group = useAppStore.getState().extensionDecisionGroups[groupKey];
    expect(group?.steps).toHaveLength(100);
    expect(group?.answeredCount).toBe(105);
    expect(group?.steps[0]?.requestId).toBe("request-5");
  });

  it("keeps concurrent decision groups isolated", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    useAppStore.getState().setExtensionUiRequest({
      requestId: "33333333-3333-4333-8333-333333333333",
      kind: "confirm",
      groupKey: "tool:first",
      presentation: "inline",
      context,
    });
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      groupKey: "tool:second",
      presentation: "inline",
      context,
    });

    expect(Object.keys(useAppStore.getState().extensionDecisionGroups)).toEqual([
      "tool:first",
      "tool:second",
    ]);
    useAppStore.getState().closeExtensionDecisionGroup("tool:second", "failed");
    expect(useAppStore.getState().extensionDecisionGroups["tool:first"]?.status).toBe("active");
    expect(useAppStore.getState().extensionDecisionGroups["tool:second"]?.status).toBe("failed");
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

  it("advances Host session identity with authoritative session snapshots", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));

    useAppStore.getState().applySessionSnapshot(session("s1", 1));
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: "s1",
      sessionRevision: 1,
    });

    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: "s2",
      sessionRevision: 2,
    });

    useAppStore.getState().applySessionSnapshot(null);
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: null,
      sessionRevision: 0,
    });
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
      lastSequence: 6, // from the atomic Host recovery snapshot
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
    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    useAppStore.getState().setExtensionWidget({
      ...useAppStore.getState().extensionWidgets.summary!,
      widget: { text: "updated" },
    });
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    useAppStore.getState().requestExtensionWidgetAttention("run-before-switch", "summary");
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBe("run-before-switch");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().extensionWidgets).toEqual({});
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});
    expect(useAppStore.getState().extensionStatusOrigins).toEqual({});
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBeNull();
  });

  it("toggles collapse only for mounted widgets and prunes it on removal", () => {
    const widget = {
      key: "summary",
      widget: ["active"],
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    };

    useAppStore.getState().toggleExtensionWidgetCollapsed("missing");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});

    useAppStore.getState().setExtensionWidget(widget);
    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });

    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});

    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    useAppStore.getState().setExtensionWidget({ ...widget, widget: null });
    expect(useAppStore.getState().extensionWidgets).toEqual({});
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});
  });

  it("records widget attention once per run without opening a popover", () => {
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
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBeNull();

    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBe("run-1");

    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBe("run-1");

    useAppStore.getState().requestExtensionWidgetAttention("run-2", "brainstorm");
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBe("run-2");
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

  it("closes Extension UI requests by ID without disturbing unrelated work", () => {
    const activeContext = {
      expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
      expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "33333333-3333-4333-8333-333333333333",
      expectedSessionRevision: 1,
    };
    const first = {
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm" as const,
      title: "First",
      context: activeContext,
    };
    const second = {
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input" as const,
      title: "Second",
      context: activeContext,
    };
    const background = {
      requestId: "66666666-6666-4666-8666-666666666666",
      kind: "editor" as const,
      title: "Background",
      context: {
        ...activeContext,
        expectedSessionId: "77777777-7777-4777-8777-777777777777",
      },
    };

    useAppStore.getState().setExtensionUiRequest(first);
    useAppStore.getState().setExtensionUiRequest(second);
    useAppStore.getState().enqueueExtensionUiRequest(background);

    useAppStore.getState().closeExtensionUiRequest(second.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(first.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest("88888888-8888-4888-8888-888888888888");
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(first.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().setExtensionUiRequest(second);
    useAppStore.getState().closeExtensionUiRequest(first.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(second.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest(first.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(second.requestId);
    useAppStore.getState().closeExtensionUiRequest(background.requestId);
    expect(useAppStore.getState().extensionUiQueue).toEqual([]);
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

  it("presents a candidate request without losing the outgoing Session request", () => {
    const outgoing = {
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm" as const,
      title: "Outgoing request",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s1",
        expectedSessionRevision: 1,
      },
    };
    const candidate = {
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input" as const,
      title: "Candidate request",
      context: {
        ...outgoing.context,
        expectedSessionId: "s2",
      },
    };

    useAppStore.getState().setExtensionUiRequest(outgoing);
    useAppStore.getState().presentCandidateExtensionUiRequest(candidate);

    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(candidate.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      outgoing.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest(candidate.requestId, "answered");

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      outgoing.requestId,
    ]);
  });

  it("derives expiry-aware waiting decision summaries by Session", () => {
    const now = 10_000;
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const active = {
      requestId: "active",
      kind: "confirm" as const,
      risk: "normal" as const,
      context,
    };
    const background = {
      requestId: "background",
      kind: "input" as const,
      risk: "high" as const,
      context: { ...context, expectedSessionId: "s2" },
    };
    const expired = {
      requestId: "expired",
      kind: "select" as const,
      expiresAt: now,
      context: { ...context, expectedSessionId: "s2" },
    };

    expect(deriveExtensionUiWaitingBySession(active, [active, background, expired], now)).toEqual({
      s1: { count: 1, hasHighRisk: false },
      s2: { count: 1, hasHighRisk: true },
    });
  });

  it("keeps a Session blocked through a decision group's waiting interval", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const group = {
      groupKey: "tool:blocking",
      context,
      presentation: "inline" as const,
      risk: "normal" as const,
      activeRequestId: null,
      answeredCount: 1,
      steps: [],
      status: "active" as const,
    };

    expect(isExtensionDecisionBlockingSession(null, { [group.groupKey]: group }, "s1")).toBe(true);
    expect(isExtensionDecisionBlockingSession(null, { [group.groupKey]: group }, "s2")).toBe(false);
    expect(
      isExtensionDecisionBlockingSession(
        null,
        { [group.groupKey]: { ...group, status: "completed" } },
        "s1",
      ),
    ).toBe(false);
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

  it("keeps the Session Catalog and live drafts across page navigation", () => {
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
    const target = { kind: "session" as const, canonicalCwd: "/p/w1", sessionId: "s1" };
    useAppStore.getState().setDraftTextLocal(target, "unfinished prompt");

    useAppStore.getState().setPage("packages");
    useAppStore.getState().setPage("settings");
    useAppStore.getState().setPage("chat");

    const state = useAppStore.getState();
    expect(state.sessionCatalog.entries.s1?.name).toBe("Catalog session");
    expect(state.draftTexts["session:s1"]).toBe("unfinished prompt");
  });

  it("keeps live draft edits across Host restart and merges hydration only when untouched", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    const target = { kind: "session" as const, canonicalCwd: "/p/w1", sessionId: "s1" };
    useAppStore.getState().setDraftTextLocal(target, "live");

    useAppStore.getState().beginHostEpoch(host("h2"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore
      .getState()
      .mergeHydratedDrafts("/p/w1", [{ ...target, text: "stale disk", updatedAt: 1 }], {
        "session:s1": 0,
      });

    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("live");
  });

  it("hydrates an untouched new-conversation draft by canonical workspace", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().mergeHydratedDrafts(
      "/p/w1",
      [
        {
          kind: "new-conversation",
          canonicalCwd: "/p/w1",
          text: "restored",
          updatedAt: 1,
        },
      ],
      {},
    );

    expect(useAppStore.getState().draftTexts["new:/p/w1"]).toBe("restored");
    expect(useAppStore.getState().draftHydratedWorkspace).toBe("/p/w1");
  });

  it("ignores a workspace hydration result after switching elsewhere", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    useAppStore.getState().mergeHydratedDrafts(
      "/p/w1",
      [
        {
          kind: "new-conversation",
          canonicalCwd: "/p/w1",
          text: "wrong workspace",
          updatedAt: 1,
        },
      ],
      {},
    );

    expect(useAppStore.getState().draftTexts).toEqual({});
  });

  it("projects the active Pi snapshot into the Session Catalog runtime state", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("idle");

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      isIdle: false,
      isStreaming: true,
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");
    expect(useAppStore.getState().sessionCatalog.entries.s2?.runtimeState).toBe("idle");

    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applySessionSnapshot(session("s3"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("inactive");
    expect(useAppStore.getState().sessionCatalog.entries.s3?.runtimeState).toBe("idle");

    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 20);
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");
  });

  it("keeps a new running Session in the catalog after switching away", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 1),
      messages: [],
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1).toBeUndefined();

    useAppStore.getState().applyAgentTranscriptEvent("s1", {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "user", content: "hello" },
      },
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1).toMatchObject({
      sessionId: "s1",
      runtimeState: "running",
    });

    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    expect(useAppStore.getState().session?.sessionId).toBe("s2");
    expect(useAppStore.getState().sessionCatalog.entries.s1).toMatchObject({
      sessionId: "s1",
      runtimeState: "running",
    });

    useAppStore.getState().replaceSessionCatalog("w1", []);
    expect(useAppStore.getState().sessionCatalog.entries.s1).toMatchObject({
      sessionId: "s1",
      runtimeState: "running",
    });
  });

  it("parks a live transcript and restores it on promote without resetting startedAt", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    const runningA = {
      ...session("s1", 1),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello", startedAt: 100 }],
      entries: [
        {
          id: "e-live",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "Hello", startedAt: 100 },
        },
      ],
      leafId: "e-live",
    };
    useAppStore.getState().applySessionSnapshot(runningA);
    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    expect(useAppStore.getState().session?.sessionId).toBe("s2");
    expect(useAppStore.getState().transcriptDrafts.s1?.messages[0]).toMatchObject({
      startedAt: 100,
    });

    useAppStore.getState().applyAgentTranscriptEvent(
      "s1",
      {
        runId: "r1",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
        },
      },
      1,
      5_000,
    );
    expect(useAppStore.getState().transcriptDrafts.s1?.messages[0]).toMatchObject({
      startedAt: 100,
    });
    expect(useAppStore.getState().session?.sessionId).toBe("s2");

    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 3),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello world" }],
      entries: [
        {
          id: "e-file",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "Hello world" },
        },
      ],
      leafId: "e-file",
    });
    expect(useAppStore.getState().session?.revision).toBe(3);
    expect(useAppStore.getState().session?.messages[0]).toMatchObject({
      startedAt: 100,
    });
    expect(useAppStore.getState().session?.entries?.[0]).toMatchObject({ id: "e-live" });
    expect(useAppStore.getState().session?.leafId).toBe("e-live");
    expect(useAppStore.getState().transcriptDrafts.s1).toBeUndefined();

    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 3),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello world" }],
    });
    expect(useAppStore.getState().session?.messages[0]).toMatchObject({
      startedAt: 100,
    });
  });

  it("does not revert a promote when a stale previous snapshot arrives late", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 5),
      isIdle: false,
      isStreaming: true,
    });
    useAppStore.getState().applySessionSnapshot({
      ...session("s2", 6),
      isIdle: false,
      isStreaming: true,
    });
    expect(useAppStore.getState().session?.sessionId).toBe("s2");

    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 5),
      isIdle: false,
      isStreaming: true,
    });
    expect(useAppStore.getState().session?.sessionId).toBe("s2");
    expect(useAppStore.getState().session?.revision).toBe(6);
  });

  it("keeps transcript drafts across workspace switches and clears them on host epoch", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 1),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "live", startedAt: 100 }],
    });
    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    expect(useAppStore.getState().transcriptDrafts.s1).toBeDefined();

    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    expect(useAppStore.getState().transcriptDrafts.s1?.messages[0]).toMatchObject({
      startedAt: 100,
    });

    useAppStore.getState().applySessionSnapshot({
      ...session("s3", 1),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "other", startedAt: 50 }],
    });
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 3));
    expect(useAppStore.getState().transcriptDrafts.s1).toBeDefined();
    expect(useAppStore.getState().transcriptDrafts.s3?.messages[0]).toMatchObject({
      startedAt: 50,
    });

    useAppStore.getState().beginHostEpoch(host("h2"));
    expect(useAppStore.getState().transcriptDrafts).toEqual({});
  });

  it("parks the live foreground Session when switching workspace", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 1),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "live", startedAt: 100 }],
    });
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    expect(useAppStore.getState().session).toBeNull();
    expect(useAppStore.getState().transcriptDrafts.s1?.messages[0]).toMatchObject({
      startedAt: 100,
    });

    useAppStore.getState().applyAgentTranscriptEvent(
      "s1",
      {
        runId: "r1",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " on" },
        },
      },
      1,
      5_000,
    );
    expect(useAppStore.getState().transcriptDrafts.s1?.messages[0]).toMatchObject({
      startedAt: 100,
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1).toBeUndefined();
  });

  it("does not list a parked Session from another Workspace", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 1),
      cwd: "/p/w1",
      isIdle: false,
      isStreaming: true,
      tools: { ...session("s1", 1).tools, workspaceId: "w1" },
      messages: [{ role: "assistant", content: "live", startedAt: 100 }],
    });
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    useAppStore.getState().applyAgentTranscriptEvent(
      "s1",
      {
        runId: "r1",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " on" },
        },
      },
      1,
      5_000,
    );

    expect(useAppStore.getState().sessionCatalog.entries.s1).toBeUndefined();
    expect(useAppStore.getState().transcriptDrafts.s1).toBeDefined();
  });

  it("drops a settled draft when opening the Session from disk", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 1),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "live", startedAt: 100 }],
    });
    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    useAppStore.getState().applyAgentTranscriptEvent("s1", {
      runId: "r1",
      event: { type: "agent_settled" },
    });
    expect(useAppStore.getState().transcriptDrafts.s1).toBeUndefined();

    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 4),
      messages: [{ role: "assistant", content: "from file" }],
    });
    expect(useAppStore.getState().session?.messages).toEqual([
      { role: "assistant", content: "from file" },
    ]);
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

describe("provider login flow state", () => {
  beforeEach(() => {
    useAppStore.setState({ providerLogin: null });
  });

  it("keeps a prompt adopted from an event that outran the loginStart response", () => {
    // API-key flows prompt synchronously on the host, so the loginEvent can
    // arrive before the loginStart RPC resolves and beginProviderLogin runs.
    useAppStore.getState().applyProviderLoginEvent({
      loginId: "login-1",
      providerId: "groq",
      event: {
        kind: "prompt",
        prompt: { promptId: "p1", kind: "secret", message: "Enter GROQ_API_KEY" },
      },
    });
    useAppStore.getState().beginProviderLogin("login-1", "groq");
    expect(useAppStore.getState().providerLogin?.prompt?.promptId).toBe("p1");
  });

  it("replaces state from a different login flow", () => {
    useAppStore.getState().beginProviderLogin("login-1", "groq");
    useAppStore.getState().applyProviderLoginEvent({
      loginId: "login-1",
      providerId: "groq",
      event: {
        kind: "prompt",
        prompt: { promptId: "p1", kind: "secret", message: "Enter GROQ_API_KEY" },
      },
    });
    useAppStore.getState().beginProviderLogin("login-2", "anthropic");
    const state = useAppStore.getState().providerLogin;
    expect(state?.loginId).toBe("login-2");
    expect(state?.prompt).toBeNull();
  });
});

describe("Extension message renderer state", () => {
  beforeEach(() => {
    useAppStore.setState({ session: session("s-render") });
  });

  it("merges and removes renderer snapshots without replacing the Session", () => {
    const render = { version: 1 as const, collapsed: ["working"], expanded: ["done"] };
    useAppStore.getState().setExtensionMessageRender("entry-1", render);
    expect(useAppStore.getState().session?.extensionMessageRenders).toEqual({
      "entry-1": render,
    });

    useAppStore.getState().setExtensionMessageRender("entry-1", null);
    expect(useAppStore.getState().session?.extensionMessageRenders).toBeUndefined();
  });
});
