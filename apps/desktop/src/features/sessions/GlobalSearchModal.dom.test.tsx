/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSearchReport,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { GlobalSearchModal } from "./GlobalSearchModal";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const FOUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION_ID = "66666666-6666-4666-8666-666666666666";

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
    cwd: "/proj/current",
    canonicalCwd: "/proj/current",
    revision: 1,
    servicesReady: true,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/proj/current",
    revision: 3,
    name: "Active session",
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

function searchReport(): SessionSearchReport {
  return {
    generatedAt: 1,
    query: "login",
    scannedCount: 4,
    truncated: false,
    items: [
      {
        sessionId: FOUND_SESSION_ID,
        sessionPath: "/sessions/current/found.jsonl",
        name: "Fix login flow",
        cwd: "/proj/current",
        archived: false,
        updatedAt: 1_700_000_000_000,
        matchCount: 2,
        matches: [
          { role: "user", snippet: "how do I fix the login timeout?" },
          { role: "assistant", snippet: "the login handler retries" },
        ],
        nameMatched: true,
      },
      {
        sessionId: OTHER_SESSION_ID,
        sessionPath: "/sessions/other/found.jsonl",
        cwd: "/proj/other",
        archived: true,
        updatedAt: 1_600_000_000_000,
        matchCount: 1,
        matches: [{ role: "user", snippet: "login broken on other project" }],
        nameMatched: false,
      },
    ],
  };
}

function envelope<T>(method: string, result: T): HostResponseEnvelope {
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

describe("GlobalSearchModal", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.getState().setConnecting(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows the hint without querying until text is entered", () => {
    const request = vi.spyOn(hostClient, "request");
    render(<GlobalSearchModal onClose={() => {}} />);
    expect(screen.getByRole("searchbox", { name: "Search all sessions" })).toHaveClass(
      "global-search-input",
      "!bg-transparent",
      "!shadow-none",
    );
    expect(
      screen.getByText("Type to search message content across all workspaces"),
    ).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("searches after a debounce and renders grouped, highlighted results", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(envelope("session.searchAll", searchReport()) as never);
    render(<GlobalSearchModal onClose={() => {}} />);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations in every project…"), "login");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "session.searchAll",
        { expectedHostInstanceId: HOST_ID },
        { query: "login", limit: 50 },
        20_000,
      ),
    );

    expect(await screen.findByTitle("Fix login flow")).toBeInTheDocument();
    expect(screen.getByText("/proj/current")).toBeInTheDocument();
    expect(screen.getByText("/proj/other")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    const highlights = screen
      .getAllByText("login", { exact: false })
      .filter((element) => element.tagName === "MARK");
    expect(highlights.length).toBeGreaterThan(0);
  });

  it("opens a result in the current workspace without switching", async () => {
    const onClose = vi.fn();
    const request = vi.spyOn(hostClient, "request").mockImplementation(((method: string) => {
      if (method === "session.searchAll") {
        return Promise.resolve(envelope(method, searchReport()));
      }
      if (method === "session.open") {
        return Promise.resolve(
          envelope(method, session({ sessionId: FOUND_SESSION_ID, revision: 1 })),
        );
      }
      throw new Error(`Unexpected method: ${method}`);
    }) as never);
    render(<GlobalSearchModal onClose={onClose} />);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations in every project…"), "login");
    await user.click(await screen.findByTitle("Fix login flow"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const methods = request.mock.calls.map((call) => call[0]);
    expect(methods).toContain("session.open");
    expect(methods).not.toContain("workspace.setCurrent");
  });

  it("switches workspace before handling a result from another project", async () => {
    const onClose = vi.fn();
    const request = vi.spyOn(hostClient, "request").mockImplementation(((method: string) => {
      if (method === "session.searchAll") {
        return Promise.resolve(envelope(method, searchReport()));
      }
      if (method === "workspace.setCurrent") {
        return Promise.resolve(
          envelope(method, {
            workspace: {
              id: OTHER_WORKSPACE_ID,
              cwd: "/proj/other",
              canonicalCwd: "/proj/other",
              revision: 1,
              servicesReady: true,
            },
          }),
        );
      }
      throw new Error(`Unexpected method: ${method}`);
    }) as never);
    render(<GlobalSearchModal onClose={onClose} />);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations in every project…"), "login");
    // The archived result has no name, so it renders the untitled fallback.
    await user.click(await screen.findByTitle("New session"));

    await waitFor(() => {
      const methods = request.mock.calls.map((call) => call[0]);
      expect(methods).toContain("workspace.setCurrent");
    });
    const setCurrentCall = request.mock.calls.find((call) => call[0] === "workspace.setCurrent");
    expect(setCurrentCall?.[2]).toEqual({ cwd: "/proj/other" });
    // The archived result switches the workspace but does not open the session.
    const methods = request.mock.calls.map((call) => call[0]);
    expect(methods).not.toContain("session.open");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
