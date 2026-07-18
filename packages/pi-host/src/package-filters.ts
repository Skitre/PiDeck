/**
 * Pure PackageSource filter transformers — PROJECT_SPEC §9.8
 */

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
      // Empty array means all disabled — force-include this path
      if (existing.length === 0) {
        next[key] = [`+${rel}`];
        return next;
      }
      // Remove exact -path; keep other filters
      let filters = [...existing].filter((f) => f !== `-${rel}`);
      // If still excluded by !pattern, force-include with +path
      const stillExcludedByPattern = filters.some(
        (f) => f.startsWith("!") && matchesSimpleGlob(rel, f.slice(1)),
      );
      if (stillExcludedByPattern) {
        if (!filters.includes(`+${rel}`) && !filters.includes(rel)) {
          filters.push(`+${rel}`);
        }
      } else {
        filters = filters.filter((f) => f !== `+${rel}`);
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
      const filters = existing.filter((f) => f !== `+${rel}` && f !== rel);
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
    const next = patterns.filter((p) => p !== plus && p !== rel);
    if (!next.includes(minus)) next.push(minus);
    return next;
  }

  // enable
  let next = patterns.filter((p) => p !== minus);
  const stillExcluded = next.some((p) => {
    if (p.startsWith("!") && matchesSimpleGlob(rel, p.slice(1))) return true;
    return false;
  });
  if (stillExcluded && !next.includes(plus) && !next.includes(rel)) {
    next = [...next, plus];
  }
  return next;
}

function matchesSimpleGlob(path: string, pattern: string): boolean {
  // minimal glob: * and **
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function resourceTypeToSettingsKey(
  type: "extension" | "skill" | "prompt" | "theme",
): ResourceTypeKey {
  return TYPE_MAP[type];
}
