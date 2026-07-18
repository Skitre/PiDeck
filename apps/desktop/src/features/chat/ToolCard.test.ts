import { describe, expect, it } from "vitest";
import { toolSummary, toolValueText } from "./ToolCard";

describe("tool display helpers", () => {
  it("extracts useful path and command summaries", () => {
    expect(toolSummary({ path: "src/App.tsx" })).toBe("src/App.tsx");
    expect(toolSummary('{"command":"pnpm test\\nnext"}')).toBe("pnpm test");
  });

  it("pretty prints JSON strings without quoting plain output", () => {
    expect(toolValueText('{"ok":true}')).toBe('{\n  "ok": true\n}');
    expect(toolValueText("plain output")).toBe("plain output");
  });
});
