import { describe, expect, it } from "vitest";
import {
  setPackageResourceFilter,
  setPackageResourceTypeFilter,
  setTopLevelPathEnabled,
  toObjectSource,
  toPosixPath,
} from "./package-filters.js";

describe("toPosixPath", () => {
  it("converts Windows separators", () => {
    expect(toPosixPath("C:\\foo\\bar.ts")).toBe("C:/foo/bar.ts");
  });
});

describe("toObjectSource", () => {
  it("wraps string sources", () => {
    expect(toObjectSource("npm:foo")).toEqual({ source: "npm:foo" });
  });

  it("preserves object sources", () => {
    expect(toObjectSource({ source: "npm:foo", extensions: ["-a"] })).toEqual({
      source: "npm:foo",
      extensions: ["-a"],
    });
  });
});

describe("setPackageResourceFilter", () => {
  it("disables a single extension", () => {
    const result = setPackageResourceFilter(
      ["npm:foo"],
      "npm:foo",
      "extension",
      "extensions/a.ts",
      false,
    );
    expect(result).toEqual([
      { source: "npm:foo", extensions: ["-extensions/a.ts"] },
    ]);
  });

  it("re-enables a single extension", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", extensions: ["-extensions/a.ts", "-extensions/b.ts"] }],
      "npm:foo",
      "extension",
      "extensions/a.ts",
      true,
    );
    expect(result[0]).toMatchObject({
      source: "npm:foo",
      extensions: ["-extensions/b.ts"],
    });
  });

  it("preserves other type filters", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", skills: ["-x"], extensions: ["-a"] }],
      "npm:foo",
      "extension",
      "a",
      true,
    );
    const obj = result[0] as { skills?: string[] };
    expect(obj.skills).toEqual(["-x"]);
  });

  it("does not rewrite unrelated packages", () => {
    const result = setPackageResourceFilter(
      ["npm:a", "npm:b"],
      "npm:a",
      "theme",
      "t.json",
      false,
    );
    expect(result[1]).toBe("npm:b");
  });
});

describe("setPackageResourceTypeFilter", () => {
  it("disables entire type with empty array", () => {
    const result = setPackageResourceTypeFilter(["npm:foo"], "npm:foo", "skill", false);
    expect(result).toEqual([{ source: "npm:foo", skills: [] }]);
  });

  it("re-enables entire type by removing key", () => {
    const result = setPackageResourceTypeFilter(
      [{ source: "npm:foo", skills: [] }],
      "npm:foo",
      "skill",
      true,
    );
    expect(result).toEqual([{ source: "npm:foo" }]);
  });
});

describe("setTopLevelPathEnabled", () => {
  it("disables by appending -path", () => {
    expect(setTopLevelPathEnabled([], "ext/a.ts", false)).toEqual(["-ext/a.ts"]);
  });

  it("enables by removing -path", () => {
    expect(setTopLevelPathEnabled(["-ext/a.ts", "other"], "ext/a.ts", true)).toEqual([
      "other",
    ]);
  });

  it("adds +path when still excluded by !pattern", () => {
    expect(setTopLevelPathEnabled(["!ext/*"], "ext/a.ts", true)).toEqual([
      "!ext/*",
      "+ext/a.ts",
    ]);
  });

  it("normalizes backslashes", () => {
    expect(setTopLevelPathEnabled([], "ext\\a.ts", false)).toEqual(["-ext/a.ts"]);
  });
});
