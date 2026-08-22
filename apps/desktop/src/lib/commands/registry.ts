import type { MessageKey } from "../i18n";
import type { AppState } from "../stores/app-store";
import { useAppStore } from "../stores/app-store";
import { requestTreePanel } from "../dock-tree";
import {
  activateAdjacentExtensionDockTab,
  canMoveFocusedExtensionSlot,
  canResetFocusedExtensionFamily,
  focusAdjacentExtensionFloat,
  hasExtensionDockSplit,
  hasFocusedExtensionDockGroup,
  hasLiveExtensionFloats,
  moveFocusedExtensionDockGroup,
  moveFocusedExtensionSlot,
  resetFocusedExtensionFamily,
  resizeExtensionDockSplit,
} from "../extension-ui-commands";
import { abortCurrentAgent, createNewSession, isCreateSessionPending } from "./actions";
import {
  requestDockCommand,
  requestGlobalSearchOpen,
  requestShortcutHelp,
  requestSidebarToggle,
} from "./events";

export type AppCommand = {
  id: string;
  titleKey: MessageKey;
  titleParams?: Record<string, string | number>;
  chord?: string;
  worksInTerminal?: boolean;
  textInputSelector?: string;
  blockedByOverlay?: boolean;
  enabled?: (state: AppState) => boolean;
  run: () => void | Promise<unknown>;
};

const dockTabCommands: AppCommand[] = Array.from({ length: 9 }, (_, index) => ({
  id: `dock.activate.${index + 1}`,
  titleKey: "commandActivateDockTab",
  titleParams: { index: index + 1 },
  chord: `mod+${index + 1}`,
  run: () => requestDockCommand({ kind: "activate-visible", index }),
}));

export const appCommands: readonly AppCommand[] = [
  {
    id: "session.new",
    titleKey: "commandNewSession",
    chord: "mod+n",
    worksInTerminal: true,
    enabled: (state) =>
      Boolean(state.host && state.workspace?.servicesReady) && !isCreateSessionPending(),
    run: createNewSession,
  },
  {
    id: "app.openSettings",
    titleKey: "commandOpenSettings",
    chord: "mod+,",
    worksInTerminal: true,
    enabled: (state) => state.page === "chat" || !state.providersDirty,
    run: () => useAppStore.getState().openSettingsSection("general"),
  },
  {
    id: "sidebar.toggle",
    titleKey: "commandToggleSidebar",
    chord: "mod+b",
    worksInTerminal: true,
    run: requestSidebarToggle,
  },
  {
    id: "dock.toggle",
    titleKey: "commandToggleDock",
    chord: "mod+j",
    worksInTerminal: true,
    run: () => requestDockCommand({ kind: "toggle" }),
  },
  {
    id: "chat.tree",
    titleKey: "commandOpenTree",
    chord: "mod+t",
    run: requestTreePanel,
  },
  {
    id: "sessions.globalSearch",
    titleKey: "commandGlobalSearch",
    chord: "mod+f",
    worksInTerminal: true,
    enabled: (state) => Boolean(state.host),
    run: requestGlobalSearchOpen,
  },
  ...dockTabCommands,
  {
    id: "chat.stop",
    titleKey: "commandStopGeneration",
    chord: "escape",
    textInputSelector: ".chat-composer-input",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && state.session?.isIdle === false,
    run: abortCurrentAgent,
  },
  {
    id: "app.shortcuts",
    titleKey: "commandShowShortcuts",
    chord: "mod+/",
    worksInTerminal: true,
    run: requestShortcutHelp,
  },
  {
    id: "extension.float.next",
    titleKey: "commandExtensionFloatNext",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasLiveExtensionFloats(),
    run: () => {
      focusAdjacentExtensionFloat(1);
    },
  },
  {
    id: "extension.float.previous",
    titleKey: "commandExtensionFloatPrevious",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasLiveExtensionFloats(),
    run: () => {
      focusAdjacentExtensionFloat(-1);
    },
  },
  {
    id: "extension.slot.moveDock",
    titleKey: "commandExtensionMoveDock",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionSlot("dockPrimary"),
  },
  {
    id: "extension.slot.moveFloat",
    titleKey: "commandExtensionMoveFloat",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionSlot("float"),
  },
  {
    id: "extension.slot.moveAnchorAbove",
    titleKey: "commandExtensionMoveAnchorAbove",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionSlot("aboveComposer"),
  },
  {
    id: "extension.slot.moveAnchorBelow",
    titleKey: "commandExtensionMoveAnchorBelow",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionSlot("belowComposer"),
  },
  {
    id: "extension.dock.tabNext",
    titleKey: "commandExtensionDockTabNext",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasFocusedExtensionDockGroup(),
    run: () => {
      activateAdjacentExtensionDockTab(1);
    },
  },
  {
    id: "extension.dock.tabPrevious",
    titleKey: "commandExtensionDockTabPrevious",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasFocusedExtensionDockGroup(),
    run: () => {
      activateAdjacentExtensionDockTab(-1);
    },
  },
  {
    id: "extension.dock.moveSecondary",
    titleKey: "commandExtensionDockMoveSecondary",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionDockGroup("secondary"),
  },
  {
    id: "extension.dock.movePrimary",
    titleKey: "commandExtensionDockMovePrimary",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canMoveFocusedExtensionSlot(),
    run: () => moveFocusedExtensionDockGroup("primary"),
  },
  {
    id: "extension.dock.resizeLarger",
    titleKey: "commandExtensionDockResizeLarger",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasExtensionDockSplit(),
    run: () => resizeExtensionDockSplit(0.05),
  },
  {
    id: "extension.dock.resizeSmaller",
    titleKey: "commandExtensionDockResizeSmaller",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && hasExtensionDockSplit(),
    run: () => resizeExtensionDockSplit(-0.05),
  },
  {
    id: "extension.family.reset",
    titleKey: "commandExtensionResetFamily",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && canResetFocusedExtensionFamily(),
    run: () => resetFocusedExtensionFamily(),
  },
];
