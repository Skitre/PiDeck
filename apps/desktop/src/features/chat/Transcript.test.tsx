import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantOrderedContent, ExecutionTrace } from "./Transcript";
import type { TranscriptBlock } from "./transcript-model";

function toolBlock(id: string, status: "running" | "done"): TranscriptBlock {
  return {
    kind: "tool",
    tool: { id, name: "read", status },
  };
}

describe("ExecutionTrace", () => {
  it("keeps an active turn running with a list icon and collapsed content", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done")]}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("Running 1 action");
    expect(markup).toContain("lucide-list-tree");
    expect(markup).not.toContain("lucide-brain");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("settles after the agent turn ends", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done")]}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    expect(markup).toContain("1 action completed");
  });

  it("keeps a mixed completed-and-running trace active", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done"), toolBlock("tool-2", "running")]}
        stepCount={2}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("Running 2 actions");
    expect(markup).not.toContain("2 actions completed");
  });
});

describe("AssistantOrderedContent", () => {
  it("keeps only the trailing trace active", () => {
    const markup = renderToStaticMarkup(
      <AssistantOrderedContent
        blocks={[
          toolBlock("tool-1", "done"),
          { kind: "unknown", type: "separator", value: null },
          toolBlock("tool-2", "done"),
        ]}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("1 action completed");
    expect(markup).toContain("Running 1 action");
  });
});
