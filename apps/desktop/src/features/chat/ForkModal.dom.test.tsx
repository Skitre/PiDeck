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
import { SESSION_OPEN_TIMEOUT_MS } from "../../lib/bridge/session-open-request";
import { __resetDraftPersistenceForTests } from "../../lib/draft-persistence";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import { useAppStore } from "../../lib/stores/app-store";
import { ForkModal } from "./ForkModal";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const FORKED_SESSION_ID = "44444444-4444-4444-8444-444444444444";

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

function session(sessionId: string = SESSION_ID): SessionSnapshot {
  return {
    sessionId,
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

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

function envelope(
  method: string,
  result: unknown,
  overrides: Partial<HostResponseEnvelope> = {},
): HostResponseEnvelope {
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
    ...overrides,
  } as HostResponseEnvelope;
}

describe("ForkModal", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
    });
  });

  afterEach(() => {
    __resetDraftPersistenceForTests();
    vi.restoreAllMocks();
    cleanup();
  });

  it("lists fork points and forks into the new session", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "session.getForkPoints") {
        return envelope("session.getForkPoints", {
          items: [
            { entryId: "u1", text: "first ask" },
            { entryId: "u2", text: "second ask" },
          ],
        }) as never;
      }
      return envelope(
        "session.fork",
        { session: session(FORKED_SESSION_ID), selectedText: "second ask" },
        { sessionId: FORKED_SESSION_ID, sessionRevision: 4 },
      ) as never;
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ForkModal open onClose={onClose} />);

    await user.click(await screen.findByRole("button", { name: /second ask/ }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "session.fork",
        EXPECTED_CONTEXT,
        { entryId: "u2" },
        SESSION_OPEN_TIMEOUT_MS,
      ),
    );
    await waitFor(() => expect(useAppStore.getState().session?.sessionId).toBe(FORKED_SESSION_ID));
    const target = draftTargetFor(workspace(), session(FORKED_SESSION_ID));
    expect(target).not.toBeNull();
    expect(useAppStore.getState().draftTexts[draftKeyForTarget(target!)]).toBe("second ask");
    expect(useAppStore.getState().host?.sessionId).toBe(FORKED_SESSION_ID);
    expect(onClose).toHaveBeenCalled();
  });

  it("disables forking while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot({
      ...session(),
      isIdle: false,
      isStreaming: true,
    });
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getForkPoints", {
        items: [{ entryId: "u1", text: "first ask" }],
      }) as never,
    );
    render(<ForkModal open onClose={() => {}} />);

    expect(await screen.findByRole("button", { name: /first ask/ })).toBeDisabled();
    expect(
      screen.getByText("Agent is busy — forking is available when the session is idle."),
    ).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("session.getForkPoints", undefined),
      ok: false,
      result: undefined,
      error: { code: "HOST_NOT_READY", message: "Server not bound" },
    } as never);
    render(<ForkModal open onClose={() => {}} />);

    expect(await screen.findByText("Server not bound")).toBeInTheDocument();
  });
});
