import { useAppStore, type ExtensionTerminalState } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { latestSessionTargetContext } from "../../lib/bridge/host-context";
import { subscribeExtensionTerminal } from "../../lib/chat/extension-terminal-bus";
import { tCurrent, useT } from "../../lib/i18n/use-t";
import { XtermSurface } from "./XtermSurface";

/**
 * Use the freshest identity for the panel's session — the host migrates
 * pending panels across revision bumps, so a stale captured context would
 * fail request-owner matching even though the panel is still alive.
 */
function panelContext(panel: ExtensionTerminalState) {
  const s = useAppStore.getState();
  return latestSessionTargetContext(panel.context, s.host, s.workspace, s.session);
}

/**
 * Ask the live component to close through its virtual terminal. Escape is the
 * SDK panel convention (app.interrupt) and also matches tui.select.cancel, so
 * the component can run its own cancel path and return a real result. This
 * runs extension-owned cleanup callbacks (some extensions wrap ui.custom() in
 * another promise) without aborting the agent turn.
 */
export async function cancelExtensionTerminal(
  panel: ExtensionTerminalState,
): Promise<string | null> {
  try {
    const res = await hostClient.request("extensionUi.customInput", panelContext(panel), {
      requestId: panel.requestId,
      data: "\u001b",
    });
    return res.ok ? null : (res.error?.message ?? tCurrent("dockExtensionCloseFailed"));
  } catch (error) {
    return error instanceof Error ? error.message : tCurrent("dockExtensionCloseFailed");
  }
}

/**
 * Settle the ui.custom() request host-side when the panel ignores Escape.
 * The extension's promise resolves with undefined and the host teardown still
 * runs the component's dispose() cleanup; the agent turn is not aborted.
 */
export async function forceCloseExtensionTerminal(
  panel: ExtensionTerminalState,
): Promise<string | null> {
  try {
    const res = await hostClient.request("extensionUi.respond", panelContext(panel), {
      requestId: panel.requestId,
      status: "cancelled",
    });
    return res.ok ? null : (res.error?.message ?? tCurrent("dockExtensionCloseFailed"));
  } catch (error) {
    return error instanceof Error ? error.message : tCurrent("dockExtensionCloseFailed");
  }
}

const EXTENSION_TERMINAL_CLOSE_GRACE_MS = 1_500;
const extensionTerminalCloseRequests = new Map<string, Promise<string | null>>();

function isExtensionTerminalOpen(requestId: string): boolean {
  return useAppStore.getState().extensionTerminal?.requestId === requestId;
}

function waitForExtensionTerminalClose(requestId: string, timeoutMs: number): Promise<boolean> {
  if (!isExtensionTerminalOpen(requestId)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(closed);
    };
    unsubscribe = useAppStore.subscribe((state) => {
      if (state.extensionTerminal?.requestId !== requestId) finish(true);
    });
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);

    // Cover a close that raced with subscription setup.
    if (!isExtensionTerminalOpen(requestId)) finish(true);
  });
}

/**
 * Give the component a chance to handle Escape and run its own cleanup. If it
 * remains open, settle the host request so every custom-UI surface has the
 * same deterministic close behaviour.
 */
async function performExtensionTerminalClose(
  panel: ExtensionTerminalState,
  graceMs: number,
): Promise<string | null> {
  if (!isExtensionTerminalOpen(panel.requestId)) return null;

  const cancelError = await cancelExtensionTerminal(panel);
  if (!isExtensionTerminalOpen(panel.requestId)) return null;

  if (!cancelError && (await waitForExtensionTerminalClose(panel.requestId, graceMs))) {
    return null;
  }
  if (!isExtensionTerminalOpen(panel.requestId)) return null;

  const forceError = await forceCloseExtensionTerminal(panel);
  if (forceError) return forceError;

  useAppStore.getState().closeExtensionTerminal(panel.requestId);
  return null;
}

export function closeExtensionTerminalWithFallback(
  panel: ExtensionTerminalState,
  graceMs = EXTENSION_TERMINAL_CLOSE_GRACE_MS,
): Promise<string | null> {
  const existing = extensionTerminalCloseRequests.get(panel.requestId);
  if (existing) return existing;

  const closing = performExtensionTerminalClose(panel, graceMs).finally(() => {
    if (extensionTerminalCloseRequests.get(panel.requestId) === closing) {
      extensionTerminalCloseRequests.delete(panel.requestId);
    }
  });
  extensionTerminalCloseRequests.set(panel.requestId, closing);
  return closing;
}

export function ExtensionTerminal({ visible = true }: { visible?: boolean }) {
  const t = useT();
  const panel = useAppStore((s) => s.extensionTerminal);

  if (!panel) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
        {t("dockExtensionEmpty")}
      </div>
    );
  }
  return <TerminalView key={panel.requestId} panel={panel} visible={visible} />;
}

function TerminalView({ panel, visible }: { panel: ExtensionTerminalState; visible: boolean }) {
  return (
    <XtermSurface
      sessionKey={`extension:${panel.requestId}`}
      visible={visible}
      initialCols={panel.cols}
      initialRows={panel.rows}
      cursorBlink={false}
      connect={(term) => {
        const sendResize = (cols: number, rows: number) => {
          hostClient
            .request("extensionUi.customResize", panelContext(panel), {
              requestId: panel.requestId,
              cols,
              rows,
            })
            .catch(() => {});
        };
        const dataSub = term.onData((data) => {
          if (!data) return;
          hostClient
            .request("extensionUi.customInput", panelContext(panel), {
              requestId: panel.requestId,
              data,
            })
            .catch(() => {});
        });
        const resizeSub = term.onResize(({ cols, rows }) => sendResize(cols, rows));
        const unsubscribeFrames = subscribeExtensionTerminal(panel.requestId, (chunk) => {
          term.write(chunk);
        });

        if (term.cols !== panel.cols || term.rows !== panel.rows) {
          sendResize(term.cols, term.rows);
        }
        return () => {
          dataSub.dispose();
          resizeSub.dispose();
          unsubscribeFrames();
        };
      }}
    />
  );
}
