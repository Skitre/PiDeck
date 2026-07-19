import { MessageCirclePlus, Settings } from "lucide-react";
import { useRef, useState } from "react";
import { useAppStore, type NavPage } from "../lib/stores/app-store";
import { hostClient } from "../lib/bridge/host-client";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
} from "../lib/bridge/host-context";
import { SessionList } from "../features/sessions/SessionList";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker";
import { sidebarPref, setSidebarPref } from "../lib/sidebar-prefs";

function NewSessionButton() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  async function createSession() {
    if (!host || !workspace?.servicesReady || pending) return;
    const request = ++requestRef.current;
    const generation = captureRequestGeneration(host);
    setPending(true);
    try {
      const res = await hostClient.request(
        "session.create",
        nullableSessionContext(host, workspace),
        {},
      );
      if (
        request !== requestRef.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Create session failed", "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } finally {
      if (request === requestRef.current) setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void createSession()}
      disabled={!workspace?.servicesReady || pending}
      className="flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
    >
      <MessageCirclePlus size={18} className="shrink-0" />
      <span>{pending ? "Creating..." : "New conversation"}</span>
    </button>
  );
}

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);

  return <SidebarLayout page={page} setPage={setPage} />;
}

export function SidebarLayout({
  page,
  setPage,
}: {
  page: NavPage;
  setPage: (page: NavPage) => void;
}) {
  const host = useAppStore((s) => s.host);
  const hostReady = host?.phase === "ready" || host?.phase === "waitingForWorkspace";
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.sessionsCollapsed"),
  );

  function toggleSessionsCollapsed() {
    setSessionsCollapsed((current) => {
      setSidebarPref("pideck.sidebar.sessionsCollapsed", !current);
      return !current;
    });
  }

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-16 shrink-0 items-center gap-3 px-4" data-tauri-drag-region>
        <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-surface">
          pi
        </div>
        <span className="text-[15px] font-semibold">Pi Agent</span>
      </div>

      <div className="px-2 pb-3">
        <NewSessionButton />
      </div>

      <div className="border-t border-border px-2 py-3">
        <WorkspacePicker />
      </div>

      {/* Collapsed: the header row docks at the bottom, right above Settings. */}
      <div
        className={
          sessionsCollapsed
            ? "mt-auto shrink-0 border-t border-border px-2 py-1"
            : "min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        }
      >
        <SessionList
          showCreateAction={false}
          collapsed={sessionsCollapsed}
          onToggleCollapsed={toggleSessionsCollapsed}
        />
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <button
          type="button"
          onClick={() => setPage(page === "chat" ? "settings" : "chat")}
          className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm transition-colors ${
            page !== "chat"
              ? "bg-surface-overlay text-foreground"
              : "text-foreground hover:bg-surface-overlay"
          }`}
        >
          <Settings size={17} />
          <span className="flex-1">Settings</span>
          <span
            className={`size-1.5 rounded-full ${
              hostReady ? "bg-success" : host ? "bg-warning" : "bg-muted"
            }`}
            title={host?.phase ?? "Host offline"}
          />
        </button>
      </div>
    </aside>
  );
}
