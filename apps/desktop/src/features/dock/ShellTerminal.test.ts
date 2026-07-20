import { describe, expect, it } from "vitest";
import { chunkTerminalInput, shellTerminalLabel } from "./ShellTerminal";

describe("chunkTerminalInput", () => {
  it("preserves input order while bounding chunks", () => {
    const input = "abcdefghij";
    const chunks = chunkTerminalInput(input, 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.join("")).toBe(input);
  });

  it("does not split a Unicode surrogate pair", () => {
    const input = `abc\u{1f642}def`;
    const chunks = chunkTerminalInput(input, 4);
    expect(chunks).toEqual(["abc", "\u{1f642}de", "f"]);
    expect(chunks.join("")).toBe(input);
  });
});

describe("shellTerminalLabel", () => {
  it("uses the final workspace directory on Windows and Unix", () => {
    expect(shellTerminalLabel("C:\\work\\PiDesktop")).toBe("PiDesktop");
    expect(shellTerminalLabel("/work/PiDesktop/")).toBe("PiDesktop");
  });
});
