import { useState } from "react";
import type {
  ExtensionDecisionPresentation,
  ExtensionSurfaceFamily,
  ExtensionUiSettings,
  PresentationHome,
} from "@pideck/protocol";
import { MAX_EXTENSION_UI_FLOATS, sanitizeExtensionUiSettings } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { Switch } from "../../components/Switch";
import { secondaryButton } from "../../components/Dialog";
import { hostClient } from "../../lib/bridge/host-client";
import {
  canonicalExtensionUiSettings,
  extensionUiHostConfigureParams,
  notifyDesktopSettingsSaveFailure,
} from "../../lib/desktop-settings";
import {
  commitExtensionUiSettings,
  forgetExtensionUiIdentity,
} from "../../lib/extension-ui-profile";
import { liveExtensionPresentationSlots } from "../../lib/extension-ui-live-slots";
import { countLiveFloatMounts } from "../../lib/extension-ui-slots";
import { extensionUiHomeMessageKey } from "../../lib/extension-ui-home-message";
import {
  forgetObservedExtensionDisplayName,
  observedExtensionDisplayName,
} from "../../lib/extension-ui-observation";
import {
  FAMILY_PRESENTATION_CHOICES,
  isLegalPresentationChoice,
  presentationChoiceFromHome,
  presentationHomeFromChoice,
  type ExtensionUiPresentationChoice,
} from "../../lib/extension-ui-presentation";

const FAMILY_LABELS: Record<ExtensionSurfaceFamily, MessageKey> = {
  widget: "extensionUiFamilyWidget",
  status: "extensionUiFamilyStatus",
  custom: "extensionUiFamilyCustom",
  blockingDialog: "extensionUiFamilyBlocking",
};

const CHOICE_LABELS: Record<ExtensionUiPresentationChoice, MessageKey> = {
  followExtension: "extensionUiHomeFollowExtension",
  followHost: "extensionUiHomeFollowHost",
  aboveComposer: "extensionUiHomeAboveComposer",
  belowComposer: "extensionUiHomeBelowComposer",
  dockPrimary: "extensionUiHomeDockPrimary",
  dockSecondary: "extensionUiHomeDockSecondary",
  float: "extensionUiHomeFloat",
  hidden: "extensionUiHomeHidden",
  inline: "extensionUiHomeInline",
  modal: "extensionUiHomeModal",
};

function observedExtensionIds(settings: ExtensionUiSettings): string[] {
  return Object.keys(settings.observedCapabilities).sort((left, right) => {
    const leftSeen = settings.observedCapabilities[left]?.lastSeenAt ?? 0;
    const rightSeen = settings.observedCapabilities[right]?.lastSeenAt ?? 0;
    return rightSeen - leftSeen || left.localeCompare(right);
  });
}

async function syncHostConfigure(nextSettings?: {
  extensionDecisionPresentation?: ExtensionDecisionPresentation;
  extensionUi?: ExtensionUiSettings;
}): Promise<boolean> {
  const host = useAppStore.getState().host;
  if (!host) return true;
  const current = useAppStore.getState().desktopSettings;
  const params = extensionUiHostConfigureParams({
    extensionDecisionPresentation:
      nextSettings?.extensionDecisionPresentation ??
      current?.extensionDecisionPresentation ??
      "auto",
    extensionUi: nextSettings?.extensionUi ?? current?.extensionUi,
  });
  const response = await hostClient.request(
    "extensionUi.configure",
    { expectedHostInstanceId: host.hostInstanceId },
    params,
  );
  if (!response.ok) throw new Error(response.error.message);
  return true;
}

export function ExtensionUiSettingsSection() {
  const t = useT();
  const desktopSettings = useAppStore((state) => state.desktopSettings);
  const extensionUi = desktopSettings?.extensionUi;
  const [savingId, setSavingId] = useState<string | null>(null);
  if (!extensionUi) return null;
  const extensionIds = observedExtensionIds(extensionUi);
  const liveFloats = countLiveFloatMounts(liveExtensionPresentationSlots());

  async function updateFamilyHome(
    extensionId: string,
    family: ExtensionSurfaceFamily,
    nextHome: PresentationHome | undefined,
  ) {
    if (savingId) return;
    const previous = useAppStore.getState().desktopSettings;
    const previousConfigure = extensionUiHostConfigureParams(previous);
    const current = canonicalExtensionUiSettings(previous);
    const next = sanitizeExtensionUiSettings(
      (() => {
        const profile = { ...(current.presentations[extensionId] ?? {}) };
        if (!nextHome) delete profile[family];
        else profile[family] = { home: nextHome };
        const presentations = { ...current.presentations };
        if (Object.keys(profile).length === 0) delete presentations[extensionId];
        else presentations[extensionId] = profile;
        return { ...current, presentations };
      })(),
    );
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    setSavingId(`${extensionId}:${family}`);
    let configuredHost = false;
    try {
      if (family === "blockingDialog") {
        await syncHostConfigure({ extensionUi: next });
        configuredHost = true;
      }
      await commitExtensionUiSettings({
        next,
        previous: current,
        message: t(extensionUiHomeMessageKey(nextHome ?? { kind: "followExtension" }), {
          name: observedExtensionDisplayName(extensionId),
          family: t(FAMILY_LABELS[family]),
        }),
      });
    } catch (error) {
      if (configuredHost) {
        const host = useAppStore.getState().host;
        if (host && previous) {
          try {
            await hostClient.request(
              "extensionUi.configure",
              { expectedHostInstanceId: host.hostInstanceId },
              previousConfigure,
            );
          } catch {
            // The next hello re-applies the persisted value after a Host epoch change.
          }
        }
      }
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setSavingId(null);
    }
  }

  async function resetExtension(extensionId: string) {
    if (savingId) return;
    const previous = useAppStore.getState().desktopSettings;
    const previousConfigure = extensionUiHostConfigureParams(previous);
    const current = canonicalExtensionUiSettings(previous);
    if (!current.presentations[extensionId]) return;
    const hadBlocking = Boolean(current.presentations[extensionId]?.blockingDialog);
    const next = sanitizeExtensionUiSettings({
      ...current,
      presentations: Object.fromEntries(
        Object.entries(current.presentations).filter(([id]) => id !== extensionId),
      ),
    });
    setSavingId(`${extensionId}:reset`);
    let configuredHost = false;
    try {
      if (hadBlocking) {
        await syncHostConfigure({ extensionUi: next });
        configuredHost = true;
      }
      await commitExtensionUiSettings({
        next,
        previous: current,
        message: t("extensionUiChangedHome", {
          name: observedExtensionDisplayName(extensionId),
          family: t("extensionUiSettingsGroup"),
        }),
      });
    } catch (error) {
      if (configuredHost) {
        const host = useAppStore.getState().host;
        if (host && previous) {
          try {
            await hostClient.request(
              "extensionUi.configure",
              { expectedHostInstanceId: host.hostInstanceId },
              previousConfigure,
            );
          } catch {
            // The next hello re-applies the persisted value after a Host epoch change.
          }
        }
      }
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setSavingId(null);
    }
  }

  async function forgetExtension(extensionId: string) {
    if (savingId) return;
    const previous = useAppStore.getState().desktopSettings;
    const previousConfigure = extensionUiHostConfigureParams(previous);
    const current = canonicalExtensionUiSettings(previous);
    if (!current.presentations[extensionId] && !current.observedCapabilities[extensionId]) return;
    const hadBlocking = Boolean(current.presentations[extensionId]?.blockingDialog);
    const next = forgetExtensionUiIdentity(current, extensionId);
    setSavingId(`${extensionId}:forget`);
    let configuredHost = false;
    try {
      if (hadBlocking) {
        await syncHostConfigure({ extensionUi: next });
        configuredHost = true;
      }
      await commitExtensionUiSettings({
        next,
        previous: current,
        message: t("extensionUiChangedHome", {
          name: observedExtensionDisplayName(extensionId),
          family: t("extensionUiSettingsGroup"),
        }),
      });
      forgetObservedExtensionDisplayName(extensionId);
    } catch (error) {
      if (configuredHost) {
        const host = useAppStore.getState().host;
        if (host && previous) {
          try {
            await hostClient.request(
              "extensionUi.configure",
              { expectedHostInstanceId: host.hostInstanceId },
              previousConfigure,
            );
          } catch {
            // The next hello re-applies the persisted value after a Host epoch change.
          }
        }
      }
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section>
      <div className="flex flex-col gap-4">
        {extensionIds.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-sm text-muted">
            {t("extensionUiSettingsEmpty")}
          </p>
        ) : null}
        {extensionIds.map((extensionId) => {
          const observed = extensionUi.observedCapabilities[extensionId];
          if (!observed) return null;
          const profile = extensionUi.presentations[extensionId] ?? {};
          return (
            <div
              key={extensionId}
              className="flex flex-col gap-3 rounded-lg border border-border p-4"
              data-extension-ui-profile={extensionId}
            >
              <h3 className="text-sm font-medium">{observedExtensionDisplayName(extensionId)}</h3>
              {observed.families.map((family) => {
                const home = profile[family]?.home;
                const choice = presentationChoiceFromHome(family, home);
                const selectId = `extension-ui-${extensionId}-${family}`;
                return (
                  <div key={family} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-4">
                      <label htmlFor={selectId} className="min-w-0 text-sm">
                        <span className="block">{t(FAMILY_LABELS[family])}</span>
                        <span className="block text-xs text-muted">{t("extensionUiShowIn")}</span>
                      </label>
                      <select
                        id={selectId}
                        className="h-8 min-w-44 max-w-72 rounded-md border border-border bg-surface px-2 text-xs"
                        aria-label={`${t(FAMILY_LABELS[family])} ${t("extensionUiShowIn")}`}
                        value={choice}
                        disabled={savingId !== null}
                        onChange={(event) => {
                          const nextChoice = event.target.value;
                          if (!isLegalPresentationChoice(family, nextChoice)) return;
                          void updateFamilyHome(
                            extensionId,
                            family,
                            presentationHomeFromChoice(family, nextChoice, extensionUi, home),
                          );
                        }}
                      >
                        {FAMILY_PRESENTATION_CHOICES[family].map((option) => (
                          <option
                            key={option}
                            value={option}
                            disabled={
                              option === "float" &&
                              choice !== "float" &&
                              liveFloats >= MAX_EXTENSION_UI_FLOATS
                            }
                          >
                            {t(CHOICE_LABELS[option])}
                          </option>
                        ))}
                      </select>
                    </div>
                    {family !== "blockingDialog" && home?.kind === "float" && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm">{t("extensionUiPin")}</span>
                        <Switch
                          checked={home.pinned === true}
                          label={t("extensionUiPin")}
                          disabled={savingId !== null}
                          onChange={(pinned) =>
                            void updateFamilyHome(extensionId, family, {
                              ...home,
                              pinned,
                            })
                          }
                        />
                      </div>
                    )}
                    {family === "blockingDialog" && (
                      <p className="text-xs text-muted">{t("extensionUiHighRiskLocked")}</p>
                    )}
                  </div>
                );
              })}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={savingId !== null}
                  onClick={() => void resetExtension(extensionId)}
                >
                  {t("extensionUiReset")}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={savingId !== null}
                  onClick={() => void forgetExtension(extensionId)}
                >
                  {t("extensionUiForget")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
