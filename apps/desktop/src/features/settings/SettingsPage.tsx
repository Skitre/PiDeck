import { useEffect, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { applyTheme } from "../../lib/theme";
import { hostClient } from "../../lib/bridge/host-client";
import { mergeHostIdentity, workspaceContext } from "../../lib/bridge/host-context";
import { ArrowLeft, KeyRound, Package, Settings2 } from "lucide-react";
import { ProvidersSettings } from "./ProvidersSettings";
import { PackagesPage } from "../packages/PackagesPage";

function GeneralSettings() {
  const host = useAppStore((s) => s.host);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const setDesktopSettings = useAppStore((s) => s.setDesktopSettings);
  const workspace = useAppStore((s) => s.workspace);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [trustPending, setTrustPending] = useState(false);

  async function patchDesktop(patch: Record<string, unknown>) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const next = await invoke<typeof desktopSettings>("desktop_settings_patch", { patch });
      setDesktopSettings(next);
      if (patch.theme && next) applyTheme(next.theme);
      if (patch.agentDir) {
        pushNotification("Agent directory changed — restart Pi Host to apply", "warning");
      }
    } catch {
      // Browser mock
      if (desktopSettings) {
        const next = { ...desktopSettings, ...patch } as typeof desktopSettings;
        setDesktopSettings(next);
        if (patch.theme) applyTheme(next!.theme);
      }
    }
  }

  async function openAgentDir() {
    if (!host?.agentDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path: host.agentDir });
    } catch (err) {
      pushNotification(err instanceof Error ? err.message : "Open agent directory failed", "error");
    }
  }

  async function restartHost() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      useAppStore.getState().setHostFatal(null);
      useAppStore.getState().setConnecting(true);
      hostClient.rejectAllPending("manual Host restart");
      await invoke("pi_host_restart");
      pushNotification("Host restarted — waiting for ready…");
    } catch (err) {
      useAppStore.getState().setConnecting(false);
      useAppStore.getState().setHostFatal(
        err instanceof Error ? err.message : String(err),
      );
      pushNotification("Restart Host failed — see Host unavailable banner", "error");
    }
  }

  async function setProjectTrust(decision: "trustOnce" | "trust" | "deny") {
    if (!host || !workspace || trustPending) return;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    setTrustPending(true);
    try {
      const res = await hostClient.request(
        "workspace.setTrust",
        workspaceContext(host, workspace),
        { decision },
        60_000,
      );
      const current = useAppStore.getState();
      if (
        current.host?.hostInstanceId !== expectedHostId ||
        (current.workspace?.id !== expectedWorkspaceId &&
          current.workspace?.id !== res.workspaceId)
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Trust update failed", "error");
        return;
      }
      current.applyWorkspaceSnapshot(res.result.workspace);
      if (res.result.session) current.applySessionSnapshot(res.result.session);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      pushNotification(
        decision === "deny"
          ? "Project resources denied"
          : decision === "trustOnce"
            ? "Project trusted for this Host session"
            : "Project trust saved",
      );
    } finally {
      setTrustPending(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <section>
          <h1 className="mb-1 text-lg font-semibold">General</h1>
          <p className="mb-6 text-sm text-muted">Desktop behavior and Pi Host configuration.</p>
          <h2 className="mb-2 text-sm font-medium text-muted">Desktop</h2>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <label className="flex items-center justify-between text-sm">
              <span>Theme</span>
              <select
                className="rounded border border-border bg-surface px-2 py-1 text-xs"
                value={desktopSettings?.theme ?? "system"}
                onChange={(e) =>
                  void patchDesktop({
                    theme: e.target.value as "light" | "dark" | "system",
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>Restore last session</span>
              <input
                type="checkbox"
                checked={desktopSettings?.restoreLastSession ?? true}
                onChange={(e) =>
                  void patchDesktop({ restoreLastSession: e.target.checked })
                }
              />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>Auto-restart host once</span>
              <input
                type="checkbox"
                checked={desktopSettings?.autoRestartHostOnce ?? true}
                onChange={(e) =>
                  void patchDesktop({ autoRestartHostOnce: e.target.checked })
                }
              />
            </label>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Pi Host runtime</h2>
          <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">SDK</span>
              <span className="font-mono">{host?.sdkVersion ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Node</span>
              <span className="font-mono">{host?.nodeVersion ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Phase</span>
              <span>{host?.phase ?? "—"}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-muted">Agent dir</span>
              <span className="truncate font-mono text-xs" title={host?.agentDir}>
                {host?.agentDir ?? "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Model config</span>
              <span
                className={
                  host?.modelConfigHealth?.state === "error"
                    ? "text-warning"
                    : "text-success"
                }
                title={host?.modelConfigHealth?.message}
              >
                {host?.modelConfigHealth?.state ?? "—"}
              </span>
            </div>
            {host?.modelConfigHealth?.migrationHint && (
              <p className="text-xs text-warning">
                {host.modelConfigHealth.migrationHint.message}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay"
                onClick={() => void openAgentDir()}
              >
                Open agent directory
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay"
                onClick={() => void restartHost()}
              >
                Restart Host
              </button>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Project trust</h2>
          <div className="rounded-lg border border-border p-4 text-sm">
            {workspace ? (
              <>
                <p className="font-mono text-xs">{workspace.canonicalCwd}</p>
                <p className="mt-1 text-muted">
                  Decision: <strong className="text-foreground">{workspace.trust.decision}</strong>
                  {workspace.trust.required ? " (trust resources present)" : " (not required)"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay disabled:opacity-50"
                    disabled={trustPending}
                    onClick={() => void setProjectTrust("trustOnce")}
                  >
                    Trust once
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay disabled:opacity-50"
                    disabled={trustPending}
                    onClick={() => void setProjectTrust("trust")}
                  >
                    Always trust
                  </button>
                  <button
                    type="button"
                    className="rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                    disabled={trustPending}
                    onClick={() => void setProjectTrust("deny")}
                  >
                    Deny
                  </button>
                </div>
              </>
            ) : (
              <p className="text-muted">No workspace selected.</p>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Capabilities</h2>
          <ul className="rounded-lg border border-border p-4 text-xs text-muted">
            <li>packageUpdateCheck: {String(host?.capabilities.packageUpdateCheck)}</li>
            <li>extensionUi: {String(host?.capabilities.extensionUi)}</li>
            <li>projectTrust: {String(host?.capabilities.projectTrust)}</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

export type SettingsSection = "general" | "providers" | "packages";

const SETTINGS_NAV: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "packages", label: "Packages", icon: Package },
];

export function SettingsPage({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <button
          type="button"
          onClick={onClose}
          className="mr-3 flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          title="Back to conversation"
          aria-label="Back to conversation"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-sm font-semibold">Settings</h1>
          <p className="text-[11px] text-muted">Configure PiDeck and its runtime</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-52 shrink-0 border-r border-border bg-sidebar px-3 py-4">
          <p className="mb-2 px-2 text-[11px] font-medium text-muted">PiDeck</p>
          {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
                section === id
                  ? "bg-surface-overlay font-medium text-foreground"
                  : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
              }`}
              onClick={() => setSection(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1">
          {section === "general" ? (
            <GeneralSettings />
          ) : section === "providers" ? (
            <ProvidersSettings />
          ) : (
            <PackagesPage />
          )}
        </div>
      </div>
    </div>
  );
}
