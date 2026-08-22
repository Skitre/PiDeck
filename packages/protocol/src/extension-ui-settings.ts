import {
  MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH,
  MAX_EXTENSION_UI_DOCK_ORDER,
  MAX_EXTENSION_UI_DOCK_SIZE,
  MAX_EXTENSION_UI_EXTENSION_ID_LENGTH,
  MAX_EXTENSION_UI_IDENTITIES,
  MAX_EXTENSION_UI_SETTINGS_BYTES,
  MIN_EXTENSION_UI_DOCK_SIZE,
} from "./limits.js";
import type {
  DockGroupId,
  ExtensionDialogPresentationOverrides,
  ExtensionDialogPresentationPreference,
  ExtensionDockSettings,
  ExtensionPresentationProfile,
  ExtensionSurfaceFamily,
  ExtensionUiOrigin,
  ExtensionUiSettings,
  ObservedExtensionUiCapabilities,
  PresentationHome,
  PresentationPreference,
} from "./types.js";
import { EXTENSION_SURFACE_FAMILIES } from "./types.js";

export const EXTENSION_DIALOG_PRESENTATION_PREFERENCES = [
  "followHost",
  "inline",
  "modal",
] as const satisfies readonly ExtensionDialogPresentationPreference[];

export const DEFAULT_EXTENSION_DOCK_SETTINGS: ExtensionDockSettings = {
  direction: "row",
  secondaryEnabled: false,
};

export const DEFAULT_EXTENSION_UI_SETTINGS: ExtensionUiSettings = {
  version: 1,
  presentations: {},
  dock: { ...DEFAULT_EXTENSION_DOCK_SETTINGS },
  observedCapabilities: {},
};

const LEGAL_HOMES_BY_FAMILY: Record<
  ExtensionSurfaceFamily,
  ReadonlySet<PresentationHome["kind"]>
> = {
  widget: new Set(["followExtension", "anchor", "dock", "float", "hidden"]),
  status: new Set(["anchor", "dock", "hidden"]),
  custom: new Set(["followExtension", "dock", "float"]),
  blockingDialog: new Set(["followHost", "inline", "modal"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function isExtensionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EXTENSION_UI_EXTENSION_ID_LENGTH
  );
}

export function isTrustedExtensionUiOrigin(
  origin: ExtensionUiOrigin | undefined,
): origin is Exclude<ExtensionUiOrigin, { invocationKind: "unknown" }> {
  return origin !== undefined && origin.invocationKind !== "unknown";
}

export function trustedExtensionId(origin: ExtensionUiOrigin | undefined): string | undefined {
  return isTrustedExtensionUiOrigin(origin) ? origin.extensionId : undefined;
}

export function isExtensionDialogPresentationPreference(
  value: unknown,
): value is ExtensionDialogPresentationPreference {
  return (
    typeof value === "string" &&
    (EXTENSION_DIALOG_PRESENTATION_PREFERENCES as readonly string[]).includes(value)
  );
}

export function isExtensionDialogPresentationOverrides(
  value: unknown,
): value is ExtensionDialogPresentationOverrides {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_EXTENSION_UI_IDENTITIES) return false;
  if (utf8JsonBytes(value) > MAX_EXTENSION_UI_SETTINGS_BYTES) return false;
  return keys.every(
    (key) => isExtensionId(key) && isExtensionDialogPresentationPreference(value[key]),
  );
}

function isDockGroupId(value: unknown): value is DockGroupId {
  return value === "primary" || value === "secondary";
}

function isNormalizedFloatRect(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ["x", "y", "width", "height"])) return false;
  return (
    isFiniteNumber(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    isFiniteNumber(value.y) &&
    value.y >= 0 &&
    value.y <= 1 &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0
  );
}

export function legalPresentationHomeKinds(
  family: ExtensionSurfaceFamily,
): ReadonlyArray<PresentationHome["kind"]> {
  return [...LEGAL_HOMES_BY_FAMILY[family]];
}

export function isPresentationHomeForFamily(
  family: ExtensionSurfaceFamily,
  value: unknown,
): value is PresentationHome {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (!LEGAL_HOMES_BY_FAMILY[family].has(value.kind as PresentationHome["kind"])) return false;
  switch (value.kind) {
    case "followExtension":
    case "followHost":
    case "inline":
    case "modal":
    case "hidden":
      return hasExactKeys(value, ["kind"]);
    case "anchor":
      return (
        hasExactKeys(value, ["kind", "slot"]) &&
        (family === "status"
          ? value.slot === "aboveComposer"
          : value.slot === "aboveComposer" || value.slot === "belowComposer")
      );
    case "dock":
      return (
        hasExactKeys(value, ["kind", "group", "order"]) &&
        isDockGroupId(value.group) &&
        isSafeInteger(value.order) &&
        value.order <= MAX_EXTENSION_UI_DOCK_ORDER
      );
    case "float":
      return (
        hasExactKeys(value, ["kind", "rect"], ["pinned"]) &&
        isNormalizedFloatRect(value.rect) &&
        (value.pinned === undefined || typeof value.pinned === "boolean")
      );
    default:
      return false;
  }
}

function isPresentationPreference(
  family: ExtensionSurfaceFamily,
  value: unknown,
): value is PresentationPreference {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["home"]) &&
    isPresentationHomeForFamily(family, value.home)
  );
}

function isExtensionPresentationProfile(value: unknown): value is ExtensionPresentationProfile {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(
    ([family, preference]) =>
      (EXTENSION_SURFACE_FAMILIES as readonly string[]).includes(family) &&
      isPresentationPreference(family as ExtensionSurfaceFamily, preference),
  );
}

function isDockSizes(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [first, second] = value;
  if (
    !isFiniteNumber(first) ||
    !isFiniteNumber(second) ||
    first < MIN_EXTENSION_UI_DOCK_SIZE ||
    first > MAX_EXTENSION_UI_DOCK_SIZE ||
    second < MIN_EXTENSION_UI_DOCK_SIZE ||
    second > MAX_EXTENSION_UI_DOCK_SIZE
  ) {
    return false;
  }
  return Math.abs(first + second - 1) < 1e-9;
}

function isExtensionDockSettings(value: unknown): value is ExtensionDockSettings {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["direction", "secondaryEnabled"], ["sizes"]) &&
    (value.direction === "row" || value.direction === "column") &&
    typeof value.secondaryEnabled === "boolean" &&
    (value.sizes === undefined || isDockSizes(value.sizes))
  );
}

function isObservedFamilies(value: unknown): value is ExtensionSurfaceFamily[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > EXTENSION_SURFACE_FAMILIES.length
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const family of value) {
    if (
      typeof family !== "string" ||
      !(EXTENSION_SURFACE_FAMILIES as readonly string[]).includes(family) ||
      seen.has(family)
    ) {
      return false;
    }
    seen.add(family);
  }
  return true;
}

function isObservedExtensionUiCapabilities(
  value: unknown,
): value is ObservedExtensionUiCapabilities {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_EXTENSION_UI_IDENTITIES) return false;
  return keys.every((key) => {
    const entry = value[key];
    return (
      isExtensionId(key) &&
      isPlainObject(entry) &&
      hasExactKeys(entry, ["families", "lastSeenAt"], ["displayName"]) &&
      isObservedFamilies(entry.families) &&
      isSafeInteger(entry.lastSeenAt) &&
      (entry.displayName === undefined ||
        sanitizeExtensionDisplayName(entry.displayName) !== undefined)
    );
  });
}

function identityCount(settings: {
  presentations: Record<string, unknown>;
  observedCapabilities: Record<string, unknown>;
}): number {
  return new Set([
    ...Object.keys(settings.presentations),
    ...Object.keys(settings.observedCapabilities),
  ]).size;
}

export function isExtensionUiSettings(value: unknown): value is ExtensionUiSettings {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["version", "presentations", "dock", "observedCapabilities"]) ||
    value.version !== 1 ||
    !isExtensionDockSettings(value.dock)
  ) {
    return false;
  }
  const presentations = value.presentations;
  const observedCapabilities = value.observedCapabilities;
  if (!isPlainObject(presentations) || !isObservedExtensionUiCapabilities(observedCapabilities)) {
    return false;
  }
  const presentationKeys = Object.keys(presentations);
  if (presentationKeys.length > MAX_EXTENSION_UI_IDENTITIES) return false;
  if (
    !presentationKeys.every(
      (key) => isExtensionId(key) && isExtensionPresentationProfile(presentations[key]),
    )
  ) {
    return false;
  }
  if (identityCount({ presentations, observedCapabilities }) > MAX_EXTENSION_UI_IDENTITIES) {
    return false;
  }
  return utf8JsonBytes(value) <= MAX_EXTENSION_UI_SETTINGS_BYTES;
}

function sanitizePresentationHome(
  family: ExtensionSurfaceFamily,
  value: unknown,
): PresentationHome | undefined {
  return isPresentationHomeForFamily(family, value) ? value : undefined;
}

function sanitizeProfile(value: unknown): ExtensionPresentationProfile | undefined {
  if (!isPlainObject(value)) return undefined;
  const profile: ExtensionPresentationProfile = {};
  for (const family of EXTENSION_SURFACE_FAMILIES) {
    const entry = value[family];
    if (!isPlainObject(entry) || !("home" in entry)) continue;
    const home = sanitizePresentationHome(family, entry.home);
    if (home) profile[family] = { home };
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

export function sanitizeExtensionDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH) return undefined;
  return name;
}

function sanitizeObservedEntry(
  value: unknown,
): ObservedExtensionUiCapabilities[string] | undefined {
  if (!isPlainObject(value)) return undefined;
  const families = Array.isArray(value.families)
    ? [...new Set(value.families)].filter((family): family is ExtensionSurfaceFamily =>
        (EXTENSION_SURFACE_FAMILIES as readonly string[]).includes(String(family)),
      )
    : [];
  if (families.length === 0 || !isSafeInteger(value.lastSeenAt)) return undefined;
  const displayName = sanitizeExtensionDisplayName(value.displayName);
  return {
    families,
    lastSeenAt: value.lastSeenAt,
    ...(displayName ? { displayName } : {}),
  };
}

function normalizeDockSizes(sizes: unknown): [number, number] | undefined {
  if (isDockSizes(sizes)) return sizes;
  if (!Array.isArray(sizes) || sizes.length !== 2) return undefined;
  const first = Number(sizes[0]);
  const second = Number(sizes[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined;
  const total = first + second;
  if (total <= 0) return undefined;
  const normalized: [number, number] = [first / total, second / total];
  const clamped: [number, number] = [
    Math.min(MAX_EXTENSION_UI_DOCK_SIZE, Math.max(MIN_EXTENSION_UI_DOCK_SIZE, normalized[0])),
    0,
  ];
  clamped[1] = 1 - clamped[0];
  if (clamped[1] < MIN_EXTENSION_UI_DOCK_SIZE || clamped[1] > MAX_EXTENSION_UI_DOCK_SIZE) {
    return undefined;
  }
  return clamped;
}

function sanitizeDock(value: unknown): ExtensionDockSettings {
  if (!isPlainObject(value)) return { ...DEFAULT_EXTENSION_DOCK_SETTINGS };
  const sizes = normalizeDockSizes(value.sizes);
  return {
    direction: value.direction === "column" ? "column" : "row",
    secondaryEnabled: value.secondaryEnabled === true,
    ...(sizes ? { sizes } : {}),
  };
}

export function sanitizeExtensionUiSettings(value: unknown): ExtensionUiSettings {
  if (!isPlainObject(value) || value.version !== 1) {
    return {
      version: 1,
      presentations: {},
      dock: { ...DEFAULT_EXTENSION_DOCK_SETTINGS },
      observedCapabilities: {},
    };
  }
  const presentations: Record<string, ExtensionPresentationProfile> = {};
  const observedCapabilities: ObservedExtensionUiCapabilities = {};
  if (isPlainObject(value.presentations)) {
    for (const [id, profile] of Object.entries(value.presentations)) {
      if (!isExtensionId(id)) continue;
      const sanitized = sanitizeProfile(profile);
      if (sanitized) presentations[id] = sanitized;
    }
  }
  if (isPlainObject(value.observedCapabilities)) {
    for (const [id, entry] of Object.entries(value.observedCapabilities)) {
      if (!isExtensionId(id)) continue;
      const sanitized = sanitizeObservedEntry(entry);
      if (sanitized) observedCapabilities[id] = sanitized;
    }
  }
  const identities = [
    ...new Set([...Object.keys(presentations), ...Object.keys(observedCapabilities)]),
  ]
    .sort((left, right) => {
      const leftSeen = observedCapabilities[left]?.lastSeenAt ?? 0;
      const rightSeen = observedCapabilities[right]?.lastSeenAt ?? 0;
      return rightSeen - leftSeen || left.localeCompare(right);
    })
    .slice(0, MAX_EXTENSION_UI_IDENTITIES);
  const allowed = new Set(identities);
  for (const id of Object.keys(presentations)) {
    if (!allowed.has(id)) delete presentations[id];
  }
  for (const id of Object.keys(observedCapabilities)) {
    if (!allowed.has(id)) delete observedCapabilities[id];
  }
  const settings: ExtensionUiSettings = {
    version: 1,
    presentations,
    dock: sanitizeDock(value.dock),
    observedCapabilities,
  };
  if (utf8JsonBytes(settings) > MAX_EXTENSION_UI_SETTINGS_BYTES) {
    return {
      version: 1,
      presentations: {},
      dock: settings.dock,
      observedCapabilities: {},
    };
  }
  return settings;
}

export function projectExtensionDialogPresentationOverrides(
  settings: ExtensionUiSettings,
): ExtensionDialogPresentationOverrides {
  const overrides: ExtensionDialogPresentationOverrides = {};
  for (const [extensionId, profile] of Object.entries(settings.presentations)) {
    const home = profile.blockingDialog?.home;
    if (!home) continue;
    if (home.kind === "followHost" || home.kind === "inline" || home.kind === "modal") {
      overrides[extensionId] = home.kind;
    }
  }
  return overrides;
}
