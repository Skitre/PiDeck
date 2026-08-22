import { Archive, Folder, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSearchReport, SessionSearchResultItem } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext, mergeHostIdentity, workspaceContext } from "../../lib/bridge/host-context";
import {
  requestSessionOpenWithRetry,
  SESSION_OPEN_TIMEOUT_MS,
} from "../../lib/bridge/session-open-request";
import { subscribeGlobalSearchOpen } from "../../lib/commands/events";
import { useBrowserOcclusion } from "../../lib/browser-occlusion";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { workspaceDisplayName } from "../workspaces/WorkspacePicker";
import {
  groupResultsByWorkspace,
  highlightSegments,
  searchQueryTerms,
  shouldRunGlobalSearch,
} from "./global-search-model";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 20_000;

const updatedAtFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightSegments(text, terms).map((segment, index) =>
        segment.matched ? (
          <mark key={index} className="rounded-sm bg-accent/25 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Always-mounted host: opens the modal on command/shortcut/sidebar requests. */
export function GlobalSearchHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeGlobalSearchOpen(() => setOpen(true)), []);
  if (!open) return null;
  return <GlobalSearchModal onClose={() => setOpen(false)} />;
}

export function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  useBrowserOcclusion("global-search");
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const currentCwd = useAppStore((s) => s.workspace?.canonicalCwd ?? null);
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<SessionSearchReport | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const request = ++requestRef.current;
    if (!hostInstanceId || !shouldRunGlobalSearch(query)) {
      setReport(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    const timer = window.setTimeout(() => {
      const currentHost = useAppStore.getState().host;
      if (!currentHost || currentHost.hostInstanceId !== hostInstanceId) return;
      void hostClient
        .request(
          "session.searchAll",
          hostContext(currentHost),
          { query, limit: SEARCH_RESULT_LIMIT },
          SEARCH_TIMEOUT_MS,
        )
        .then((res) => {
          if (request !== requestRef.current) return;
          setSearching(false);
          if (!res.ok) {
            setError(res.error?.message ?? t("globalSearchFailed"));
            return;
          }
          setReport(res.result);
        })
        .catch((err) => {
          if (request !== requestRef.current) return;
          setSearching(false);
          setError(err instanceof Error ? err.message : t("globalSearchFailed"));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, hostInstanceId, t]);

  async function openResult(item: SessionSearchResultItem) {
    const state = useAppStore.getState();
    const host = state.host;
    if (
      !host ||
      opening ||
      state.connecting ||
      state.rehydrating ||
      state.desynchronized ||
      Boolean(state.hostFatal)
    ) {
      return;
    }
    setOpening(true);
    try {
      if (state.workspace?.canonicalCwd !== item.cwd) {
        useAppStore.getState().setWorkspaceSwitchTarget(item.cwd);
        let switched;
        try {
          switched = await hostClient.request(
            "workspace.setCurrent",
            workspaceContext(host, state.workspace),
            { cwd: item.cwd },
            60_000,
          );
        } finally {
          useAppStore.getState().setWorkspaceSwitchTarget(null);
        }
        if (!switched.ok) {
          state.pushNotification(switched.error?.message ?? t("notifSetWorkspaceFailed"), "error");
          return;
        }
        // workspace.changed / session.snapshot events usually land before this
        // response resolves; apply only what the event stream has not.
        const result = switched.result;
        const appliedWorkspace = useAppStore.getState().workspace;
        if (
          appliedWorkspace === null ||
          appliedWorkspace.id !== result.workspace.id ||
          appliedWorkspace.revision !== result.workspace.revision
        ) {
          useAppStore.getState().setWorkspace(result.workspace);
        }
        if (result.session) {
          const appliedSession = useAppStore.getState().session;
          if (
            appliedSession === null ||
            appliedSession.sessionId !== result.session.sessionId ||
            appliedSession.revision !== result.session.revision
          ) {
            useAppStore.getState().setSession(result.session);
          }
        }
        useAppStore.getState().setHost({
          ...host,
          workspaceId: switched.workspaceId,
          workspaceRevision: switched.workspaceRevision,
          sessionId: switched.sessionId,
          sessionRevision: switched.sessionRevision,
          packageRevision: switched.packageRevision,
        });
      }

      if (item.archived) {
        useAppStore.getState().pushNotification(t("globalSearchArchivedRestoreHint"), "info");
        onClose();
        return;
      }
      if (useAppStore.getState().session?.sessionPath === item.sessionPath) {
        onClose();
        return;
      }

      const res = await requestSessionOpenWithRetry(() => {
        const latest = useAppStore.getState();
        if (!latest.host || !latest.workspace) {
          throw new Error(t("notifOpenSessionFailed"));
        }
        return hostClient.request(
          "session.open",
          {
            expectedHostInstanceId: latest.host.hostInstanceId,
            expectedWorkspaceId: latest.workspace.id,
            expectedWorkspaceRevision: latest.workspace.revision,
            expectedSessionId: latest.host.sessionId,
            expectedSessionRevision: latest.host.sessionRevision,
          },
          { sessionPath: item.sessionPath },
          SESSION_OPEN_TIMEOUT_MS,
        );
      });
      if (!res) return;
      if (!res.ok) {
        useAppStore
          .getState()
          .pushNotification(res.error?.message ?? t("notifOpenSessionFailed"), "error");
        return;
      }
      const appliedSession = useAppStore.getState().session;
      const alreadyApplied =
        appliedSession !== null &&
        appliedSession.sessionId === res.result.sessionId &&
        appliedSession.revision === res.result.revision;
      if (!alreadyApplied) useAppStore.getState().applySessionSnapshot(res.result);
      const latestHost = useAppStore.getState().host;
      if (latestHost) {
        const nextHost = mergeHostIdentity(latestHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      onClose();
    } catch (err) {
      useAppStore
        .getState()
        .pushNotification(
          err instanceof Error ? err.message : t("notifOpenSessionFailed"),
          "error",
        );
    } finally {
      setOpening(false);
    }
  }

  const terms = searchQueryTerms(query);
  const groups = report ? groupResultsByWorkspace(report.items) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("globalSearchTitle")}
        className="theme-floating-surface flex max-h-[64vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          {searching ? (
            <LoaderCircle size={15} className="shrink-0 animate-spin text-muted" />
          ) : (
            <Search size={15} className="shrink-0 text-muted" />
          )}
          <input
            ref={inputRef}
            autoFocus
            type="search"
            aria-label={t("globalSearchTitle")}
            placeholder={t("globalSearchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="global-search-input h-8 min-w-0 flex-1 !bg-transparent text-sm !shadow-none outline-none placeholder:text-muted"
          />
          <button
            type="button"
            title={t("commonClose")}
            aria-label={t("commonClose")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <p className="px-2 py-6 text-center text-sm text-danger">{error}</p>
          ) : !shouldRunGlobalSearch(query) ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t("globalSearchHint")}</p>
          ) : report === null ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t("globalSearchSearching")}</p>
          ) : report.items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t("globalSearchNoResults")}</p>
          ) : (
            groups.map((group) => (
              <section key={group.cwd} className="mb-2">
                <div
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-muted"
                  title={group.cwd}
                >
                  <Folder size={12} className="shrink-0" />
                  <span className="shrink-0">{workspaceDisplayName(group.cwd)}</span>
                  <span className="min-w-0 truncate font-normal opacity-70">{group.cwd}</span>
                  {group.cwd === currentCwd && (
                    <span className="ml-auto shrink-0 rounded border border-border px-1 text-[10px]">
                      {t("globalSearchCurrentWorkspace")}
                    </span>
                  )}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.sessionPath}>
                      <button
                        type="button"
                        disabled={opening}
                        onClick={() => void openResult(item)}
                        title={item.name?.trim() || t("sessionsUntitled")}
                        className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-overlay disabled:cursor-wait"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                            <Highlighted
                              text={item.name?.trim() || t("sessionsUntitled")}
                              terms={item.nameMatched ? terms : []}
                            />
                          </span>
                          {item.archived && (
                            <span
                              className="flex shrink-0 items-center gap-1 rounded border border-border px-1 text-[10px] text-muted"
                              title={t("sessionsFilterArchived")}
                            >
                              <Archive size={10} />
                              {t("sessionsFilterArchived")}
                            </span>
                          )}
                          <span className="shrink-0 text-[11px] tabular-nums text-muted">
                            {updatedAtFormat.format(item.updatedAt)}
                          </span>
                        </div>
                        {item.matches.slice(0, 2).map((match, index) => (
                          <p key={index} className="mt-0.5 truncate text-xs leading-5 text-muted">
                            <Highlighted text={match.snippet} terms={terms} />
                          </p>
                        ))}
                        {item.matchCount > 2 && (
                          <p className="mt-0.5 text-[11px] text-muted/70">
                            {t("globalSearchMatchCount", { count: item.matchCount })}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {report !== null && report.truncated && (
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
            {t("globalSearchTruncated", { count: report.items.length })}
          </p>
        )}
      </div>
    </div>
  );
}
