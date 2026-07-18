import { describe, expect, it } from "vitest";
import type { ToolSnapshot } from "@pi-desktop/protocol";
import { classifyToolSnapshot } from "./tool-revision";

function snapshot(revision: number, active: string[] = []): ToolSnapshot {
  return {
    revision,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    sessionRevision: 1,
    tools: [],
    active,
  };
}

describe("classifyToolSnapshot", () => {
  it("applies the initial and next contiguous snapshot", () => {
    expect(classifyToolSnapshot(null, snapshot(1))).toBe("apply");
    expect(classifyToolSnapshot(snapshot(1), snapshot(2))).toBe("apply");
  });

  it("drops an identical same-revision duplicate", () => {
    expect(classifyToolSnapshot(snapshot(2, ["read"]), snapshot(2, ["read"]))).toBe("drop");
  });

  it("recovers on a conflicting duplicate or skipped revision", () => {
    expect(classifyToolSnapshot(snapshot(2, ["read"]), snapshot(2, ["write"]))).toBe("recover");
    expect(classifyToolSnapshot(snapshot(2), snapshot(4))).toBe("recover");
  });
});
