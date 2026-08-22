import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ChatHeader } from "./ChatHeader";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import { workspaceDisplayName } from "../workspaces/WorkspacePicker";
import { useT } from "../../lib/i18n/use-t";
import { conversationContentWidthStyle } from "./conversation-layout";
import {
  ExtensionDockStrip,
  ExtensionFloatLayer,
  ExtensionUiUndoToast,
} from "../extensions/ExtensionPresentationMounts";

export function ChatPage() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const host = useAppStore((s) => s.host);
  const packages = useAppStore((s) => s.packages);
  const authBlocked = useAppStore((s) => s.authBlocked);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const openSettingsSection = useAppStore((s) => s.openSettingsSection);
  const setAuthBlocked = useAppStore((s) => s.setAuthBlocked);
  const conversationContentWidth = useAppStore((s) => s.desktopSettings?.conversationContentWidth);

  // A login/logout/config save bumps the revision: the blockage the banner
  // describes may be resolved, so re-check by sending again.
  useEffect(() => {
    setAuthBlocked(null);
  }, [providerConfigRevision, setAuthBlocked]);

  const resourceReloadBlocked = packages?.resourceReloadRequired === true;
  const reconcileBlocked = packages?.mutation?.reconcileRequired === true;
  const packageBlocked = resourceReloadBlocked || reconcileBlocked;
  const isNewConversation = Boolean(session && session.messages.length === 0 && session.isIdle);

  if (!workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <p className="text-base text-foreground">{t("chatSelectWorkspaceTitle")}</p>
        <p className="text-sm">{t("chatSelectWorkspaceHint")}</p>
      </div>
    );
  }

  if (!workspace.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        {t("chatWorkspaceServicesNotReady")}
        {host?.lastError?.message ? (
          <span className="ml-2 text-danger">{host.lastError.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-chat-page
      style={conversationContentWidthStyle(conversationContentWidth)}
    >
      <ChatHeader />
      <ExtensionDockStrip />
      {authBlocked && (
        <div
          role="status"
          className="flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
        >
          <span className="min-w-0 flex-1">
            {authBlocked.providerId
              ? t("chatAuthRequiredProvider", { provider: authBlocked.providerId })
              : t("chatAuthRequired")}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-warning/50 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-warning/15"
            onClick={() => openSettingsSection("providers")}
          >
            {t("chatAuthOpenProviders")}
          </button>
          <button
            type="button"
            aria-label={t("chatAuthDismiss")}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-warning/15"
            onClick={() => setAuthBlocked(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {packageBlocked && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {reconcileBlocked ? t("chatPackageReconcileRequired") : t("chatPackageReloadRequired")}
        </div>
      )}
      <div aria-hidden="true" data-chat-header-fade />
      {session ? (
        isNewConversation ? (
          <>
            <InlineExtensionUiRequest />
            <Composer
              disabled={packageBlocked}
              welcomeWorkspaceName={workspaceDisplayName(workspace.cwd)}
            />
          </>
        ) : (
          <>
            <Transcript />
            <InlineExtensionUiRequest />
            <Composer disabled={packageBlocked} />
          </>
        )
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {t("chatNoSession")}
        </div>
      )}
      <ExtensionFloatLayer />
      <ExtensionUiUndoToast />
    </div>
  );
}
