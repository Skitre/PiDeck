import type { ExtensionSurfaceFamily, PresentationHome } from "@pideck/protocol";
import type { MessageKey } from "./i18n";

export function extensionUiHomeMessageKey(home: PresentationHome): MessageKey {
  switch (home.kind) {
    case "dock":
      return "extensionUiMovedToDock";
    case "float":
      return "extensionUiMovedToFloat";
    case "hidden":
      return "extensionUiMovedToHidden";
    case "anchor":
      return home.slot === "belowComposer"
        ? "extensionUiMovedToAnchorBelow"
        : "extensionUiMovedToAnchorAbove";
    default:
      return "extensionUiChangedHome";
  }
}

export function extensionUiFamilyMessageKey(family: ExtensionSurfaceFamily): MessageKey {
  switch (family) {
    case "widget":
      return "extensionUiFamilyWidget";
    case "status":
      return "extensionUiFamilyStatus";
    case "custom":
      return "extensionUiFamilyCustom";
    case "blockingDialog":
      return "extensionUiFamilyBlocking";
  }
}
