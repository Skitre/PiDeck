import { Maximize2, Minus, Square, X, type LucideIcon } from "lucide-react";

export type WindowControlsPlatform = "macos" | "windows";

/** Overlay Windows caption buttons are 3 × 44px; keep a little slack. */
export const WINDOWS_CAPTION_INSET_CLASS = "pr-[140px]";

export function shouldRenderWindowControls(
  platform: WindowControlsPlatform,
  settingsOverlayOpen: boolean,
): boolean {
  return platform !== "macos" || !settingsOverlayOpen;
}

export function resolveWindowControlsPlatform(
  tauriPlatform = import.meta.env.TAURI_ENV_PLATFORM,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): WindowControlsPlatform {
  const platform = tauriPlatform?.toLowerCase();
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform) return "windows";
  return /\bMac(?:intosh|Intel|PPC)?\b/i.test(userAgent) ? "macos" : "windows";
}

type WindowAction = "minimize" | "toggleMaximize" | "close";

async function windowAction(action: WindowAction) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (action === "minimize") await win.minimize();
    else if (action === "toggleMaximize") await win.toggleMaximize();
    else await win.close();
  } catch {
    /* browser dev mode — no window API */
  }
}

const MACOS_CONTROLS: Array<{
  action: WindowAction;
  label: string;
  title: string;
  tone: "close" | "minimize" | "maximize";
  Icon: LucideIcon;
}> = [
  { action: "close", label: "Close window", title: "Close", tone: "close", Icon: X },
  {
    action: "minimize",
    label: "Minimize window",
    title: "Minimize",
    tone: "minimize",
    Icon: Minus,
  },
  {
    action: "toggleMaximize",
    label: "Maximize or restore window",
    title: "Maximize / restore",
    tone: "maximize",
    Icon: Maximize2,
  },
];

function MacOSWindowControls() {
  return (
    <div
      role="group"
      aria-label="Window controls"
      data-window-controls-platform="macos"
      className="mac-window-controls absolute left-1.5 top-1.5 z-50 flex shrink-0 items-center"
    >
      {MACOS_CONTROLS.map(({ action, label, title, tone, Icon }) => (
        <button
          key={action}
          type="button"
          title={title}
          aria-label={label}
          data-window-action={action}
          className="mac-window-control flex size-5 items-center justify-center rounded-full border-0 bg-transparent p-0"
          onClick={() => void windowAction(action)}
        >
          <span className={`mac-window-control-dot mac-window-control-dot--${tone}`}>
            <Icon className="mac-window-control-icon" aria-hidden="true" strokeWidth={3} />
          </span>
        </button>
      ))}
    </div>
  );
}

function WindowsWindowControls() {
  return (
    <div
      role="group"
      aria-label="Window controls"
      data-window-controls-platform="windows"
      className="absolute right-0 top-0 z-50 flex shrink-0 items-center"
    >
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        data-window-action="minimize"
        className="flex h-[var(--theme-toolbar-height)] w-11 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={() => void windowAction("minimize")}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        title="Maximize / restore"
        aria-label="Maximize or restore window"
        data-window-action="toggleMaximize"
        className="flex h-[var(--theme-toolbar-height)] w-11 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={() => void windowAction("toggleMaximize")}
      >
        <Square size={11} />
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close window"
        data-window-action="close"
        className="flex h-[var(--theme-toolbar-height)] w-11 items-center justify-center text-muted transition-colors hover:bg-danger hover:text-white"
        onClick={() => void windowAction("close")}
      >
        <X size={15} />
      </button>
    </div>
  );
}

/** Platform-native visual conventions over the shared frameless-window actions. */
export function WindowControls({
  platform = resolveWindowControlsPlatform(),
}: {
  platform?: WindowControlsPlatform;
}) {
  return platform === "macos" ? <MacOSWindowControls /> : <WindowsWindowControls />;
}
