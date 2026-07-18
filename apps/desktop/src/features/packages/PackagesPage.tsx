import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Trash2, FolderOpen } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  captureRequestGeneration,
  captureWorkspaceAuthorization,
  isCurrentWorkspaceAuthorization,
  isExpectedPackageMutationCompletion,
  mergeHostIdentity,
  sessionPackageContext,
  workspaceContext,
  type WorkspaceAuthorization,
} from "../../lib/bridge/host-context";
import type {
  HostRequestParams,
  PackageMutationResult,
  PackageRecord,
  PackageResource,
  TopLevelResource,
} from "@pideck/protocol";

type MutationMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.setResourceEnabled"
  | "resource.setTopLevelEnabled"
  | "package.reloadResources";

type PendingProjectMutation = {
  method: MutationMethod;
  params: HostRequestParams[MutationMethod];
  allowReconcileRetry?: boolean;
  step: "trust" | "confirm";
  authorization: WorkspaceAuthorization;
};

export function PackagesPage() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const packages = useAppStore((s) => s.packages);
  const packageProgress = useAppStore((s) => s.packageProgress);
  const packageRetry = useAppStore((s) => s.packageRetry);
  const setPackages = useAppStore((s) => s.applyPackageSnapshot);
  const applyPackageMutationResult = useAppStore((s) => s.applyPackageMutationResult);
  const setPackageRetry = useAppStore((s) => s.setPackageRetry);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [scope, setScope] = useState<"user" | "project" | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const [projectGate, setProjectGate] = useState<PendingProjectMutation | null>(null);
  const [projectGateBusy, setProjectGateBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshRequest = useRef(0);
  const projectGateDialogRef = useRef<HTMLDivElement>(null);

  const updateCheckSupported = host?.capabilities.packageUpdateCheck ?? false;
  const reloadRequired = packages?.resourceReloadRequired === true;
  const reconcileRequired = packages?.mutation?.reconcileRequired === true;
  const progressActive =
    packageProgress?.type === "start" || packageProgress?.type === "progress";
  const mutationRunning = packages?.mutation?.status === "running" || progressActive;
  const mutationBlocked = busy || mutationRunning || reloadRequired || reconcileRequired;
  const progressIdle =
    progressActive && now - (packageProgress?.lastEventAt ?? now) >= 15_000;

  async function refresh() {
    if (!host || !workspace?.servicesReady) return;
    const request = ++refreshRequest.current;
    const requestedScope = scope;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    const expectedWorkspaceRevision = workspace.revision;
    const res = await hostClient.request(
      "package.list",
      workspaceContext(host, workspace),
      { scope: requestedScope, includeResources: true },
      60_000,
    );
    const current = useAppStore.getState();
    if (
      request !== refreshRequest.current ||
      current.host?.hostInstanceId !== expectedHostId ||
      current.workspace?.id !== expectedWorkspaceId ||
      current.workspace?.revision !== expectedWorkspaceRevision
    ) {
      return;
    }
    if (res.ok) {
      setPackages(res.result);
      const currentHost = current.host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } else {
      pushNotification(res.error?.message ?? "List packages failed", "error");
    }
  }

  useEffect(() => {
    if (!progressActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progressActive, packageProgress?.operationId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId, workspace?.id, workspace?.revision, scope]);

  useEffect(() => {
    if (!projectGate) return;
    const dialog = projectGateDialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !projectGateBusy) {
        setProjectGate(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [projectGate, projectGateBusy]);

  useEffect(() => {
    if (
      projectGate &&
      !isCurrentWorkspaceAuthorization(host, workspace, projectGate.authorization, {
        requireTrusted: projectGate.step === "confirm",
      })
    ) {
      setProjectGate(null);
    }
  }, [host, workspace, projectGate]);

  const selected: PackageRecord | undefined = packages?.configured.find(
    (p) => p.id === selectedId,
  );
  const resources: PackageResource[] =
    packages?.packageResources.filter((r) => r.packageId === selectedId) ?? [];
  const topLevel: TopLevelResource[] = packages?.topLevelResources ?? [];

  function applyMutationResult(result: PackageMutationResult) {
    applyPackageMutationResult(result);
    if (result.status === "partialFailure" || result.reconcileRequired) {
      const warn =
        result.warnings?.map((w) => w.message).filter(Boolean).join("; ") ||
        "Package operation partially failed — reload resources if needed";
      pushNotification(warn, "warning");
    } else if (result.status === "failed") {
      const msg =
        result.warnings?.[0]?.message ?? "Package operation failed";
      pushNotification(msg, "error");
    }
  }

  function isProjectMutation<M extends MutationMethod>(
    method: M,
    params: HostRequestParams[M],
  ): boolean {
    if (method === "package.install") {
      return (params as HostRequestParams["package.install"]).scope === "project";
    }
    if (method === "package.updateAll") {
      return (params as HostRequestParams["package.updateAll"]).scope !== "user";
    }
    if (
      method === "package.remove" ||
      method === "package.update" ||
      method === "package.setResourceEnabled"
    ) {
      const packageId = (
        params as
          | HostRequestParams["package.remove"]
          | HostRequestParams["package.update"]
          | HostRequestParams["package.setResourceEnabled"]
      ).packageId;
      return packages?.configured.find((pkg) => pkg.id === packageId)?.scope === "project";
    }
    if (method === "resource.setTopLevelEnabled") {
      const resourceId = (params as HostRequestParams["resource.setTopLevelEnabled"]).resourceId;
      return packages?.topLevelResources.find((resource) => resource.id === resourceId)?.scope === "project";
    }
    return false;
  }

  async function runMutation<M extends MutationMethod>(
    method: M,
    params: HostRequestParams[M],
    options?: {
      allowReconcileRetry?: boolean;
      projectAuthorization?: WorkspaceAuthorization;
    },
  ) {
    if (!host || !workspace) return;
    if (isProjectMutation(method, params)) {
      if (!options?.projectAuthorization) {
        const trusted =
          workspace.trust.decision === "trusted" || workspace.trust.decision === "session";
        setProjectGate({
          method,
          params: params as HostRequestParams[MutationMethod],
          allowReconcileRetry: options?.allowReconcileRetry,
          step: trusted ? "confirm" : "trust",
          authorization: captureWorkspaceAuthorization(host, workspace),
        });
        return;
      }
      if (
        !isCurrentWorkspaceAuthorization(
          useAppStore.getState().host,
          useAppStore.getState().workspace,
          options.projectAuthorization,
          { requireTrusted: true },
        )
      ) {
        pushNotification("Project authorization expired; review trust and confirm again", "warning");
        return;
      }
    }
    if (
      (reloadRequired || reconcileRequired) &&
      method !== "package.reloadResources" &&
      !options?.allowReconcileRetry
    ) {
      pushNotification(
        reconcileRequired
          ? "Reload package state or retry the failed operation before another mutation"
          : "Reload package resources before starting another mutation",
        "warning",
      );
      return;
    }
    const generation = captureRequestGeneration(host);
    setPackageRetry({ method, params: params as never });
    setBusy(true);
    try {
      const res = await hostClient.request(
        method,
        sessionPackageContext(host, workspace),
        params,
        method === "package.install" || method === "package.update" || method === "package.updateAll"
          ? 600_000
          : 60_000,
      );
      const current = useAppStore.getState();
      if (
        !isExpectedPackageMutationCompletion(current.host, generation, res) ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Operation failed", "error");
        return;
      }
      applyMutationResult(res.result as PackageMutationResult);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      if (!res.result.reconcileRequired) {
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function decideProjectTrust(decision: "trustOnce" | "trust") {
    if (!host || !workspace || !projectGate || projectGateBusy) return;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    setProjectGateBusy(true);
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
        pushNotification(res.error?.message ?? "Trust decision failed", "error");
        return;
      }
      current.applyWorkspaceSnapshot(res.result.workspace);
      if (res.result.session) current.applySessionSnapshot(res.result.session);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      const authorizedState = useAppStore.getState();
      if (!authorizedState.host || !authorizedState.workspace) {
        setProjectGate(null);
        return;
      }
      setProjectGate((pending) =>
        pending
          ? {
              ...pending,
              step: "confirm",
              authorization: captureWorkspaceAuthorization(
                authorizedState.host!,
                authorizedState.workspace!,
              ),
            }
          : null,
      );
    } finally {
      setProjectGateBusy(false);
    }
  }

  function confirmProjectMutation() {
    const pending = projectGate;
    if (!pending || projectGateBusy) return;
    const current = useAppStore.getState();
    if (
      !isCurrentWorkspaceAuthorization(
        current.host,
        current.workspace,
        pending.authorization,
        { requireTrusted: true },
      )
    ) {
      setProjectGate(null);
      pushNotification("Project authorization expired; review trust and confirm again", "warning");
      return;
    }
    setProjectGate(null);
    void runMutation(pending.method, pending.params as never, {
      allowReconcileRetry: pending.allowReconcileRetry,
      projectAuthorization: pending.authorization,
    });
  }

  async function checkUpdates() {
    if (!host || !workspace) return;
    setBusy(true);
    try {
      const res = await hostClient.request(
        "package.checkUpdates",
        workspaceContext(host, workspace),
        {},
        60_000,
      );
      const current = useAppStore.getState();
      if (
        current.host?.hostInstanceId !== host.hostInstanceId ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Operation failed", "error");
        return;
      }
      const updateIds = new Set(res.result.updates.map((update) => update.packageId));
      if (current.packages?.workspaceId === workspace.id) {
        setPackages({
          ...current.packages,
          configured: current.packages.configured.map((pkg) => ({
            ...pkg,
            updateAvailable: updateIds.has(pkg.id),
          })),
          updateCheck: {
            supported: res.result.supported,
            checkedAt: Date.now(),
          },
        });
      }
      pushNotification(
        res.result.supported === false
          ? "Update check not supported"
          : `${res.result.updates.length} update${res.result.updates.length === 1 ? "" : "s"} available`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!workspace?.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        Select and prepare a workspace to manage packages.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {projectGate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            ref={projectGateDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-package-gate-title"
            className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
          >
            <h2 id="project-package-gate-title" className="text-base font-semibold">
              {projectGate.step === "trust" ? "Trust project packages" : "Confirm executable code"}
            </h2>
            {projectGate.step === "trust" ? (
              <>
                <p className="mt-2 text-sm text-muted">
                  Project packages can load workspace extensions, skills, prompts, and themes. Choose how this workspace may load them before continuing.
                </p>
                <p className="mt-2 truncate font-mono text-xs" title={workspace.canonicalCwd}>
                  {workspace.canonicalCwd}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                    disabled={projectGateBusy}
                    onClick={() => setProjectGate(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay disabled:opacity-50"
                    disabled={projectGateBusy}
                    onClick={() => void decideProjectTrust("trustOnce")}
                  >
                    Trust once
                  </button>
                  <button
                    type="button"
                    className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    disabled={projectGateBusy}
                    onClick={() => void decideProjectTrust("trust")}
                  >
                    Always trust
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted">
                  Extensions execute local code, and skills or prompts can direct local operations. Continue only if you trust the package source and its dependencies.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                    onClick={() => setProjectGate(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded bg-accent px-3 py-1.5 text-sm text-white"
                    onClick={confirmProjectMutation}
                  >
                    Continue
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {packageProgress && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 py-2 text-xs">
          <RefreshCw size={13} className={progressActive ? "animate-spin" : ""} />
          <span className="font-medium capitalize">{packageProgress.action}</span>
          <span className="min-w-0 flex-1 truncate text-muted" title={packageProgress.source}>
            {packageProgress.message ?? packageProgress.source}
          </span>
          <span className={packageProgress.type === "error" ? "text-danger" : "text-muted"}>
            {progressIdle ? "Still waiting" : packageProgress.type}
          </span>
        </div>
      )}
      {reconcileRequired && (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 text-warning">
            The previous Package operation partially changed state. Reload the authoritative state or retry it.
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-surface-overlay"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Reload state
          </button>
          <button
            type="button"
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={busy || !packageRetry}
            onClick={() => {
              if (packageRetry) {
                void runMutation(
                  packageRetry.method as MutationMethod,
                  packageRetry.params as never,
                  { allowReconcileRetry: true },
                );
              }
            }}
          >
            Retry operation
          </button>
        </div>
      )}
      {reloadRequired && (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs">
          <span className="text-warning">
            Session resources require reload before chat prompts can continue.
          </span>
          <button
            type="button"
            className="rounded bg-accent px-2 py-0.5 text-white"
            disabled={busy}
            onClick={() => void runMutation("package.reloadResources", null)}
          >
            Reload resources
          </button>
        </div>
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="text-sm font-semibold">Packages</h1>
        <div className="ml-4 flex rounded-md border border-border text-xs">
          {(["all", "user", "project"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`px-2 py-1 capitalize ${scope === s ? "bg-accent/15 text-accent" : "text-muted"}`}
              onClick={() => setScope(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {updateCheckSupported && (
            <button
              type="button"
              title="Check for updates"
              className="rounded p-1.5 text-muted hover:bg-surface-overlay"
              disabled={busy}
              onClick={() => void checkUpdates()}
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            type="button"
            title="Update all"
            className="rounded p-1.5 text-muted hover:bg-surface-overlay"
            disabled={mutationBlocked}
            onClick={() => void runMutation("package.updateAll", { scope: "all" })}
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r border-border">
          <div className="border-b border-border p-2">
            <div className="flex gap-1">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs"
                placeholder="npm:pkg | git:… | path"
                value={installSource}
                onChange={(e) => setInstallSource(e.target.value)}
              />
              <select
                className="rounded border border-border bg-surface text-xs"
                value={installScope}
                onChange={(e) => setInstallScope(e.target.value as "user" | "project")}
              >
                <option value="user">user</option>
                <option value="project">project</option>
              </select>
              <button
                type="button"
                title="Install package"
                className="rounded bg-accent px-2 text-xs text-white disabled:opacity-40"
                disabled={mutationBlocked || !installSource.trim()}
                onClick={() =>
                  void runMutation("package.install", {
                    source: installSource.trim(),
                    scope: installScope,
                  })
                }
              >
                Install
              </button>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              Extensions can run code. Install only sources you trust.
            </p>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto p-1">
            {(packages?.configured ?? []).length === 0 && (
              <li className="p-3 text-xs text-muted">
                No packages. Install from npm, git, or a local path.
              </li>
            )}
            {(packages?.configured ?? []).map((pkg) => (
              <li key={pkg.id}>
                <button
                  type="button"
                  className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                    selectedId === pkg.id ? "bg-accent/15" : "hover:bg-surface-overlay"
                  }`}
                  onClick={() => setSelectedId(pkg.id)}
                >
                  <div className="flex items-center gap-1">
                    <span className="truncate font-medium">{pkg.displayName}</span>
                    {pkg.updateAvailable && (
                      <span className="rounded bg-warning/20 px-1 text-[10px] text-warning">
                        update
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-muted">
                    {pkg.scope} · {pkg.kind}
                    {!pkg.effective && " · shadowed"}
                    {pkg.resourceCountsState === "unknownShadowed" && " · resources n/a"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-4">
          {!selected ? (
            <p className="text-sm text-muted">Select a package to view resources.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-sm font-semibold">{selected.displayName}</h2>
                <p className="truncate font-mono text-xs text-muted" title={selected.source}>
                  {selected.source}
                </p>
                <p className="text-xs text-muted">
                  {selected.scope} · {selected.kind}
                  {selected.installedPath ? ` · ${selected.installedPath}` : ""}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    title="Update"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay"
                    disabled={mutationBlocked}
                    onClick={() => void runMutation("package.update", { packageId: selected.id })}
                  >
                    <Download size={12} /> Update
                  </button>
                  <button
                    type="button"
                    title="Remove"
                    className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10"
                    disabled={mutationBlocked}
                    onClick={() => {
                      if (confirm(`Remove ${selected.displayName}?`)) {
                        void runMutation("package.remove", { packageId: selected.id });
                      }
                    }}
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                  {selected.installedPath && (
                    <button
                      type="button"
                      title="Open folder"
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-overlay"
                      onClick={async () => {
                        try {
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("desktop_open_path", { path: selected.installedPath });
                        } catch {
                          pushNotification("Open folder unavailable", "warning");
                        }
                      }}
                    >
                      <FolderOpen size={12} /> Open
                    </button>
                  )}
                </div>
              </div>

              {(["extension", "skill", "prompt", "theme"] as const).map((type) => {
                const list = resources.filter((r) => r.type === type);
                if (!list.length) return null;
                return (
                  <section key={type}>
                    <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                      {type}s
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {list.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate" title={r.path}>
                            {r.name}
                          </span>
                          <label className="flex items-center gap-1 text-muted">
                            <input
                              type="checkbox"
                              checked={r.enabled}
                              disabled={mutationBlocked || !selected.effective}
                              onChange={(e) =>
                                void runMutation("package.setResourceEnabled", {
                                  packageId: selected.id,
                                  resourceId: r.id,
                                  enabled: e.target.checked,
                                })
                              }
                            />
                            enabled
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}

              {!selected.effective && (
                <p className="text-xs text-warning">
                  This package is shadowed by a project-scope package with the same
                  identity. Resource counts may be unavailable.
                </p>
              )}
            </div>
          )}

          {topLevel.length > 0 && (
            <section className="mt-8 border-t border-border pt-4">
              <h3 className="mb-2 text-sm font-semibold">Standalone resources</h3>
              <ul className="flex flex-col gap-1">
                {topLevel.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
                  >
                    <span className="rounded bg-surface-overlay px-1 text-[10px] uppercase text-muted">
                      {r.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={r.path}>
                      {r.name}
                    </span>
                    <span className="text-muted">{r.scope}</span>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        disabled={mutationBlocked}
                        onChange={(e) =>
                          void runMutation("resource.setTopLevelEnabled", {
                            resourceId: r.id,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      enabled
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
