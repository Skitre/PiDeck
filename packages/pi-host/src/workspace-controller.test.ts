import { describe, expect, it } from "vitest";
import { gitignoreLineToRegex, searchSortKey } from "./workspace-controller.js";

function ignored(line: string, rel: string, isDir = false): boolean {
  const rule = gitignoreLineToRegex(line);
  if (!rule) return false;
  if (rule.dirOnly && !isDir) return false;
  return rule.re.test(rel);
}

describe("gitignoreLineToRegex", () => {
  it("skips blanks, comments, and negations", () => {
    expect(gitignoreLineToRegex("")).toBeNull();
    expect(gitignoreLineToRegex("# comment")).toBeNull();
    expect(gitignoreLineToRegex("!keep.txt")).toBeNull();
  });

  it("matches plain names at any segment", () => {
    expect(ignored("logs", "logs", true)).toBe(true);
    expect(ignored("logs", "packages/app/logs", true)).toBe(true);
    expect(ignored("logs", "packages/app/logs/x.txt")).toBe(true);
    expect(ignored("logs", "catalogs")).toBe(false);
  });

  it("supports globs, anchors, and dir-only patterns", () => {
    expect(ignored("*.log", "a/b/debug.log")).toBe(true);
    expect(ignored("*.log", "a/b/debug.logx")).toBe(false);
    expect(ignored("/dist", "dist/x.js")).toBe(true);
    expect(ignored("/dist", "packages/dist/x.js")).toBe(false);
    expect(ignored("build/", "build", true)).toBe(true);
    expect(ignored("build/", "build.rs", false)).toBe(false);
    expect(ignored("**/gen", "a/b/gen", true)).toBe(true);
  });
});

describe("searchSortKey", () => {
  it("ranks filename prefix, path prefix, filename substring, rest", () => {
    const rank = (path: string, kind: "file" | "dir" = "file") =>
      searchSortKey({ path, kind }, "comp")[0];
    expect(rank("src/Composer.tsx")).toBe(0);
    expect(rank("components/x.ts")).toBe(1);
    expect(rank("src/MyComposer.tsx")).toBe(2);
    expect(rank("compat/other.ts")).toBe(1);
    expect(rank("src/util.ts")).toBe(3);
  });

  it("prefers shallower paths and dirs before files", () => {
    const a = searchSortKey({ path: "src", kind: "dir" }, "");
    const b = searchSortKey({ path: "src/deep/file.ts", kind: "file" }, "");
    expect(a[1]).toBeLessThan(b[1]);
    expect(a[2]).toBeLessThan(b[2]);
  });
});
