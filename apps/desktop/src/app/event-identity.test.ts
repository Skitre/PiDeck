import { describe, expect, it } from "vitest";
import type { HostEventEnvelope } from "@pi-desktop/protocol";
import { HostClient } from "../lib/bridge/host-client";
import { expectedIdentityForEvent, isBackgroundExtensionUiRequest } from "./event-identity";

const state = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 4,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 7,
};

function event(
  name: HostEventEnvelope["event"],
  overrides: Partial<HostEventEnvelope> = {},
): HostEventEnvelope {
  return {
    protocolVersion: 1,
    event: name,
    hostInstanceId: state.hostInstanceId,
    workspaceId: state.workspaceId,
    workspaceRevision: state.workspaceRevision,
    sessionId: state.sessionId,
    sessionRevision: state.sessionRevision,
    packageRevision: 2,
    sequence: 10,
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  } as HostEventEnvelope;
}

describe("expectedIdentityForEvent", () => {
  const client = new HostClient();

  it("allows authoritative workspace snapshots to advance the workspace generation", () => {
    const incoming = event("workspace.changed", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: 5,
      sessionId: null,
      sessionRevision: 8,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(true);
  });

  it("allows session and package snapshots to advance the session generation", () => {
    for (const name of ["session.snapshot", "package.snapshot", "package.resourcesChanged"] as const) {
      const incoming = event(name, { sessionRevision: state.sessionRevision + 1 });
      expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(true);
    }
  });

  it("allows a candidate Extension UI request to carry its response identity before snapshots", () => {
    const incoming = event("extensionUi.request", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: state.workspaceRevision + 1,
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: state.sessionRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(true);
  });

  it("still rejects non-authoritative events from a different session generation", () => {
    const incoming = event("agent.toolsChanged", {
      sessionRevision: state.sessionRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(false);
  });

  it("accepts a runtime update from a background Session in the current Workspace", () => {
    const incoming = event("session.runtimeChanged", {
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: 3,
      payload: {
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionRevision: 3,
        state: "running",
        updatedAt: 1,
      },
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("accepts background Session events that are routed or safely ignored", () => {
    for (const name of [
      "session.infoChanged",
      "agent.event",
      "package.diagnostic",
      "extensionUi.statusChanged",
      "extensionUi.widgetChanged",
      "extensionUi.notification",
    ] as const) {
      const incoming = event(name, {
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionRevision: 3,
      });
      expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
        true,
      );
    }
  });

  it("still rejects snapshots from a different workspace generation", () => {
    const incoming = event("package.snapshot", {
      workspaceRevision: state.workspaceRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(false);
  });
});

describe("isBackgroundExtensionUiRequest", () => {
  it("queues a known running background Session request", () => {
    expect(
      isBackgroundExtensionUiRequest({
        eventSessionId: "55555555-5555-4555-8555-555555555555",
        activeSessionId: state.sessionId,
        catalogRuntimeState: "running",
      }),
    ).toBe(true);
  });

  it("allows a candidate Session request before its snapshot commits", () => {
    expect(
      isBackgroundExtensionUiRequest({
        eventSessionId: "55555555-5555-4555-8555-555555555555",
        activeSessionId: state.sessionId,
        catalogRuntimeState: "inactive",
      }),
    ).toBe(false);
  });
});
