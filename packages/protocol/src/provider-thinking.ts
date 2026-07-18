import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ThinkingCapabilityDetection = {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  source: "provider" | "profile" | "inferred" | "default";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findEffortValues(metadata: unknown): string[] | null {
  if (!isObject(metadata)) return null;
  const capabilities = isObject(metadata.capabilities) ? metadata.capabilities : undefined;
  const candidates = [
    metadata.supported_reasoning_efforts,
    metadata.reasoning_efforts,
    metadata.supportedThinkingLevels,
    capabilities?.supported_reasoning_efforts,
    capabilities?.reasoning_efforts,
    capabilities?.thinking_levels,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
      return candidate as string[];
    }
  }
  return null;
}

function mapEfforts(values: string[]): ThinkingLevelMap | null {
  const aliases: Record<string, ThinkingLevel> = {
    none: "off",
    disabled: "off",
    min: "minimal",
    extra_high: "xhigh",
    "extra-high": "xhigh",
    maximum: "max",
  };
  const mapped = new Map<ThinkingLevel, string>();
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    const level = aliases[normalized] ?? (THINKING_LEVELS.includes(normalized as ThinkingLevel)
      ? (normalized as ThinkingLevel)
      : undefined);
    if (level) mapped.set(level, raw);
  }
  if (mapped.size === 0) return null;
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, mapped.get(level) ?? null]),
  ) as ThinkingLevelMap;
}

export function detectModelThinking(
  modelId: string,
  metadata?: unknown,
): ThinkingCapabilityDetection {
  const providerEfforts = findEffortValues(metadata);
  if (providerEfforts) {
    const thinkingLevelMap = mapEfforts(providerEfforts);
    if (thinkingLevelMap) {
      return { reasoning: true, thinkingLevelMap, source: "provider" };
    }
  }

  const normalizedId = modelId.trim().toLowerCase();
  if (/^grok[-_.]?4(?:[.-]?5)(?:$|[-_.])/.test(normalizedId)) {
    return {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      source: "profile",
    };
  }

  if (/reason|thinking|(^|[-_.])r1($|[-_.])/i.test(normalizedId)) {
    return { reasoning: true, source: "inferred" };
  }
  return { reasoning: false, source: "default" };
}
