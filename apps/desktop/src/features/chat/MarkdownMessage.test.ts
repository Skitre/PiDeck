import { describe, expect, it } from "vitest";
import {
  codeLineCount,
  deferIncompleteMermaid,
  isSafeExternalUrl,
  isSafeFootnoteFragment,
  mermaidFenceSignature,
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

describe("deferIncompleteMermaid", () => {
  it("keeps an unfinished Mermaid fence as a normal code fence", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B";
    expect(deferIncompleteMermaid(source)).toBe("```text\nflowchart TD\n  A --> B");
  });

  it("does not alter a closed Mermaid fence", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(deferIncompleteMermaid(source)).toBe(source);
  });

  it("supports tilde fences and case-insensitive language names", () => {
    const source = "~~~MERMAID\nflowchart TD\n  A --> B";
    expect(deferIncompleteMermaid(source)).toBe("~~~text\nflowchart TD\n  A --> B");
  });

  it("preserves fence metadata while deferring the Mermaid language", () => {
    const source = '```mermaid title="Flow"\nflowchart TD\n  A --> B';
    expect(deferIncompleteMermaid(source)).toBe(
      '```text title="Flow"\nflowchart TD\n  A --> B',
    );
  });

  it("normalizes a closed uppercase fence and scans blockquotes", () => {
    const closed = "> ```MERMAID\n> flowchart TD\n>   A --> B\n> ```";
    expect(deferIncompleteMermaid(closed)).toBe(
      "> ```mermaid\n> flowchart TD\n>   A --> B\n> ```",
    );

    const open = "> ```mermaid\n> flowchart TD\n>   A --> B";
    expect(deferIncompleteMermaid(open)).toBe(
      "> ```text\n> flowchart TD\n>   A --> B",
    );
  });

  it("defers a list-continuation Mermaid fence", () => {
    const source = "- item\n\n    ```mermaid\n    flowchart TD\n      A --> B";
    expect(deferIncompleteMermaid(source)).toBe(
      "- item\n\n    ```text\n    flowchart TD\n      A --> B",
    );
  });

  it("defers every unfinished fence when sibling containers split code blocks", () => {
    const listSource = "- ```mermaid\nA\n- ```mermaid\nB";
    expect(deferIncompleteMermaid(listSource)).toBe(
      "- ```text\nA\n- ```text\nB",
    );

    const quoteSource = "> ```mermaid\n> A\n\noutside\n\n> ```";
    expect(deferIncompleteMermaid(quoteSource)).toBe(
      "> ```text\n> A\n\noutside\n\n> ```",
    );
  });

  it("follows CommonMark container order for nested lists and blockquotes", () => {
    expect(deferIncompleteMermaid("- > ```mermaid\n  > A")).toBe(
      "- > ```text\n  > A",
    );
    expect(deferIncompleteMermaid("- - ```mermaid\n    A")).toBe(
      "- - ```text\n    A",
    );
  });

  it("preserves tabs and CRLF while replacing only the language token", () => {
    const source = "> \t```MERMAID\r\n> \tflowchart TD\r\n> \t  A --> B";
    expect(deferIncompleteMermaid(source)).toBe(
      "> \t```text\r\n> \tflowchart TD\r\n> \t  A --> B",
    );
  });

  it("does not rewrite Mermaid-like text that is not a fenced code block", () => {
    const paragraph = "paragraph\n2. ```mermaid\n   A";
    const invalidInfo = "```mermaid`invalid\nA";
    const otherLanguage = "~~~mermaid~invalid\nA";

    expect(deferIncompleteMermaid(paragraph)).toBe(paragraph);
    expect(deferIncompleteMermaid(invalidInfo)).toBe(invalidInfo);
    expect(deferIncompleteMermaid(otherLanguage)).toBe(otherLanguage);
  });

  it("does not mistake diagram content for a closing fence", () => {
    const source = "```mermaid\nflowchart TD\n- ```";
    expect(deferIncompleteMermaid(source)).toBe("```text\nflowchart TD\n- ```");
  });

  it("signs only closed Mermaid source", () => {
    const closed = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(mermaidFenceSignature("```mermaid\nflowchart TD\n  A --> B")).toBe("none");
    expect(mermaidFenceSignature(`${closed}\ntrailing prose`)).toBe(
      mermaidFenceSignature(`${closed}\ndifferent prose`),
    );
    expect(mermaidFenceSignature(closed)).not.toBe(
      mermaidFenceSignature("```mermaid\nflowchart TD\n  A --> C\n```"),
    );
  });
});

describe("safe footnote fragments", () => {
  it("allows only generated footnote and back-reference targets", () => {
    const prefix = "pideck-md-r0-";
    expect(isSafeFootnoteFragment("#pideck-md-r0-fn-note", prefix)).toBe(true);
    expect(isSafeFootnoteFragment("#pideck-md-r0-fnref-note-2", prefix)).toBe(true);
    expect(isSafeFootnoteFragment("#user-content-fn-note", prefix)).toBe(false);
    expect(isSafeFootnoteFragment("#pideck-md-r0-fn-note/../secret", prefix)).toBe(false);
  });
});
