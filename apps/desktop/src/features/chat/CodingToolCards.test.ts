import { describe, expect, it } from "vitest";
import {
  isFileMutationTool,
  isFileReadTool,
  isShellTool,
  mutationDiff,
  toolResultText,
} from "./CodingToolCards";
import { selectToolRenderer } from "./ToolView";

describe("coding tool renderers", () => {
  it("selects built-in coding tool renderers", () => {
    expect(isFileReadTool("read")).toBe(true);
    expect(isShellTool("exec_command")).toBe(true);
    expect(isFileMutationTool("apply_patch")).toBe(true);
    expect(selectToolRenderer({ name: "read", status: "done" })?.id).toBe("file-read");
    expect(selectToolRenderer({ name: "bash", status: "done" })?.id).toBe("shell");
    expect(selectToolRenderer({ name: "edit", status: "done" })?.id).toBe("file-mutation");
  });

  it("unwraps live structured tool results", () => {
    expect(
      toolResultText(
        JSON.stringify({
          content: [{ type: "text", text: "line one\nline two" }],
          details: { fullOutputPath: "output.log" },
        }),
      ),
    ).toBe("line one\nline two");
  });

  it("uses Pi edit details when available", () => {
    expect(
      mutationDiff({
        name: "edit",
        args: { path: "a.ts" },
        details: { patch: "@@ -1 +1 @@\n-old\n+new" },
      }),
    ).toBe("@@ -1 +1 @@\n-old\n+new");
  });

  it("builds a preview from edit and write arguments", () => {
    expect(
      mutationDiff({
        name: "edit",
        args: { edits: [{ oldText: "old", newText: "new" }] },
      }),
    ).toBe("-old\n+new");
    expect(
      mutationDiff({
        name: "write",
        args: { content: "one\ntwo" },
      }),
    ).toBe("+one\n+two");
  });
});
