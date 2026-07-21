import { describe, expect, it } from "vitest";
import { prioritizePinnedSessions } from "./session-pins";

describe("prioritizePinnedSessions", () => {
  it("moves pinned Sessions first without disturbing order within each group", () => {
    const items = [
      { sessionId: "recent" },
      { sessionId: "pinned-newer" },
      { sessionId: "older" },
      { sessionId: "pinned-older" },
    ];

    expect(
      prioritizePinnedSessions(items, ["pinned-older", "pinned-newer"]).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["pinned-newer", "pinned-older", "recent", "older"]);
  });

  it("returns the original list when there are no pins", () => {
    const items = [{ sessionId: "one" }];
    expect(prioritizePinnedSessions(items, [])).toBe(items);
  });
});
