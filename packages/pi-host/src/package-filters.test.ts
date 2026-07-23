import { describe, expect, it } from "vitest";
import {
  matchesResourcePattern,
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

  it("selects only one resource when enabling from an empty filter", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", extensions: [] }],
      "npm:foo",
      "extension",
      "extensions/a.ts",
      true,
    );
    expect(result).toEqual([{ source: "npm:foo", extensions: ["extensions/a.ts"] }]);
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

  it("force-includes a resource outside plain include patterns", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", skills: ["skills/review/**"] }],
      "npm:foo",
      "skill",
      "skills/write/SKILL.md",
      true,
    );
    expect(result).toEqual([
      {
        source: "npm:foo",
        skills: ["skills/review/**", "+skills/write/SKILL.md"],
      },
    ]);
  });

  it("preserves plain includes when disabling one included resource", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", extensions: ["extensions/a.ts"] }],
      "npm:foo",
      "extension",
      "extensions/a.ts",
      false,
    );
    expect(result).toEqual([
      {
        source: "npm:foo",
        extensions: ["extensions/a.ts", "-extensions/a.ts"],
      },
    ]);
  });

  it("removes a skill parent force-include before disabling the skill", () => {
    const result = setPackageResourceFilter(
      [{ source: "npm:foo", skills: ["+skills/review"] }],
      "npm:foo",
      "skill",
      "skills/review/SKILL.md",
      false,
    );
    expect(result).toEqual([
      {
        source: "npm:foo",
        skills: ["-skills/review/SKILL.md"],
      },
    ]);
  });

  it("respects force-exclude precedence when re-enabling", () => {
    const result = setPackageResourceFilter(
      [
        {
          source: "npm:foo",
          skills: [
            "skills/**",
            "!skills/private/**",
            "+skills/private/write/SKILL.md",
            "-skills/private/write/SKILL.md",
          ],
        },
      ],
      "npm:foo",
      "skill",
      "skills/private/write/SKILL.md",
      true,
    );
    expect(result).toEqual([
      {
        source: "npm:foo",
        skills: [
          "skills/**",
          "!skills/private/**",
          "+skills/private/write/SKILL.md",
        ],
      },
    ]);
  });
});

describe("matchesResourcePattern", () => {
  it("supports minimatch globstar semantics", () => {
    expect(matchesResourcePattern("extensions/a.ts", "extensions/**/a.ts")).toBe(true);
    expect(matchesResourcePattern("extensions/deep/nested/a.ts", "extensions/**/a.ts")).toBe(
      true,
    );
    expect(matchesResourcePattern("extensions/deep/nested/a.ts", "extensions/*/a.ts")).toBe(
      false,
    );
  });

  it("matches skill directory patterns", () => {
    expect(matchesResourcePattern("skills/review/SKILL.md", "review")).toBe(true);
    expect(matchesResourcePattern("skills/review/SKILL.md", "skills/review", true)).toBe(true);
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

  it("uses globstar exclusions when re-enabling", () => {
    expect(setTopLevelPathEnabled(["!ext/**/internal/*.ts"], "ext/a/internal/x.ts", true)).toEqual([
      "!ext/**/internal/*.ts",
      "+ext/a/internal/x.ts",
    ]);
  });

  it("removes a skill parent force-include before disabling the skill", () => {
    expect(
      setTopLevelPathEnabled(["+skills/review"], "skills/review/SKILL.md", false),
    ).toEqual(["-skills/review/SKILL.md"]);
  });

  it("normalizes backslashes", () => {
    expect(setTopLevelPathEnabled([], "ext\\a.ts", false)).toEqual(["-ext/a.ts"]);
  });
});
