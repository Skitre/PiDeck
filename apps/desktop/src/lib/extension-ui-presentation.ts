import {
  MAX_EXTENSION_UI_DOCK_ORDER,
  type DockGroupId,
  type ExtensionSurfaceFamily,
  type ExtensionUiSettings,
  type PresentationHome,
} from "@pideck/protocol";

const DEFAULT_FLOAT_RECT = {
  x: 0.62,
  y: 0.08,
  width: 360,
  height: 240,
} as const;

export type ExtensionUiPresentationChoice =
  | "followExtension"
  | "followHost"
  | "aboveComposer"
  | "belowComposer"
  | "dockPrimary"
  | "dockSecondary"
  | "float"
  | "hidden"
  | "inline"
  | "modal";

export const FAMILY_PRESENTATION_CHOICES: Record<
  ExtensionSurfaceFamily,
  readonly ExtensionUiPresentationChoice[]
> = {
  widget: [
    "followExtension",
    "aboveComposer",
    "belowComposer",
    "dockPrimary",
    "dockSecondary",
    "float",
    "hidden",
  ],
  status: ["aboveComposer", "dockPrimary", "dockSecondary", "hidden"],
  custom: ["followExtension", "dockPrimary", "dockSecondary", "float"],
  blockingDialog: ["followHost", "inline", "modal"],
};

function defaultPresentationChoice(family: ExtensionSurfaceFamily): ExtensionUiPresentationChoice {
  switch (family) {
    case "widget":
    case "custom":
      return "followExtension";
    case "status":
      return "aboveComposer";
    case "blockingDialog":
      return "followHost";
  }
}

export function presentationChoiceFromHome(
  family: ExtensionSurfaceFamily,
  home: PresentationHome | undefined,
): ExtensionUiPresentationChoice {
  if (!home) return defaultPresentationChoice(family);
  switch (home.kind) {
    case "followExtension":
    case "followHost":
    case "float":
    case "hidden":
    case "inline":
    case "modal":
      return home.kind;
    case "anchor":
      return home.slot === "belowComposer" ? "belowComposer" : "aboveComposer";
    case "dock":
      return home.group === "secondary" ? "dockSecondary" : "dockPrimary";
    default:
      return defaultPresentationChoice(family);
  }
}

function nextDockOrder(settings: ExtensionUiSettings, group: DockGroupId): number {
  let max = -1;
  for (const profile of Object.values(settings.presentations)) {
    for (const preference of Object.values(profile)) {
      const home = preference?.home;
      if (home?.kind === "dock" && home.group === group) {
        max = Math.max(max, home.order);
      }
    }
  }
  return Math.min(MAX_EXTENSION_UI_DOCK_ORDER, max + 1);
}

export function presentationHomeFromChoice(
  family: ExtensionSurfaceFamily,
  choice: ExtensionUiPresentationChoice,
  settings: ExtensionUiSettings,
  current?: PresentationHome,
): PresentationHome {
  switch (choice) {
    case "followExtension":
      return { kind: "followExtension" };
    case "followHost":
      return { kind: "followHost" };
    case "aboveComposer":
      return { kind: "anchor", slot: "aboveComposer" };
    case "belowComposer":
      return { kind: "anchor", slot: "belowComposer" };
    case "dockPrimary":
    case "dockSecondary": {
      const group: DockGroupId = choice === "dockSecondary" ? "secondary" : "primary";
      const order =
        current?.kind === "dock" && current.group === group
          ? current.order
          : nextDockOrder(settings, group);
      return { kind: "dock", group, order };
    }
    case "float":
      return {
        kind: "float",
        rect: current?.kind === "float" ? current.rect : { ...DEFAULT_FLOAT_RECT },
        ...(current?.kind === "float" && current.pinned !== undefined
          ? { pinned: current.pinned }
          : {}),
      };
    case "hidden":
      return { kind: "hidden" };
    case "inline":
      return { kind: "inline" };
    case "modal":
      return { kind: "modal" };
  }
}

export function isLegalPresentationChoice(
  family: ExtensionSurfaceFamily,
  choice: string,
): choice is ExtensionUiPresentationChoice {
  return (FAMILY_PRESENTATION_CHOICES[family] as readonly string[]).includes(choice);
}
