import { describe, expect, it } from "vitest";
import {
  codeLineCount,
  isSafeExternalUrl,
  sanitizeAgentText,
} from "./markdown-utils";

describe("sanitizeAgentText", () => {
  it("removes ANSI decoration and internal dcp markers", () => {
    expect(
      sanitizeAgentText(
        "\u001b[38;5;38mThinking:\u001b[39m Inspect this\n<dcp-id>m004</dcp-id>",
      ),
    ).toBe("Inspect this\n");
  });
});

describe("safe markdown URLs", () => {
  it.each(["https://example.com/path", "http://localhost:1420/"])(
    "allows %s",
    (url) => expect(isSafeExternalUrl(url)).toBe(true),
  );

  it.each(["javascript:alert(1)", "file:///C:/secret", "../relative.md", "mailto:a@b.com"])(
    "rejects %s",
    (url) => expect(isSafeExternalUrl(url)).toBe(false),
  );
});

describe("codeLineCount", () => {
  it("does not count the trailing newline as another line", () => {
    expect(codeLineCount("one\ntwo\n")).toBe(2);
  });
});
