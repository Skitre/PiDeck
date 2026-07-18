import { Folder, FolderPlus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

export function workspaceDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

export function WorkspacePicker() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const setTrustOptions = useAppStore((s) => s.setTrustOptions);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  async function pickAndSet() {
    if (!host || pending) return;
    let cwd: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") cwd = selected;
    } catch {
      cwd = window.prompt("Enter workspace path") || null;
    }
    if (!cwd) return;

    const request = ++requestRef.current;
    const generation = captureRequestGeneration(host);
    setPending(true);
    try {
      const res = await hostClient.request(
        "workspace.setCurrent",
        {
          expectedHostInstanceId: host.hostInstanceId,
          expectedWorkspaceId: host.workspaceId,
          expectedWorkspaceRevision: host.workspaceRevision,
        },
        { cwd },
        60_000,
      );

      if (
        request !== requestRef.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation)
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Failed to set workspace", "error");
        return;
      }

      const result = res.result;
      setWorkspace(result.workspace);
      if (result.session) setSession(result.session);
      if (result.trustOptions) setTrustOptions(result.trustOptions);
      useAppStore.getState().setHost({
        ...host,
        workspaceId: res.workspaceId,
        workspaceRevision: res.workspaceRevision,
        sessionId: res.sessionId,
        sessionRevision: res.sessionRevision,
        packageRevision: res.packageRevision,
      });
    } finally {
      if (request === requestRef.current) setPending(false);
    }
  }

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <span className="text-[11px] font-medium text-muted">Workspaces</span>
        <button
          type="button"
          onClick={() => void pickAndSet()}
          disabled={!host || pending}
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          title="Add workspace"
          aria-label="Add workspace"
        >
          <Plus size={15} />
        </button>
      </div>
      {workspace ? (
        <div
          className="flex h-9 w-full items-center gap-2 rounded-md bg-surface-overlay px-2.5 text-left text-sm font-medium"
          title={`${workspaceDisplayName(workspace.canonicalCwd)}\n${workspace.canonicalCwd}`}
          aria-current="true"
        >
          <Folder size={16} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {workspaceDisplayName(workspace.canonicalCwd)}
          </span>
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              workspace.servicesReady ? "bg-success" : "bg-warning"
            }`}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void pickAndSet()}
          disabled={!host || pending}
          className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
        >
          <FolderPlus size={16} />
          <span>{pending ? "Opening workspace..." : "Add workspace"}</span>
        </button>
      )}
    </section>
  );
}
