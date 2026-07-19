import { describe, expect, it } from "vitest";
import { commandTokenAt, fileTokenAt } from "./Composer";

describe("commandTokenAt", () => {
  it("matches a leading slash token touching the caret", () => {
    expect(commandTokenAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(commandTokenAt("/pla", 4)).toEqual({ start: 0, query: "pla" });
  });

  it("rejects mid-text slashes and completed tokens", () => {
    expect(commandTokenAt("hi /plan", 8)).toBeNull();
    expect(commandTokenAt("/plan run", 9)).toBeNull();
    expect(commandTokenAt("/plan", 2)).toEqual({ start: 0, query: "p" });
  });
});

describe("fileTokenAt", () => {
  it("matches @ tokens at start or after whitespace", () => {
    expect(fileTokenAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(fileTokenAt("see @src/ma", 11)).toEqual({ start: 4, query: "src/ma" });
  });

  it("rejects emails and completed tokens", () => {
    expect(fileTokenAt("mail me@example.com", 19)).toBeNull();
    expect(fileTokenAt("see @src/main.ts done", 21)).toBeNull();
  });
});
