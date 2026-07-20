import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ChatHeader } from "./ChatHeader";

export function ChatPage() {
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const host = useAppStore((s) => s.host);
  const packages = useAppStore((s) => s.packages);

  const authBlocked =
    host?.lastError?.code === "AUTH_REQUIRED" ||
    host?.fatalError?.code === "AUTH_REQUIRED";
  const resourceReloadBlocked = packages?.resourceReloadRequired === true;
  const reconcileBlocked = packages?.mutation?.reconcileRequired === true;
  const packageBlocked = resourceReloadBlocked || reconcileBlocked;

  if (!workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <p className="text-base text-foreground">Select a workspace to begin</p>
        <p className="text-sm">Use the folder picker in the sidebar.</p>
      </div>
    );
  }

  if (workspace.trust.decision === "pending") {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        Waiting for project trust decision…
      </div>
    );
  }

  if (!workspace.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        Workspace services are not ready.
        {host?.lastError?.message ? (
          <span className="ml-2 text-danger">{host.lastError.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader />
      {authBlocked && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          Authentication required. Configure credentials in the Pi agent directory
          ({host?.agentDir}). Chat is disabled; Packages and Settings remain available.
        </div>
      )}
      {packageBlocked && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {reconcileBlocked
            ? "Package state must be reconciled from the Packages page before chat can continue."
            : "Package resources must be reloaded from the Packages page before chat can continue."}
        </div>
      )}
      {session ? (
        <>
          <Transcript />
          <Composer disabled={authBlocked || packageBlocked} />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Create or open a session from the sidebar.
        </div>
      )}
    </div>
  );
}
