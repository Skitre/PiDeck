import { Folder, FolderPlus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

export function workspaceDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

/** Case-insensitive path identity on Windows; keeps first-seen casing. */
function samePath(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

export function addKnownWorkspace(list: string[], path: string): string[] {
  return list.some((entry) => samePath(entry, path)) ? list : [...list, path];
}

export function removeKnownWorkspace(list: string[], path: string): string[] {
  return list.filter((entry) => !samePath(entry, path));
}

// Stable fallback: a fresh [] per render makes the zustand selector loop.
const NO_WORKSPACES: string[] = [];

export function WorkspacePicker() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore(
    (s) => s.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES,
  );
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const setTrustOptions = useAppStore((s) => s.setTrustOptions);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  const currentCwd = workspace?.canonicalCwd ?? null;

  // Self-heal: whatever workspace is active (restored, picked, or set by the
  // host) always appears in the persistent list.
  useEffect(() => {
    if (!currentCwd) return;
    if (knownWorkspaces.some((entry) => samePath(entry, currentCwd))) return;
    void persistDesktopSettings({
      knownWorkspaces: addKnownWorkspace(knownWorkspaces, currentCwd),
    });
  }, [currentCwd, knownWorkspaces]);

  async function switchTo(cwd: string) {
    if (!host || pending) return;
    if (currentCwd && samePath(currentCwd, cwd)) return;

    const request = ++requestRef.current;
    const generation = captureRequestGeneration(host);
    const startedAt = performance.now();
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
      console.info(
        `[workspace] setCurrent ${cwd} took ${Math.round(performance.now() - startedAt)}ms ok=${res.ok}`,
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

  async function pickAndAdd() {
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
    await persistDesktopSettings({
      knownWorkspaces: addKnownWorkspace(knownWorkspaces, cwd),
    });
    await switchTo(cwd);
  }

  function removeFromList(path: string) {
    void persistDesktopSettings({
      knownWorkspaces: removeKnownWorkspace(knownWorkspaces, path),
    });
  }

  // Render the active workspace even before self-heal persists it.
  const listed = currentCwd
    ? addKnownWorkspace(knownWorkspaces, currentCwd)
    : knownWorkspaces;

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <span className="text-[11px] font-medium text-muted">Workspaces</span>
        <button
          type="button"
          onClick={() => void pickAndAdd()}
          disabled={!host || pending}
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          title="Add workspace"
          aria-label="Add workspace"
        >
          <Plus size={15} />
        </button>
      </div>
      {listed.length === 0 ? (
        <button
          type="button"
          onClick={() => void pickAndAdd()}
          disabled={!host || pending}
          className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
        >
          <FolderPlus size={16} />
          <span>{pending ? "Opening workspace..." : "Add workspace"}</span>
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {listed.map((path) => {
            const active = Boolean(currentCwd && samePath(currentCwd, path));
            return (
              <li
                key={path.toLocaleLowerCase()}
                className={`group flex h-9 items-center rounded-md text-sm ${
                  active
                    ? "bg-surface-overlay font-medium"
                    : "hover:bg-surface-overlay/70"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void switchTo(path)}
                  disabled={!host || pending || active}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                  title={`${workspaceDisplayName(path)}\n${path}`}
                  aria-current={active ? "true" : undefined}
                >
                  <Folder
                    size={16}
                    className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {workspaceDisplayName(path)}
                  </span>
                  {active && (
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        workspace?.servicesReady ? "bg-success" : "bg-warning"
                      }`}
                    />
                  )}
                </button>
                {!active && (
                  <button
                    type="button"
                    onClick={() => removeFromList(path)}
                    disabled={pending}
                    className="mr-1 hidden rounded p-1 text-muted hover:bg-surface hover:text-foreground group-hover:block"
                    title="Remove from list (folder is not deleted)"
                    aria-label={`Remove ${workspaceDisplayName(path)} from list`}
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
