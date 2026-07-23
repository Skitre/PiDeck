/**
 * Pure PackageSource filter transformers — PROJECT_SPEC §9.8
 */

import { minimatch } from "minimatch";

export type PackageSourceObject = {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  [key: string]: unknown;
};

export type PackageSource = string | PackageSourceObject;

export type ResourceTypeKey = "extensions" | "skills" | "prompts" | "themes";

const TYPE_MAP: Record<"extension" | "skill" | "prompt" | "theme", ResourceTypeKey> = {
  extension: "extensions",
  skill: "skills",
  prompt: "prompts",
  theme: "themes",
};

/** Normalize Windows paths to forward slashes for settings. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function toObjectSource(source: PackageSource): PackageSourceObject {
  if (typeof source === "string") {
    return { source };
  }
  return { ...source };
}

/**
 * Set a single package resource enabled/disabled while preserving other filters.
 */
export function setPackageResourceFilter(
  sources: PackageSource[],
  packageSource: string,
  resourceType: "extension" | "skill" | "prompt" | "theme",
  relativePath: string,
  enabled: boolean,
): PackageSource[] {
  const rel = toPosixPath(relativePath);
  const key = TYPE_MAP[resourceType];

  return sources.map((s) => {
    const obj = toObjectSource(s);
    if (obj.source !== packageSource) return s;

    const next: PackageSourceObject = { ...obj };
    const existing = next[key];

    if (enabled) {
      if (existing === undefined) {
        // all allowed — nothing to do
        return next;
      }
      // Empty array means all disabled; use a plain include to select only this path.
      if (existing.length === 0) {
        // A lone `+path` would otherwise start from allPaths and re-enable all.
        next[key] = [rel];
        return next;
      }
      // Force-excludes win over force-includes in the SDK, so remove every
      // exact force-exclude that targets this resource before enabling it.
      const filters = existing.filter(
        (filter) =>
          !filter.startsWith("-") || !matchesResourcePattern(rel, filter.slice(1), true),
      );
      if (!isEnabledByPackagePatterns(rel, filters)) {
        filters.push(`+${rel}`);
      }
      if (filters.length === 0) {
        delete next[key];
        return next;
      }
      next[key] = filters;
      return next;
    }

    // Disable: append exact -path
    if (existing === undefined) {
      next[key] = [`-${rel}`];
    } else if (existing.length === 0) {
      // already all disabled
      next[key] = [];
    } else {
      const filters = existing.filter(
        (filter) =>
          !filter.startsWith("+") || !matchesResourcePattern(rel, filter.slice(1), true),
      );
      if (!filters.includes(`-${rel}`)) {
        filters.push(`-${rel}`);
      }
      next[key] = filters;
    }
    return next;
  });
}

/**
 * Disable or enable an entire resource type for a package.
 */
export function setPackageResourceTypeFilter(
  sources: PackageSource[],
  packageSource: string,
  resourceType: "extension" | "skill" | "prompt" | "theme",
  enabled: boolean,
): PackageSource[] {
  const key = TYPE_MAP[resourceType];
  return sources.map((s) => {
    const obj = toObjectSource(s);
    if (obj.source !== packageSource) return s;
    const next: PackageSourceObject = { ...obj };
    if (enabled) {
      delete next[key];
    } else {
      next[key] = [];
    }
    return next;
  });
}

/**
 * Top-level path pattern toggle — PROJECT_SPEC §9.8
 * Disable: append exact -path relative to baseDir
 * Enable: remove -path; if still excluded by !pattern, append +path
 */
export function setTopLevelPathEnabled(
  patterns: string[],
  relativePath: string,
  enabled: boolean,
): string[] {
  const rel = toPosixPath(relativePath);
  const minus = `-${rel}`;
  const plus = `+${rel}`;

  if (!enabled) {
    const next = patterns.filter(
      (pattern) =>
        !pattern.startsWith("+") || !matchesResourcePattern(rel, pattern.slice(1), true),
    );
    if (!next.includes(minus)) next.push(minus);
    return next;
  }

  // enable
  let next = patterns.filter(
    (pattern) =>
      !pattern.startsWith("-") || !matchesResourcePattern(rel, pattern.slice(1), true),
  );
  const stillExcluded = next.some(
    (pattern) =>
      pattern.startsWith("!") && matchesResourcePattern(rel, pattern.slice(1)),
  );
  const forceIncluded = next.some(
    (pattern) =>
      pattern.startsWith("+") && matchesResourcePattern(rel, pattern.slice(1), true),
  );
  if (stillExcluded && !forceIncluded) {
    next = [...next, plus];
  }
  return next;
}

export function matchesResourcePattern(
  path: string,
  pattern: string,
  exact = false,
): boolean {
  const normalizedPath = toPosixPath(path);
  const normalizedPattern = toPosixPath(pattern).replace(/^\.\//, "");
  if (exact) {
    if (normalizedPath === normalizedPattern) return true;
    if (!normalizedPath.endsWith("/SKILL.md")) return false;
    const parentPath = normalizedPath.slice(0, -"/SKILL.md".length);
    return parentPath === normalizedPattern;
  }

  const pathParts = normalizedPath.split("/");
  const candidates = [normalizedPath, pathParts.at(-1) ?? normalizedPath];
  if (normalizedPath.endsWith("/SKILL.md")) {
    const parentPath = normalizedPath.slice(0, -"/SKILL.md".length);
    candidates.push(parentPath, parentPath.split("/").at(-1) ?? parentPath);
  }
  return candidates.some((candidate) => minimatch(candidate, normalizedPattern));
}

function isEnabledByPackagePatterns(path: string, patterns: string[]): boolean {
  const includes = patterns.filter((pattern) => !/^[!+-]/.test(pattern));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const forceIncludes = patterns
    .filter((pattern) => pattern.startsWith("+"))
    .map((pattern) => pattern.slice(1));
  const forceExcludes = patterns
    .filter((pattern) => pattern.startsWith("-"))
    .map((pattern) => pattern.slice(1));

  let enabled =
    includes.length === 0 || includes.some((pattern) => matchesResourcePattern(path, pattern));
  if (excludes.some((pattern) => matchesResourcePattern(path, pattern))) enabled = false;
  if (forceIncludes.some((pattern) => matchesResourcePattern(path, pattern, true))) enabled = true;
  if (forceExcludes.some((pattern) => matchesResourcePattern(path, pattern, true))) enabled = false;
  return enabled;
}

export function resourceTypeToSettingsKey(
  type: "extension" | "skill" | "prompt" | "theme",
): ResourceTypeKey {
  return TYPE_MAP[type];
}
