/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>();
  return {
    ...actual,
    Streamdown: ({ children }: { children?: unknown }) => {
      throw new Error(`optional renderer unavailable: ${String(children)}`);
    },
  };
});

import { MarkdownMessage } from "./MarkdownMessage";

afterEach(() => {
  cleanup();
});

describe("MarkdownMessage enhancement failures", () => {
  it("falls back to plain text without failing the surrounding UI", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <MarkdownMessage content={"```ts\nconst answer = 42;\n```"} mode="static" />,
    );

    expect(container).toHaveTextContent("const answer = 42;");
    expect(warn).toHaveBeenCalledWith(
      "PiDeck Markdown enhancement failed; using plain text",
      expect.objectContaining({ message: expect.stringContaining("optional renderer unavailable") }),
    );
    warn.mockRestore();
    error.mockRestore();
  });
});
