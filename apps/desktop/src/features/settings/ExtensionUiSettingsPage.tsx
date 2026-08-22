import { SectionHeader } from "../../components/SectionHeader";
import { useT } from "../../lib/i18n/use-t";
import { ExtensionUiSettingsSection } from "./ExtensionUiSettingsSection";

export function ExtensionUiSettingsPage() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionHeader title={t("navExtensionUi")} subtitle={t("extensionUiSettingsSubtitle")} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <ExtensionUiSettingsSection />
        </div>
      </div>
    </div>
  );
}
