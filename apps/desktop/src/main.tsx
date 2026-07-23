import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RotateCw } from "lucide-react";
import { App } from "./app/App";
import "streamdown/styles.css";
import "katex/dist/katex.min.css";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

type AppErrorBoundaryState = { error: Error | null };

const LAST_UI_ERROR_KEY = "pideck.lastUiError";

function reloadUi(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("pideck-reload", Date.now().toString());
  window.location.replace(url);
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("PiDeck UI render failed", error, info.componentStack);
    try {
      window.localStorage.setItem(
        LAST_UI_ERROR_KEY,
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
          capturedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // Diagnostics must never obscure the original render failure.
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-surface px-6 text-foreground">
        <div className="w-full max-w-md rounded-lg border border-danger/40 bg-danger/10 p-5">
          <h1 className="text-base font-semibold text-danger">PiDeck UI failed to render</h1>
          <p className="mt-2 text-sm text-muted">
            The session data is still safe. Reload the UI to reconnect to the current Host.
          </p>
          <p className="mt-3 break-words rounded-md bg-surface-overlay px-3 py-2 font-mono text-xs text-danger">
            {this.state.error.name}: {this.state.error.message}
          </p>
          <button
            type="button"
            className="mt-4 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm hover:bg-surface-overlay"
            onClick={reloadUi}
          >
            <RotateCw className="mr-2 inline size-3.5" aria-hidden="true" />
            Reload UI
          </button>
        </div>
      </div>
    );
  }
}

try {
  window.localStorage.removeItem(LAST_UI_ERROR_KEY);
} catch {
  // Local storage can be unavailable in hardened WebViews.
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
