import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  canArchiveSession,
  canDeleteSession,
  canReloadSession,
  canRenameSession,
  filterSessionItems,
  requestSessionRpcWithRetry,
  removedArchivedSessionIds,
  sessionDisplayName,
  sessionRuntimeLabel,
  sessionStatusDotClass,
  shouldRetrySessionRpc,
  shouldClearLastSessionPath,
} from "./session-list-policy";

const active = {
  sessionId: "active-session",
  sessionPath: "C:/sessions/active.jsonl",
  cwd: "C:/workspace",
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
  pending: { revision: 0, steering: [], followUp: [] },
  messages: [{ role: "user", content: "hello" }],
  tools: {
    revision: 1,
    workspaceId: "workspace",
    sessionId: "active-session",
    sessionRevision: 1,
    tools: [],
    active: [],
  },
} satisfies SessionSnapshot;

describe("sessionDisplayName", () => {
  it("uses the persisted name and falls back to the caller-provided label", () => {
    expect(sessionDisplayName({ name: "修复会话恢复" }, "新会话")).toBe("修复会话恢复");
    expect(sessionDisplayName({ name: undefined }, "新会话")).toBe("新会话");
    expect(sessionDisplayName({ name: "  " }, "New session")).toBe("New session");
  });
});

describe("sessionRuntimeLabel", () => {
  it("exposes the normalized runtime state", () => {
    expect(sessionRuntimeLabel("running")).toBe("running");
    expect(sessionRuntimeLabel("inactive")).toBe("inactive");
  });
});

describe("sessionStatusDotClass", () => {
  it("shows persistent activity states without flashing for session startup", () => {
    expect(sessionStatusDotClass("running")).toContain("bg-success");
    expect(sessionStatusDotClass("queued")).toBe("bg-warning");
    expect(sessionStatusDotClass("error")).toBe("bg-danger");
    expect(sessionStatusDotClass("starting")).toBeNull();
    expect(sessionStatusDotClass("inactive")).toBeNull();
  });
});

describe("canReloadSession", () => {
  const item = {
    sessionId: "active-session",
    sessionPath: "C:/sessions/active.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "idle" as const,
  };

  it("allows only the persisted active idle Session", () => {
    expect(canReloadSession(item, active)).toBe(true);
    expect(canReloadSession(item, { ...active, isIdle: false })).toBe(false);
    expect(canReloadSession({ ...item, archived: true }, active)).toBe(false);
    expect(canReloadSession({ ...item, sessionId: "other" }, active)).toBe(false);
    expect(canReloadSession(item, { ...active, sessionPath: undefined })).toBe(false);
  });
});

describe("last Session path cleanup", () => {
  it("matches only the exact Host canonical path", () => {
    expect(shouldClearLastSessionPath("/sessions/Alpha.jsonl", "/sessions/Alpha.jsonl")).toBe(true);
    expect(shouldClearLastSessionPath("/sessions/Alpha.jsonl", "/sessions/alpha.jsonl")).toBe(
      false,
    );
  });
});

describe("removedArchivedSessionIds", () => {
  it("returns only archived Sessions that actually disappeared", () => {
    expect(
      removedArchivedSessionIds(
        [
          { sessionId: "active", archived: false },
          { sessionId: "deleted", archived: true },
          { sessionId: "failed", archived: true },
        ],
        [
          { sessionId: "active", archived: false },
          { sessionId: "failed", archived: true },
        ],
      ),
    ).toEqual(["deleted"]);
  });
});

describe("canRenameSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows inactive files and idle active Sessions", () => {
    expect(canRenameSession(item, active)).toBe(true);
    expect(
      canRenameSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("blocks active or retained Sessions while their Runtime is busy", () => {
    expect(
      canRenameSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
    expect(canRenameSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canRenameSession({ ...item, runtimeState: "idle" }, active)).toBe(false);
  });
});

describe("canDeleteSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows inactive, archived, and idle Sessions", () => {
    expect(canDeleteSession(item, active)).toBe(true);
    expect(canDeleteSession({ ...item, archived: true }, active)).toBe(true);
    expect(canDeleteSession({ ...item, runtimeState: "idle" }, active)).toBe(true);
    expect(canDeleteSession({ ...item, runtimeState: "error" }, active)).toBe(true);
  });

  it("allows the currently viewed Session while it is idle", () => {
    expect(
      canDeleteSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("blocks Sessions whose Runtime is busy", () => {
    expect(canDeleteSession({ ...item, runtimeState: "starting" }, active)).toBe(false);
    expect(canDeleteSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canDeleteSession({ ...item, runtimeState: "queued" }, active)).toBe(false);
    expect(
      canDeleteSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
  });
});

describe("canArchiveSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows idle Sessions including the currently viewed one", () => {
    expect(canArchiveSession(item, active)).toBe(true);
    expect(canArchiveSession({ ...item, runtimeState: "idle" }, active)).toBe(true);
    expect(
      canArchiveSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("blocks archived files and busy Runtimes", () => {
    expect(canArchiveSession({ ...item, archived: true }, active)).toBe(false);
    expect(canArchiveSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canArchiveSession({ ...item, runtimeState: "queued" }, active)).toBe(false);
    expect(
      canArchiveSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
  });
});

describe("filterSessionItems", () => {
  const items = [
    {
      sessionId: "repair-session",
      sessionPath: "C:/sessions/repair.jsonl",
      name: "Repair reconnect",
      cwd: "C:/workspace/alpha",
      updatedAt: 2,
      runtimeState: "running" as const,
    },
    {
      sessionId: "tests-session",
      sessionPath: "C:/sessions/tests.jsonl",
      cwd: "C:/workspace/beta",
      updatedAt: 1,
      runtimeState: "inactive" as const,
    },
    {
      sessionId: "archived-session",
      sessionPath: "C:/sessions/.archive/archived.jsonl",
      name: "Old investigation",
      cwd: "C:/workspace/alpha",
      updatedAt: 0,
      archived: true,
      runtimeState: "inactive" as const,
    },
  ];

  it("keeps archived Sessions out of the active view", () => {
    expect(filterSessionItems(items, "active")).toEqual(items.slice(0, 2));
    expect(filterSessionItems(items, "archived")).toEqual([items[2]]);
  });
});

describe("shouldRetrySessionRpc", () => {
  it("retries only transient graph-lock contention", () => {
    expect(shouldRetrySessionRpc({ code: "SERVICE_GRAPH_BUSY", retryable: true })).toBe(true);
    expect(shouldRetrySessionRpc({ code: "SERVICE_GRAPH_BUSY", retryable: false })).toBe(false);
    expect(shouldRetrySessionRpc({ code: "STALE_REVISION", retryable: true })).toBe(false);
  });

  it("keeps retrying lock contention until a successful list arrives", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { items: ["old-session"] } });
    const wait = vi.fn(async () => {});

    const result = await requestSessionRpcWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { items: ["old-session"] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });
});
