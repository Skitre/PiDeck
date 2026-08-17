import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import { emptySessionCatalog, type SessionCatalogState } from "../../lib/stores/session-catalog";
import {
  addKnownWorkspace,
  replaceKnownWorkspace,
  removeKnownWorkspace,
  workspaceDisplayName,
  workspaceLiveRuntimeState,
} from "./WorkspacePicker";

function session(cwd: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s1",
    cwd,
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
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "w",
      sessionId: "s1",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

function catalog(entries: SessionCatalogState["entries"]): SessionCatalogState {
  return {
    ...emptySessionCatalog(),
    workspaceId: "current",
    entries,
    order: Object.keys(entries),
    loaded: true,
  };
}

describe("known workspace list", () => {
  it("appends new paths and keeps insertion order", () => {
    const list = addKnownWorkspace(["C:\\repos\\alpha"], "C:\\repos\\beta");
    expect(list).toEqual(["C:\\repos\\alpha", "C:\\repos\\beta"]);
  });

  it("preserves differently-cased canonical paths", () => {
    const list = addKnownWorkspace(["/repos/Alpha"], "/repos/alpha");
    expect(list).toEqual(["/repos/Alpha", "/repos/alpha"]);
  });

  it("removes only the exact canonical path", () => {
    const list = removeKnownWorkspace(["/repos/Alpha", "/repos/alpha"], "/repos/Alpha");
    expect(list).toEqual(["/repos/alpha"]);
  });

  it("replaces a requested path with the Host canonical path", () => {
    expect(
      replaceKnownWorkspace(
        ["C:\\repos\\alpha", "C:\\repos\\beta"],
        "C:\\repos\\alpha",
        "C:\\Repos\\Alpha",
      ),
    ).toEqual(["C:\\Repos\\Alpha", "C:\\repos\\beta"]);
  });
});

describe("workspaceDisplayName", () => {
  it("uses the last path segment for both separators", () => {
    expect(workspaceDisplayName("C:\\repos\\alpha")).toBe("alpha");
    expect(workspaceDisplayName("/home/user/beta/")).toBe("beta");
  });
});

describe("workspaceLiveRuntimeState", () => {
  const current = { cwd: "C:\\repos\\alpha", canonicalCwd: "C:\\repos\\alpha" };

  it("uses a parked draft so a left Workspace still shows running", () => {
    expect(
      workspaceLiveRuntimeState({
        path: "C:\\repos\\alpha",
        workspace: { cwd: "C:\\repos\\beta", canonicalCwd: "C:\\repos\\beta" },
        session: session("C:\\repos\\beta"),
        catalog: emptySessionCatalog(),
        drafts: {
          s1: session("C:\\repos\\alpha", { isIdle: false, isStreaming: true }),
        },
      }),
    ).toBe("running");
  });

  it("ignores drafts that belong to another Workspace", () => {
    expect(
      workspaceLiveRuntimeState({
        path: "C:\\repos\\beta",
        workspace: { cwd: "C:\\repos\\beta", canonicalCwd: "C:\\repos\\beta" },
        session: session("C:\\repos\\beta"),
        catalog: emptySessionCatalog(),
        drafts: {
          s1: session("C:\\repos\\alpha", { isIdle: false, isStreaming: true }),
        },
      }),
    ).toBeNull();
  });

  it("reads the current Workspace from the foreground Session and catalog", () => {
    expect(
      workspaceLiveRuntimeState({
        path: current.canonicalCwd,
        workspace: current,
        session: session(current.cwd, { isIdle: false, isStreaming: true }),
        catalog: emptySessionCatalog(),
        drafts: {},
      }),
    ).toBe("running");
    expect(
      workspaceLiveRuntimeState({
        path: current.canonicalCwd,
        workspace: current,
        session: session(current.cwd),
        catalog: catalog({
          s2: {
            sessionId: "s2",
            sessionPath: "s2.jsonl",
            cwd: current.cwd,
            updatedAt: 1,
            messageCount: 1,
            runtimeState: "queued",
          },
        }),
        drafts: {},
      }),
    ).toBe("queued");
  });

  it("prefers running over queued or error", () => {
    expect(
      workspaceLiveRuntimeState({
        path: current.canonicalCwd,
        workspace: current,
        session: session(current.cwd, {
          isIdle: true,
          pending: { revision: 1, steering: ["go"], followUp: [] },
        }),
        catalog: catalog({
          s2: {
            sessionId: "s2",
            sessionPath: "s2.jsonl",
            cwd: current.cwd,
            updatedAt: 1,
            messageCount: 1,
            runtimeState: "error",
          },
        }),
        drafts: {
          s3: session(current.cwd, { sessionId: "s3", isIdle: false, isStreaming: true }),
        },
      }),
    ).toBe("running");
  });

  it("hides the indicator after a parked Session settles", () => {
    expect(
      workspaceLiveRuntimeState({
        path: "C:\\repos\\alpha",
        workspace: { cwd: "C:\\repos\\beta", canonicalCwd: "C:\\repos\\beta" },
        session: session("C:\\repos\\beta"),
        catalog: emptySessionCatalog(),
        drafts: {
          s1: session("C:\\repos\\alpha", { isIdle: true, isStreaming: false }),
        },
      }),
    ).toBeNull();
  });
});
