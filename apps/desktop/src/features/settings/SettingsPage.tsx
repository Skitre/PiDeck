import { useEffect, useState } from "react";
import { useAppStore, type SettingsSection } from "../../lib/stores/app-store";
import {
  ArrowLeft,
  ChartColumn,
  Keyboard,
  KeyRound,
  Package,
  Palette,
  RefreshCw,
  ServerCog,
  Settings2,
} from "lucide-react";
import type {
  BusySendBehavior,
  ExtensionDecisionPresentation,
  TerminalProfileId,
} from "@pideck/protocol";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { SectionHeader } from "../../components/SectionHeader";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  type DesktopSettingsUpdate,
} from "../../lib/desktop-settings";
import { HostSettings } from "./HostSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { PackagesPage } from "../packages/PackagesPage";
import { UsageSettings } from "./UsageSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { RestartHostButton } from "./restart-host";
import { hostClient } from "../../lib/bridge/host-client";

type ShellProfileSummary = {
  id: TerminalProfileId;
  label: string;
  path: string;
};

type ShellProfileCatalog = {
  profiles: ShellProfileSummary[];
  automaticProfile: ShellProfileSummary;
};

function GeneralSettings() {
  const t = useT();
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [shellCatalog, setShellCatalog] = useState<ShellProfileCatalog | null>(null);
  const [shellCatalogLoading, setShellCatalogLoading] = useState(false);
  const [shellCatalogError, setShellCatalogError] = useState<string | null>(null);
  const [decisionPresentationSaving, setDecisionPresentationSaving] = useState(false);

  async function openSettingsFile() {
    if (!host?.agentDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path: `${host.agentDir}/settings.json` });
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : t("notifSettingsFileOpenFailed"),
        "error",
      );
    }
  }

  async function loadShellProfiles() {
    setShellCatalogLoading(true);
    setShellCatalogError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setShellCatalog(await invoke<ShellProfileCatalog>("shell_terminal_profiles"));
    } catch (error) {
      setShellCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setShellCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadShellProfiles();
  }, []);

  async function patchDesktop(patch: DesktopSettingsUpdate) {
    try {
      await persistDesktopSettings(patch);
      return true;
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
      return false;
    }
  }

  async function patchExtensionDecisionPresentation(next: ExtensionDecisionPresentation) {
    const previous =
      useAppStore.getState().desktopSettings?.extensionDecisionPresentation ?? "auto";
    if (next === previous || decisionPresentationSaving) return;

    const hostAtStart = useAppStore.getState().host;
    let configuredHost = false;
    setDecisionPresentationSaving(true);
    try {
      if (hostAtStart) {
        const response = await hostClient.request(
          "extensionUi.configure",
          { expectedHostInstanceId: hostAtStart.hostInstanceId },
          { extensionDecisionPresentation: next },
        );
        if (!response.ok) throw new Error(response.error.message);
        configuredHost = true;
      }
      await persistDesktopSettings({ extensionDecisionPresentation: next });
    } catch (error) {
      const currentHost = useAppStore.getState().host;
      const currentHostId = currentHost?.hostInstanceId;
      if (configuredHost && currentHostId && currentHostId === hostAtStart?.hostInstanceId) {
        try {
          await hostClient.request(
            "extensionUi.configure",
            { expectedHostInstanceId: currentHostId },
            { extensionDecisionPresentation: previous },
          );
        } catch {
          // The next hello re-applies the persisted value after a Host epoch change.
        }
      }
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setDecisionPresentationSaving(false);
    }
  }

  const decisionPresentation = desktopSettings?.extensionDecisionPresentation ?? "auto";
  const decisionPresentationOptions: Array<{
    value: ExtensionDecisionPresentation;
    label: MessageKey;
    description: MessageKey;
  }> = [
    {
      value: "auto",
      label: "generalExtensionDecisionAuto",
      description: "generalExtensionDecisionAutoDesc",
    },
    {
      value: "legacy-modal",
      label: "generalExtensionDecisionLegacy",
      description: "generalExtensionDecisionLegacyDesc",
    },
    {
      value: "inline-first",
      label: "generalExtensionDecisionInlineFirst",
      description: "generalExtensionDecisionInlineFirstDesc",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionHeader title={t("navGeneral")} subtitle={t("generalSubtitle")} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("generalStartupGroup")}</h2>
            <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalRestoreSession")}</span>
                  <span className="block text-xs text-muted">{t("generalRestoreSessionDesc")}</span>
                </span>
                <Switch
                  checked={desktopSettings?.restoreLastSession ?? true}
                  label={t("generalRestoreSession")}
                  onChange={(next) => void patchDesktop({ restoreLastSession: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalAutoRestart")}</span>
                  <span className="block text-xs text-muted">{t("generalAutoRestartDesc")}</span>
                </span>
                <Switch
                  checked={desktopSettings?.autoRestartHostOnce ?? true}
                  label={t("generalAutoRestart")}
                  onChange={(next) => void patchDesktop({ autoRestartHostOnce: next })}
                />
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("generalBusySendGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="busy-send-behavior" className="min-w-0 text-sm">
                  <span className="block">{t("generalBusySend")}</span>
                  <span id="busy-send-behavior-help" className="block text-xs text-muted">
                    {t("generalBusySendDesc")}
                  </span>
                </label>
                <select
                  id="busy-send-behavior"
                  className="h-8 min-w-44 max-w-72 rounded-md border border-border bg-surface px-2 text-xs"
                  aria-label={t("generalBusySend")}
                  aria-describedby="busy-send-behavior-help"
                  value={desktopSettings?.busySendBehavior ?? "followUp"}
                  onChange={(event) =>
                    void patchDesktop({
                      busySendBehavior: event.target.value as BusySendBehavior,
                    })
                  }
                >
                  <option value="followUp">
                    {t("generalBusySendFollowUp")} — {t("generalBusySendFollowUpDesc")}
                  </option>
                  <option value="steer">
                    {t("generalBusySendSteer")} — {t("generalBusySendSteerDesc")}
                  </option>
                </select>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">
              {t("generalExtensionDecisionGroup")}
            </h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="extension-decision-presentation" className="min-w-0 text-sm">
                  <span className="block">{t("generalExtensionDecision")}</span>
                  <span
                    id="extension-decision-presentation-help"
                    className="block text-xs text-muted"
                  >
                    {t("generalExtensionDecisionDesc")}
                  </span>
                </label>
                <select
                  id="extension-decision-presentation"
                  className="h-8 min-w-44 max-w-72 rounded-md border border-border bg-surface px-2 text-xs"
                  aria-label={t("generalExtensionDecision")}
                  aria-describedby="extension-decision-presentation-help"
                  value={decisionPresentation}
                  disabled={decisionPresentationSaving}
                  onChange={(event) =>
                    void patchExtensionDecisionPresentation(
                      event.target.value as ExtensionDecisionPresentation,
                    )
                  }
                >
                  {decisionPresentationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-right text-[11px] leading-4 text-muted">
                {t(
                  decisionPresentationOptions.find(
                    (option) => option.value === decisionPresentation,
                  )?.description ?? "generalExtensionDecisionDesc",
                )}
              </p>
              <span className="sr-only" role="status" aria-live="polite">
                {decisionPresentationSaving ? t("generalExtensionDecisionSaving") : ""}
              </span>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("generalTerminalGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="default-shell" className="min-w-0 text-sm">
                  <span className="block">{t("generalDefaultShell")}</span>
                  <span className="block text-xs text-muted">{t("generalDefaultShellDesc")}</span>
                </label>
                <div className="flex min-w-0 items-center gap-1.5">
                  <select
                    id="default-shell"
                    className="h-8 min-w-44 max-w-72 rounded-md border border-border bg-surface px-2 text-xs"
                    value={desktopSettings?.terminalProfile ?? "auto"}
                    disabled={shellCatalogLoading && !shellCatalog}
                    onChange={(event) =>
                      void patchDesktop({
                        terminalProfile: event.target.value as TerminalProfileId,
                      })
                    }
                  >
                    <option value="auto">
                      {t("generalShellAutomatic")}
                      {shellCatalog ? ` (${shellCatalog.automaticProfile.label})` : ""}
                    </option>
                    {shellCatalog?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                    {desktopSettings?.terminalProfile &&
                      desktopSettings.terminalProfile !== "auto" &&
                      !shellCatalog?.profiles.some(
                        (profile) => profile.id === desktopSettings.terminalProfile,
                      ) && (
                        <option value={desktopSettings.terminalProfile} disabled>
                          {t("generalShellUnavailable", { id: desktopSettings.terminalProfile })}
                        </option>
                      )}
                  </select>
                  <button
                    type="button"
                    title={t("generalDetectShells")}
                    aria-label={t("generalDetectShells")}
                    disabled={shellCatalogLoading}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                    onClick={() => void loadShellProfiles()}
                  >
                    <RefreshCw size={14} className={shellCatalogLoading ? "animate-spin" : ""} />
                  </button>
                </div>
              </div>
              {shellCatalogError && (
                <p role="status" className="text-xs text-warning">
                  {shellCatalogError}
                </p>
              )}
              {shellCatalog && (
                <p className="truncate text-right font-mono text-[11px] text-muted">
                  {desktopSettings?.terminalProfile === "auto" || !desktopSettings?.terminalProfile
                    ? shellCatalog.automaticProfile.path
                    : shellCatalog.profiles.find(
                        (profile) => profile.id === desktopSettings.terminalProfile,
                      )?.path}
                </p>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("generalAdvancedGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-sm text-muted">{t("generalAdvancedDesc")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={!host?.agentDir}
                  onClick={() => void openSettingsFile()}
                >
                  {t("generalAdvancedOpenFile")}
                </button>
                <RestartHostButton />
              </div>
              <p className="text-xs text-muted">{t("generalAdvancedRestartHint")}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export type { SettingsSection };

const SETTINGS_NAV: Array<{
  id: SettingsSection;
  label: MessageKey;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "navGeneral", icon: Settings2 },
  { id: "appearance", label: "navAppearance", icon: Palette },
  { id: "providers", label: "navProviders", icon: KeyRound },
  { id: "packages", label: "navPackages", icon: Package },
  { id: "usage", label: "navUsage", icon: ChartColumn },
  { id: "host", label: "navHost", icon: ServerCog },
  { id: "shortcuts", label: "navShortcuts", icon: Keyboard },
];

export function SettingsPage({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose?: () => void;
}) {
  const t = useT();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const providersDirty = useAppStore((s) => s.providersDirty);
  const [pendingSection, setPendingSection] = useState<SettingsSection | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  function requestSection(next: SettingsSection) {
    if (next === section) return;
    if (providersDirty) {
      setPendingSection(next);
      return;
    }
    setSection(next);
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-surface" data-settings-shell>
      <aside
        className="flex w-52 shrink-0 flex-col border-r border-border bg-sidebar"
        data-settings-sidebar
      >
        <header
          className="shrink-0 px-4 py-3"
          data-settings-header
          data-settings-sidebar-header
          data-tauri-drag-region
        >
          <button
            type="button"
            onClick={onClose}
            className="interface-density-control flex h-8 items-center gap-2 rounded-md text-[11px] text-muted transition-colors hover:text-foreground"
            title={t("settingsBack")}
            aria-label={t("settingsBack")}
          >
            <ArrowLeft size={14} />
            <span className="whitespace-nowrap">{t("settingsBack")}</span>
          </button>
          <div className="pointer-events-none mt-2 flex h-8 min-w-0 items-center gap-2.5">
            <span className="theme-settings-mark flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-overlay text-foreground">
              <Settings2 size={15} />
            </span>
            <h1 className="truncate text-sm font-semibold">{t("settingsTitle")}</h1>
          </div>
        </header>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-ui="nav-item"
              data-state={section === id ? "active" : "inactive"}
              className={`theme-nav-item interface-density-nav-row mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
                section === id
                  ? "theme-nav-active bg-nav-active font-medium text-nav-active-foreground"
                  : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
              }`}
              aria-current={section === id ? "page" : undefined}
              onClick={() => requestSection(id)}
            >
              <Icon size={16} />
              {t(label)}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1" data-settings-content>
        {section === "general" ? (
          <GeneralSettings />
        ) : section === "appearance" ? (
          <AppearanceSettings />
        ) : section === "shortcuts" ? (
          <ShortcutsSettings />
        ) : section === "providers" ? (
          <ProvidersSettings />
        ) : section === "packages" ? (
          <PackagesPage />
        ) : section === "host" ? (
          <HostSettings />
        ) : (
          <UsageSettings />
        )}
      </main>
      {pendingSection && (
        <Dialog
          title={t("settingsDiscardTitle")}
          confirmLabel={t("settingsDiscardConfirm")}
          tone="warning"
          onCancel={() => setPendingSection(null)}
          onConfirm={() => {
            setSection(pendingSection);
            setPendingSection(null);
          }}
        >
          <p>{t("settingsDiscardNavBody")}</p>
        </Dialog>
      )}
    </div>
  );
}
