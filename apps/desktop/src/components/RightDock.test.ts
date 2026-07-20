import { describe, expect, it } from "vitest";
import {
  clampDockWidth,
  partitionDockTabs,
  visibleDockTabLimit,
} from "./RightDock";

describe("clampDockWidth", () => {
  it("uses the configured desktop limits", () => {
    expect(clampDockWidth(300, 1280)).toBe(460);
    expect(clampDockWidth(460, 1280)).toBe(460);
    expect(clampDockWidth(520, 1280)).toBe(520);
    expect(clampDockWidth(900, 1280)).toBe(720);
  });

  it("keeps space for the main pane on a narrow window", () => {
    expect(clampDockWidth(720, 960)).toBe(600);
    expect(clampDockWidth(Number.NaN, 800)).toBe(460);
  });
});

describe("dock tab overflow", () => {
  it("shrinks all tabs until they reach the minimum width", () => {
    expect(visibleDockTabLimit(328, 3)).toBe(3);
    expect(visibleDockTabLimit(327, 3)).toBe(2);
  });

  it("reserves room for the overflow menu and new-tab button", () => {
    expect(visibleDockTabLimit(312, 4)).toBe(2);
    expect(visibleDockTabLimit(512, 5)).toBe(4);
  });

  it("keeps the active tab visible and moves another tab into the menu", () => {
    expect(partitionDockTabs(["a", "b", "c", "d"], "d", 2)).toEqual({
      visible: ["a", "d"],
      overflow: ["b", "c"],
    });
  });
});
