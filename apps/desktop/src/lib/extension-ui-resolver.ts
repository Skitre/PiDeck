import {
  MAX_EXTENSION_UI_FLOATS,
  isPresentationHomeForFamily,
  type ExtensionSurfaceFamily,
  type ExtensionUiSettings,
  type NormalizedFloatRect,
  type PresentationHome,
} from "@pideck/protocol";

export type ExtensionPresentationHint = {
  placement?: "aboveEditor" | "belowEditor";
  overlay?: boolean;
};

export type ResolvedPresentation = {
  home: PresentationHome;
  source: "profile" | "hint" | "default";
};

export const DEFAULT_CUSTOM_FLOAT_RECT: NormalizedFloatRect = {
  x: 0.22,
  y: 0.16,
  width: 640,
  height: 420,
};

export function defaultHomeForFamily(
  family: ExtensionSurfaceFamily,
  hint?: ExtensionPresentationHint,
): PresentationHome {
  switch (family) {
    case "widget":
      return {
        kind: "anchor",
        slot: hint?.placement === "belowEditor" ? "belowComposer" : "aboveComposer",
      };
    case "status":
      return { kind: "anchor", slot: "aboveComposer" };
    case "custom":
      return hint?.overlay === true
        ? { kind: "float", rect: { ...DEFAULT_CUSTOM_FLOAT_RECT } }
        : { kind: "dock", group: "primary", order: 0 };
    case "blockingDialog":
      return { kind: "followHost" };
  }
}

function savedPresentationHome(
  settings: ExtensionUiSettings,
  extensionId: string | undefined,
  family: ExtensionSurfaceFamily,
): PresentationHome | undefined {
  if (!extensionId) return undefined;
  const home = settings.presentations[extensionId]?.[family]?.home;
  return home && isPresentationHomeForFamily(family, home) ? home : undefined;
}

export function applyLiveFloatCap(
  home: PresentationHome,
  otherLiveFloatCount: number,
): PresentationHome {
  if (home.kind !== "float" || otherLiveFloatCount < MAX_EXTENSION_UI_FLOATS) return home;
  return { kind: "dock", group: "primary", order: 0 };
}

/**
 * Pure Desktop resolver for widget / status / custom. Blocking dialogs do not
 * use this path — Host publishes the final presentation.
 *
 * Precedence: legal saved profile → Extension/Host hint when the profile is
 * absent or `followExtension` → family default. Illegal/corrupt profiles fall
 * through. The live Float cap is applied by the caller with `otherLiveFloatCount`.
 */
export function resolveExtensionPresentation(input: {
  family: ExtensionSurfaceFamily;
  settings: ExtensionUiSettings;
  extensionId?: string;
  hint?: ExtensionPresentationHint;
  otherLiveFloatCount?: number;
}): ResolvedPresentation {
  const saved = savedPresentationHome(input.settings, input.extensionId, input.family);
  let source: ResolvedPresentation["source"] = "default";
  let home: PresentationHome;

  if (saved && saved.kind !== "followExtension") {
    home = saved;
    source = "profile";
  } else {
    home = defaultHomeForFamily(input.family, input.hint);
    source =
      saved?.kind === "followExtension" || hasHint(input.family, input.hint) ? "hint" : "default";
  }

  return {
    home: applyLiveFloatCap(home, input.otherLiveFloatCount ?? 0),
    source,
  };
}

function hasHint(family: ExtensionSurfaceFamily, hint?: ExtensionPresentationHint): boolean {
  if (!hint) return false;
  if (family === "widget") return hint.placement !== undefined;
  if (family === "custom") return hint.overlay === true;
  return false;
}
