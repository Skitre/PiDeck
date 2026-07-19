import { describe, expect, it } from "vitest";
import {
  addKnownWorkspace,
  removeKnownWorkspace,
  workspaceDisplayName,
} from "./WorkspacePicker";

describe("known workspace list", () => {
  it("appends new paths and keeps insertion order", () => {
    const list = addKnownWorkspace(["C:\\repos\\alpha"], "C:\\repos\\beta");
    expect(list).toEqual(["C:\\repos\\alpha", "C:\\repos\\beta"]);
  });

  it("deduplicates case-insensitively, keeping first-seen casing", () => {
    const list = addKnownWorkspace(["C:\\Repos\\Alpha"], "c:\\repos\\alpha");
    expect(list).toEqual(["C:\\Repos\\Alpha"]);
  });

  it("removes entries case-insensitively", () => {
    const list = removeKnownWorkspace(
      ["C:\\Repos\\Alpha", "C:\\repos\\beta"],
      "c:\\repos\\ALPHA",
    );
    expect(list).toEqual(["C:\\repos\\beta"]);
  });
});

describe("workspaceDisplayName", () => {
  it("uses the last path segment for both separators", () => {
    expect(workspaceDisplayName("C:\\repos\\alpha")).toBe("alpha");
    expect(workspaceDisplayName("/home/user/beta/")).toBe("beta");
  });
});
