import type { HostTransport } from "./host-client";

/**
 * Tauri IPC transport. Falls back to a mock for browser-only Vite dev
 * when Tauri APIs are unavailable.
 */
export async function createTauriTransport(): Promise<HostTransport> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    const handlers = new Set<(line: string) => void>();

    const unlistenStdout = await listen<string>("pi-host-stdout", (event) => {
      for (const h of handlers) h(event.payload);
    });

    const unlistenStderr = await listen<string>("pi-host-stderr", (event) => {
      console.debug("[pi-host]", event.payload);
    });

    return {
      send: async (line: string) => {
        await invoke("pi_host_send", { line });
      },
      onMessage: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      dispose: () => {
        handlers.clear();
        unlistenStdout();
        unlistenStderr();
      },
    };
  } catch {
    // Browser fallback — no real host
    return createMockTransport();
  }
}

function createMockTransport(): HostTransport {
  const handlers = new Set<(line: string) => void>();
  return {
    send: async (line: string) => {
      try {
        const req = JSON.parse(line);
        if (req.method === "system.hello") {
          const response = {
            protocolVersion: 1,
            hostInstanceId: "browser-mock",
            workspaceId: null,
            workspaceRevision: 0,
            sessionId: null,
            sessionRevision: 0,
            packageRevision: 0,
            id: req.id,
            method: "system.hello",
            ok: true,
            result: {
              protocolVersion: 1,
              hostInstanceId: "browser-mock",
              workspaceId: null,
              workspaceRevision: 0,
              sessionId: null,
              sessionRevision: 0,
              packageRevision: 0,
              sdkVersion: "0.80.7",
              nodeVersion: "browser",
              agentDir: "(mock)",
              phase: "waitingForWorkspace",
              capabilities: {
                packageUpdateCheck: false,
                extensionUi: true,
                projectTrust: true,
                sessionExport: false,
              },
              modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
            },
          };
          queueMicrotask(() => {
            for (const h of handlers) h(JSON.stringify(response));
          });
        }
      } catch {
        /* ignore */
      }
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
