import { Minus, Square, X } from "lucide-react";

async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
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

/** Frameless-window controls; lives at the top-right of the chat header. */
export function WindowControls() {
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={() => void windowAction("minimize")}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        title="Maximize / restore"
        aria-label="Maximize or restore window"
        className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={() => void windowAction("toggleMaximize")}
      >
        <Square size={11} />
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close window"
        className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-danger hover:text-white"
        onClick={() => void windowAction("close")}
      >
        <X size={15} />
      </button>
    </div>
  );
}
