import { describe, expect, it } from "vitest";
import { recentDesktopLocationPatch } from "./desktop-settings";

describe("recentDesktopLocationPatch", () => {
  it("persists both the active workspace and session", () => {
    expect(recentDesktopLocationPatch("C:/workspace", "C:/sessions/current.jsonl")).toEqual({
      lastWorkspace: "C:/workspace",
      lastSessionPath: "C:/sessions/current.jsonl",
    });
  });

  it("clears a session from the previous workspace", () => {
    expect(recentDesktopLocationPatch("C:/next", null)).toEqual({
      lastWorkspace: "C:/next",
      lastSessionPath: null,
    });
  });
});
