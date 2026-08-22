import { describe, expect, it } from "vitest";
import {
  applyFloatResize,
  clampAndSnapFloatRect,
  excludeBrowserRect,
  floatRectToPixels,
  pixelsToNormalizedFloatRect,
  rectsOverlap,
  resizeFloatRect,
} from "./extension-ui-float-geometry";

const viewport = { width: 1000, height: 800 };

describe("extension float geometry", () => {
  it("round-trips a normalized global rect through the current viewport", () => {
    const rect = { x: 0.62, y: 0.08, width: 360, height: 240 };
    const pixels = floatRectToPixels(rect, viewport);
    expect(pixels).toEqual({ left: 620, top: 64, width: 360, height: 240 });
    expect(pixelsToNormalizedFloatRect(pixels, viewport)).toEqual(rect);
  });

  it("clamps and snaps to the viewport instead of writing pointer-move overflow", () => {
    expect(
      clampAndSnapFloatRect({ left: -40, top: -20, width: 360, height: 240 }, viewport),
    ).toEqual({ left: 8, top: 8, width: 360, height: 240 });
    expect(
      clampAndSnapFloatRect({ left: 980, top: 760, width: 360, height: 240 }, viewport),
    ).toEqual({ left: 632, top: 552, width: 360, height: 240 });
  });

  it("resizes from an edge without moving the opposite side", () => {
    const start = { left: 100, top: 80, width: 300, height: 180 };
    expect(applyFloatResize(start, "se", 40, 20)).toEqual({
      left: 100,
      top: 80,
      width: 340,
      height: 200,
    });
    expect(applyFloatResize(start, "nw", -20, -10)).toEqual({
      left: 80,
      top: 70,
      width: 320,
      height: 190,
    });
  });

  it("clamps a west resize to the minimum width without moving the east edge", () => {
    const start = { left: 100, top: 80, width: 300, height: 180 };
    const next = resizeFloatRect(start, "w", 250, 0, viewport);
    expect(next.width).toBe(200);
    expect(next.left + next.width).toBe(400);
  });

  it("keeps floats out of a visible Browser native rect", () => {
    const overlapping = { left: 700, top: 40, width: 300, height: 200 };
    const browser = { left: 720, top: 0, width: 280, height: 800 };
    expect(rectsOverlap(overlapping, browser)).toBe(true);
    expect(excludeBrowserRect(overlapping, browser)).toEqual({
      left: 412,
      top: 40,
      width: 300,
      height: 200,
    });
    expect(clampAndSnapFloatRect(overlapping, viewport, browser).left + 300).toBeLessThanOrEqual(
      browser.left,
    );
  });
});
