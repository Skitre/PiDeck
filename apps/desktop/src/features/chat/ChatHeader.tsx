import { PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  WINDOWS_CAPTION_INSET_CLASS,
  resolveWindowControlsPlatform,
} from "../../components/WindowControls";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { requestDockCommand } from "../../lib/commands/events";
import { formatCommandChord } from "../../lib/commands/keymap";
import { appCommands } from "../../lib/commands/registry";
import { resolveCommandChord } from "../../lib/commands/shortcut-bindings";

const DOCK_TOGGLE_COMMAND = appCommands.find((command) => command.id === "dock.toggle")!;

export function ChatHeader() {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const dockOpen = useAppStore((s) => s.dockOpen);
  const shortcutOverrides = useAppStore((s) => s.desktopSettings?.shortcutOverrides);
  const dockToggleChord = resolveCommandChord(DOCK_TOGGLE_COMMAND, shortcutOverrides);
  const dockToggleShortcut = dockToggleChord
    ? formatCommandChord(dockToggleChord, resolveWindowControlsPlatform() === "macos")
    : null;
  const dockToggleLabel = dockOpen ? t("dockCollapsePanel") : t("dockOpenPanel");
  const sessionName = session?.name?.trim() || t("chatNewConversation");
  const runtimeLabel = session?.isStreaming
    ? t("chatStatusStreaming")
    : session?.isCompacting
      ? t("chatStatusCompacting")
      : session?.isRetrying
        ? t("chatStatusRetrying")
        : session?.isIdle
          ? t("chatStatusReady")
          : t("chatStatusWorking");

  return (
    <div
      className={`flex h-11 shrink-0 items-center gap-4 pl-5 transition-[padding-right] duration-200 ease-out ${
        dockOpen ? "pr-2" : WINDOWS_CAPTION_INSET_CLASS
      }`}
      data-chat-header
      data-dock-open={dockOpen ? "true" : "false"}
      data-tauri-drag-region
    >
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-end gap-2">
          <h1 className="truncate text-base font-semibold" title={sessionName}>
            {sessionName}
          </h1>
          <span
            className="mb-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
            data-chat-status
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                session?.isStreaming || (session && !session.isIdle) ? "bg-success" : "bg-muted"
              }`}
              title={session ? runtimeLabel : t("chatNoActiveSession")}
            />
            <span>{session ? runtimeLabel : t("chatNoActiveSession")}</span>
          </span>
        </div>
      </div>
      <button
        type="button"
        title={dockToggleShortcut ? `${dockToggleLabel} (${dockToggleShortcut})` : dockToggleLabel}
        aria-label={dockOpen ? t("dockCollapseRightPanel") : t("dockOpenRightPanel")}
        aria-expanded={dockOpen}
        aria-controls="right-dock"
        data-dock-toolbar-toggle
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
        onClick={() => requestDockCommand({ kind: "toggle" })}
      >
        {dockOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      </button>
    </div>
  );
}
