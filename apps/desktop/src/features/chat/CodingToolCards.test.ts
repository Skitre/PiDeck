import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  isFileMutationTool,
  isFileReadTool,
  isShellTool,
  mutationDiff,
  toolResultText,
} from "./CodingToolCards";
import { selectToolRenderer, ToolView } from "./ToolView";

describe("coding tool renderers", () => {
  it("selects built-in coding tool renderers", () => {
    expect(isFileReadTool("read")).toBe(true);
    expect(isShellTool("exec_command")).toBe(true);
    expect(isFileMutationTool("apply_patch")).toBe(true);
    expect(selectToolRenderer({ name: "read", status: "done" })?.id).toBe("file-read");
    expect(selectToolRenderer({ name: "bash", status: "done" })?.id).toBe("shell");
    expect(selectToolRenderer({ name: "edit", status: "done" })?.id).toBe("file-mutation");
  });

  it("keeps a running specialized tool collapsed by default", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolView, {
        name: "bash",
        status: "running",
        args: { command: "pnpm test" },
        result: "Running...",
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<pre");
  });

  it("shares a controlled expansion state across specialized and rich renderers", () => {
    const specialized = renderToStaticMarkup(
      createElement(ToolView, {
        name: "bash",
        status: "running",
        args: { command: "pnpm test" },
        result: "Running...",
        expanded: true,
      }),
    );
    const rich = renderToStaticMarkup(
      createElement(ToolView, {
        name: "bash",
        status: "done",
        args: { command: "pnpm test" },
        resultContent: createElement("span", null, "image result"),
        expanded: true,
      }),
    );

    expect(specialized).toContain('aria-expanded="true"');
    expect(specialized).toContain("<pre");
    expect(rich).toContain('aria-expanded="true"');
    expect(rich).toContain("image result");
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
