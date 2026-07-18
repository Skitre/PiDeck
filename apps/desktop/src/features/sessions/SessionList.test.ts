import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  includeActiveSession,
  canReloadSession,
  filterSessionItems,
  requestSessionListWithRetry,
  sessionDisplayName,
  sessionRuntimeLabel,
  shouldRetrySessionList,
} from "./SessionList";

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
  pending: { steering: [], followUp: [] },
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

describe("includeActiveSession", () => {
  it("shows an active conversation before session.list persists it", () => {
    expect(includeActiveSession([], active)).toMatchObject([
      {
        sessionId: "active-session",
        sessionPath: "C:/sessions/active.jsonl",
        messageCount: 1,
      },
    ]);
  });

  it("replaces the listed active session instead of duplicating it", () => {
    const result = includeActiveSession(
      [
        {
          sessionId: "active-session",
          sessionPath: "C:/sessions/active.jsonl",
          cwd: "C:/workspace",
          updatedAt: 123,
          messageCount: 0,
        },
      ],
      active,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ updatedAt: 123, messageCount: 1 });
  });
});

describe("sessionDisplayName", () => {
  it("uses the persisted name and falls back to 新会话", () => {
    expect(sessionDisplayName({ name: "修复会话恢复" })).toBe("修复会话恢复");
    expect(sessionDisplayName({ name: undefined })).toBe("新会话");
    expect(sessionDisplayName({ name: "  " })).toBe("新会话");
  });
});

describe("sessionRuntimeLabel", () => {
  it("exposes the normalized runtime state", () => {
    expect(sessionRuntimeLabel("running")).toBe("running");
    expect(sessionRuntimeLabel("inactive")).toBe("inactive");
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

  it("searches names, fallback labels, cwd, and ids", () => {
    expect(filterSessionItems(items, "reconnect", "all")).toEqual([items[0]]);
    expect(filterSessionItems(items, "beta", "all")).toEqual([items[1]]);
    expect(filterSessionItems(items, "tests-session", "all")).toEqual([items[1]]);
    expect(filterSessionItems(items, "新会话", "all")).toEqual([items[1]]);
  });

  it("combines text search with runtime filtering", () => {
    expect(filterSessionItems(items, "workspace", "running")).toEqual([items[0]]);
    expect(filterSessionItems(items, "repair", "inactive")).toEqual([]);
  });

  it("keeps archived Sessions out of normal filters", () => {
    expect(filterSessionItems(items, "", "all")).toEqual(items.slice(0, 2));
    expect(filterSessionItems(items, "", "inactive")).toEqual([items[1]]);
    expect(filterSessionItems(items, "investigation", "archived")).toEqual([
      items[2],
    ]);
  });
});

describe("shouldRetrySessionList", () => {
  it("retries only transient graph-lock contention", () => {
    expect(
      shouldRetrySessionList({ code: "SERVICE_GRAPH_BUSY", retryable: true }),
    ).toBe(true);
    expect(
      shouldRetrySessionList({ code: "SERVICE_GRAPH_BUSY", retryable: false }),
    ).toBe(false);
    expect(shouldRetrySessionList({ code: "STALE_REVISION", retryable: true })).toBe(
      false,
    );
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

    const result = await requestSessionListWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { items: ["old-session"] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });
});
