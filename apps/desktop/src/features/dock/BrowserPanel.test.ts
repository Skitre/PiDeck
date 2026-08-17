import { describe, expect, it } from "vitest";
import { clipBrowserBounds, normalizeBrowserInput } from "./BrowserPanel";

describe("normalizeBrowserInput", () => {
  it("keeps explicit URLs for native validation", () => {
    expect(normalizeBrowserInput("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserInput("file:///tmp/example")).toBe("file:///tmp/example");
  });

  it("adds https to host-like input", () => {
    expect(normalizeBrowserInput("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserInput("localhost:5173")).toBe("http://localhost:5173");
  });

  it("turns other text into a search and keeps blank as the empty page", () => {
    expect(normalizeBrowserInput("native webview security")).toBe(
      "https://www.google.com/search?q=native%20webview%20security",
    );
    expect(normalizeBrowserInput("   ")).toBe("about:blank");
  });
});

describe("clipBrowserBounds", () => {
  const bounds = { x: 800, y: 80, width: 400, height: 600, devicePixelRatio: 1.5 };
  const dock = { left: 790, top: 40, right: 1200, bottom: 680 };

  it("keeps the placeholder when it already sits inside the dock", () => {
    expect(clipBrowserBounds(bounds, dock, 0)).toEqual(bounds);
  });

  it("clamps a surface that extends past the dock and the window radius", () => {
    expect(
      clipBrowserBounds(
        { x: 790, y: 40, width: 430, height: 660, devicePixelRatio: 1.5 },
        dock,
        12,
      ),
    ).toEqual({
      x: 790,
      y: 40,
      width: 398,
      height: 628,
      devicePixelRatio: 1.5,
    });
  });
});
