import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard, toolSummary, toolValueText } from "./ToolCard";

describe("tool display helpers", () => {
  it("extracts useful path and command summaries", () => {
    expect(toolSummary({ path: "src/App.tsx" })).toBe("src/App.tsx");
    expect(toolSummary('{"command":"pnpm test\\nnext"}')).toBe("pnpm test");
  });

  it("pretty prints JSON strings without quoting plain output", () => {
    expect(toolValueText('{"ok":true}')).toBe('{\n  "ok": true\n}');
    expect(toolValueText("plain output")).toBe("plain output");
  });

  it("keeps rich result content collapsed by default", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCard, {
        name: "capture",
        status: "running",
        resultContent: createElement(
          "div",
          null,
          createElement("span", null, "first image"),
          createElement("span", null, "middle text"),
          createElement("span", null, "last image"),
        ),
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("first image");
    expect(markup).not.toContain("middle text");
    expect(markup).not.toContain("last image");
  });

  it("honors a controlled expanded state", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCard, {
        name: "capture",
        status: "done",
        resultContent: createElement("span", null, "visible result"),
        expanded: true,
      }),
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("visible result");
  });
});
