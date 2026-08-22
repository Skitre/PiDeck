import { describe, expect, it } from "vitest";
import { statusChipText } from "./extension-ui-status-text";

describe("statusChipText", () => {
  it("keeps the Extension text and does not prefix the key", () => {
    expect(statusChipText("mcp", "🔌 MCP: 1 server enabled")).toBe("🔌 MCP: 1 server enabled");
    expect(statusChipText("brainstorm", "🧠 brainstorm")).toBe("🧠 brainstorm");
    expect(statusChipText("dcp", "DCP")).toBe("DCP");
    expect(statusChipText("fleet", "running")).toBe("running");
  });

  it("falls back to the key only when the text is empty", () => {
    expect(statusChipText("mcp", "   ")).toBe("mcp");
    expect(statusChipText("default", "")).toBe("");
  });
});
