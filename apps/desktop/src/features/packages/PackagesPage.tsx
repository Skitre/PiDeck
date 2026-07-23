import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  PackageOpen,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import type {
  HostRequestParams,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageRecord,
  ResourceRecord,
  ResourcePreferenceUpdate,
  ResourceType,
  WorkspaceSnapshot,
} from "@pideck/protocol";
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
import { useAppStore } from "../../lib/stores/app-store";
import {
  PACKAGE_RESOURCE_TYPES,
  PACKAGE_LIST_PARAMS,
  applyOptimisticResourcePreferences,
  buildResourceListItems,
  buildResourcePreferenceUpdate,
  buildResourcePreferenceUpdates,
  canConfigureResource,
  filterInstalledPackages,
  filterResources,
  hasActiveInstalledFilters,
  hasActiveResourceFilters,
  planPackageUpdate,
  preferenceResourcesForListItems,
  resourcePreference,
  summarizeResources,
  type PackageScopeFilter,
  type ResourceListItem,
  type ResourceMode,
  type ResourceOriginFilter,
  type ResourceTypeFilter,
} from "./packages-model";

type PackageResourceListItem = Extract<ResourceListItem, { kind: "package" }>;

type MutationMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.reloadResources"
  | "resource.setPreference"
  | "resource.setPreferences";

export type PendingProjectMutation = {
  method: MutationMethod;
  params: HostRequestParams[MutationMethod];
  allowReconcileRetry?: boolean;
  authorization: WorkspaceAuthorization;
};

type MutationReview = {
  kind: "install" | "update";
  method: "package.install" | "package.update" | "package.updateAll";
  params:
    | HostRequestParams["package.install"]
    | HostRequestParams["package.update"]
    | HostRequestParams["package.updateAll"];
  authorization?: WorkspaceAuthorization;
  packages: PackageRecord[];
};

type LoadState = "idle" | "loading" | "ready" | "error";

const inputClass =
  "h-8 min-w-0 rounded border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-accent";
const secondaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded bg-accent px-2.5 text-xs text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40";

export function reconcileProjectGateAuthorization(
  host: HostStatusSnapshot | null,
  workspace: WorkspaceSnapshot | null,
  projectGate: PendingProjectMutation,
): PendingProjectMutation | null {
  return isCurrentWorkspaceAuthorization(host, workspace, projectGate.authorization)
    ? projectGate
    : null;
}

function scopeLabel(scope: PackageRecord["scope"] | ResourceRecord["scope"]): string {
  return scope === "temporary" ? "Runtime" : scope === "project" ? "Project" : "User";
}

function pluralType(type: ResourceType): string {
  return type === "skill" ? "Skills" : `${type[0].toUpperCase()}${type.slice(1)}s`;
}

function Dialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return onCancel();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return event.preventDefault();
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
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="package-dialog-title"
        className="max-h-[min(680px,90vh)] w-full max-w-lg overflow-auto rounded-lg border border-border bg-surface-raised p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded p-1.5 ${destructive ? "bg-warning/15 text-warning" : "bg-accent/15 text-accent"}`}>
            {destructive ? <AlertTriangle size={18} /> : <PackageOpen size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="package-dialog-title" className="text-base font-semibold">{title}</h2>
            <div className="mt-2 text-sm text-muted">{children}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={destructive ? `${primaryButton} bg-warning text-black hover:bg-warning/80` : primaryButton}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  values,
  onChange,
}: {
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex h-8 rounded border border-border bg-surface p-0.5">
      {values.map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={value === item}
          className={`rounded px-2 text-xs capitalize ${value === item ? "bg-surface-overlay text-foreground" : "text-muted hover:text-foreground"}`}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function TypeBadge({ type }: { type: ResourceType }) {
  const colors: Record<ResourceType, string> = {
    extension: "bg-accent/15 text-accent",
    skill: "bg-success/15 text-success",
    prompt: "bg-warning/15 text-warning",
    theme: "bg-surface-overlay text-muted",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${colors[type]}`}>{type}</span>;
}

function packageMemberName(resource: ResourceRecord, pkg: PackageRecord): string {
  if (
    resource.type === "extension" &&
    /^(?:index|main)\.[cm]?[jt]sx?$/i.test(resource.name)
  ) {
    return `${pkg.displayName} extension`;
  }
  return resource.name;
}

type Preference = "inherit" | "enabled" | "disabled";
type PreferenceState = Preference | "mixed" | null;

function packagePreferenceState(
  resources: ResourceRecord[],
  mode: ResourceMode,
): PreferenceState {
  const preferences = new Set(
    resources
      .filter((resource) => canConfigureResource(resource, mode))
      .map((resource) => resourcePreference(resource, mode)),
  );
  if (preferences.size === 0) return null;
  if (preferences.size > 1) return "mixed";
  return preferences.values().next().value ?? null;
}

function PackagePreferenceControl({
  label,
  mode,
  state,
  disabled,
  onChange,
}: {
  label: string;
  mode: ResourceMode;
  state: PreferenceState;
  disabled: boolean;
  onChange: (preference: Preference) => void;
}) {
  const values: Preference[] = mode === "project"
    ? ["inherit", "enabled", "disabled"]
    : ["enabled", "disabled"];
  return (
    <div className="flex min-w-0 items-center gap-2">
      {state === "mixed" && <span className="text-[10px] text-warning">Mixed</span>}
      <div role="group" aria-label={label} className="inline-flex h-8 rounded border border-border p-0.5">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`${value} all resources in ${label}`}
            aria-pressed={state === value}
            className={`rounded px-2 text-[10px] capitalize ${state === value ? "bg-surface-overlay text-foreground" : "text-muted hover:text-foreground"}`}
            disabled={disabled || state === null}
            onClick={() => onChange(value)}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PackagesPage() {
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const packages = useAppStore((state) => state.packages);
  const packageProgress = useAppStore((state) => state.packageProgress);
  const packageRetry = useAppStore((state) => state.packageRetry);
  const setPackages = useAppStore((state) => state.applyPackageSnapshot);
  const applyPackageMutationResult = useAppStore((state) => state.applyPackageMutationResult);
  const setPackageRetry = useAppStore((state) => state.setPackageRetry);
  const pushNotification = useAppStore((state) => state.pushNotification);

  const [tab, setTab] = useState<"installed" | "resources">("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedScope, setInstalledScope] = useState<PackageScopeFilter>("all");
  const [installedType, setInstalledType] = useState<ResourceTypeFilter>("all");
  const [resourceQuery, setResourceQuery] = useState("");
  const [resourceMode, setResourceMode] = useState<ResourceMode>("user");
  const [resourceType, setResourceType] = useState<ResourceTypeFilter>("all");
  const [resourceOrigin, setResourceOrigin] = useState<ResourceOriginFilter>("all");
  const [resourceOwnerId, setResourceOwnerId] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const [pendingPreferenceUpdates, setPendingPreferenceUpdates] = useState<ResourcePreferenceUpdate[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [projectGate, setProjectGate] = useState<PendingProjectMutation | null>(null);
  const [review, setReview] = useState<MutationReview | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshRequest = useRef(0);

  const allPackages = packages?.configured ?? [];
  const allResources = useMemo(
    () => applyOptimisticResourcePreferences(packages?.resources ?? [], pendingPreferenceUpdates),
    [packages?.resources, pendingPreferenceUpdates],
  );
  const selected = allPackages.find((item) => item.id === selectedId);
  const installedFilters = { query: installedQuery, scope: installedScope, type: installedType };
  const visiblePackages = useMemo(
    () => filterInstalledPackages(allPackages, allResources, installedFilters),
    [allPackages, allResources, installedQuery, installedScope, installedType],
  );
  const resourceFilters = {
    query: resourceQuery,
    mode: resourceMode,
    type: resourceType,
    origin: resourceOrigin,
    packageId: resourceOwnerId || undefined,
  };
  const visibleResourceItems = useMemo(
    () => buildResourceListItems(allResources, allPackages, resourceFilters),
    [allResources, allPackages, resourceQuery, resourceMode, resourceType, resourceOrigin, resourceOwnerId],
  );
  const visiblePreferenceResources = useMemo(
    () => preferenceResourcesForListItems(visibleResourceItems),
    [visibleResourceItems],
  );
  const resourcesById = useMemo(() => new Map(allResources.map((item) => [item.id, item])), [allResources]);
  const selectedResources = selected
    ? filterResources(allResources, allPackages, {
        query: "",
        mode: selected.scope,
        type: "all",
        origin: "all",
        packageId: selected.id,
      })
    : [];
  const selectedPackageResources = selectedResources.filter(
    (resource) => resource.origin === "package" && resource.packageId === selected?.id,
  );

  const updateCheckSupported = host?.capabilities.packageUpdateCheck ?? false;
  const reloadRequired = packages?.resourceReloadRequired === true;
  const reconcileRequired = packages?.mutation?.reconcileRequired === true;
  const progressActive = packageProgress?.type === "start" || packageProgress?.type === "progress";
  const mutationRunning = packages?.mutation?.status === "running" || progressActive;
  const mutationBlocked = busy || mutationRunning || reloadRequired || reconcileRequired;
  const progressIdle = progressActive && now - (packageProgress?.lastEventAt ?? now) >= 15_000;

  async function refresh() {
    if (!host || !workspace?.servicesReady) return;
    const request = ++refreshRequest.current;
    const expected = {
      hostId: host.hostInstanceId,
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
    };
    setLoadState("loading");
    setLoadError("");
    try {
      const response = await hostClient.request(
        "package.list",
        workspaceContext(host, workspace),
        PACKAGE_LIST_PARAMS,
        60_000,
      );
      const current = useAppStore.getState();
      if (
        request !== refreshRequest.current ||
        current.host?.hostInstanceId !== expected.hostId ||
        current.workspace?.id !== expected.workspaceId ||
        current.workspace?.revision !== expected.workspaceRevision
      ) return;
      if (!response.ok) throw new Error(response.error?.message ?? "Could not load packages");
      setPackages(response.result);
      const nextHost = current.host && mergeHostIdentity(current.host, response);
      if (nextHost) current.setHost(nextHost);
      setLoadState("ready");
    } catch (error) {
      if (request !== refreshRequest.current) return;
      const message = error instanceof Error ? error.message : "Could not load packages";
      setLoadError(message);
      setLoadState("error");
    }
  }

  useEffect(() => {
    void refresh();
    // Package data is always loaded at all scope; controls below are local view filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId, workspace?.id, workspace?.revision]);

  useEffect(() => {
    if (!progressActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progressActive, packageProgress?.operationId]);

  useEffect(() => {
    if (!selectedId || allPackages.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
  }, [allPackages, selectedId]);

  useEffect(() => {
    setPendingPreferenceUpdates([]);
  }, [workspace?.id, workspace?.revision]);

  useEffect(() => {
    if (!projectGate) return;
    const reconciled = reconcileProjectGateAuthorization(host, workspace, projectGate);
    if (reconciled !== projectGate) setProjectGate(reconciled);
  }, [host, workspace, projectGate]);

  useEffect(() => {
    if (!review?.authorization) return;
    if (!isCurrentWorkspaceAuthorization(host, workspace, review.authorization)) setReview(null);
  }, [host, workspace, review]);

  function applyMutationResult(result: PackageMutationResult) {
    applyPackageMutationResult(result);
    if (result.status === "partialFailure" || result.reconcileRequired) {
      pushNotification(
        result.warnings.map((warning) => warning.message).filter(Boolean).join("; ") ||
          "Package operation partially failed; reconcile the package state before continuing",
        "warning",
      );
    } else if (result.status === "failed") {
      pushNotification(result.warnings[0]?.message ?? "Package operation failed", "error");
    }
  }

  function isProjectMutation<M extends MutationMethod>(method: M, params: HostRequestParams[M]): boolean {
    if (method === "package.install") return (params as HostRequestParams["package.install"]).scope === "project";
    if (method === "package.updateAll") return allPackages.some((item) => item.scope === "project");
    if (method === "package.remove" || method === "package.update") {
      const packageId = (params as HostRequestParams["package.remove"]).packageId;
      return allPackages.find((item) => item.id === packageId)?.scope === "project";
    }
    if (method === "resource.setPreference") {
      return (params as HostRequestParams["resource.setPreference"]).targetScope === "project";
    }
    if (method === "resource.setPreferences") {
      return (params as HostRequestParams["resource.setPreferences"]).updates.some(
        (update) => update.targetScope === "project",
      );
    }
    return false;
  }

  async function runMutation<M extends MutationMethod>(
    method: M,
    params: HostRequestParams[M],
    options?: { allowReconcileRetry?: boolean; projectAuthorization?: WorkspaceAuthorization },
  ) {
    if (!host || !workspace) return;
    if (isProjectMutation(method, params)) {
      if (!options?.projectAuthorization) {
        setProjectGate({
          method,
          params: params as HostRequestParams[MutationMethod],
          allowReconcileRetry: options?.allowReconcileRetry,
          authorization: captureWorkspaceAuthorization(host, workspace),
        });
        return;
      }
      if (!isCurrentWorkspaceAuthorization(
        useAppStore.getState().host,
        useAppStore.getState().workspace,
        options.projectAuthorization,
      )) {
        pushNotification("Project confirmation expired; review and confirm again", "warning");
        return;
      }
    }
    if ((reloadRequired || reconcileRequired) && method !== "package.reloadResources" && !options?.allowReconcileRetry) {
      pushNotification(
        reconcileRequired
          ? "Reload package state or retry the failed operation before another mutation"
          : "Reload package resources before starting another mutation",
        "warning",
      );
      return;
    }
    const generation = captureRequestGeneration(host);
    const optimisticUpdates = method === "resource.setPreference"
      ? [params as HostRequestParams["resource.setPreference"]]
      : method === "resource.setPreferences"
        ? (params as HostRequestParams["resource.setPreferences"]).updates
        : [];
    if (optimisticUpdates.length > 0) setPendingPreferenceUpdates(optimisticUpdates);
    setPackageRetry({ method, params: params as never });
    setBusy(true);
    try {
      const response = await hostClient.request(
        method,
        sessionPackageContext(host, workspace),
        params,
        method.startsWith("package.update") || method === "package.install" ? 600_000 : 60_000,
      );
      const current = useAppStore.getState();
      if (
        !isExpectedPackageMutationCompletion(current.host, generation, response) ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      ) return;
      if (!response.ok) throw new Error(response.error?.message ?? "Package operation failed");
      // The mutation result is authoritative; ignore any older package.list still in flight.
      refreshRequest.current += 1;
      setPendingPreferenceUpdates([]);
      applyMutationResult(response.result as PackageMutationResult);
      setLoadError("");
      setLoadState("ready");
      const currentHost = useAppStore.getState().host;
      const nextHost = currentHost && mergeHostIdentity(currentHost, response);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    } catch (error) {
      setPendingPreferenceUpdates([]);
      pushNotification(error instanceof Error ? error.message : "Package operation failed", "error");
    } finally {
      if (optimisticUpdates.length > 0) setPendingPreferenceUpdates([]);
      setBusy(false);
    }
  }

  function beginInstallReview() {
    if (!host || !workspace || !installSource.trim()) return;
    const params: HostRequestParams["package.install"] = {
      source: installSource.trim(),
      scope: installScope,
    };
    setReview({
      kind: "install",
      method: "package.install",
      params,
      packages: [],
      authorization: installScope === "project" ? captureWorkspaceAuthorization(host, workspace) : undefined,
    });
  }

  function beginUpdateReview(packageItems: PackageRecord[], updateAll = false) {
    if (!host || !workspace || !packageItems.length) return;
    const plan = planPackageUpdate(packageItems, updateAll);
    if (!plan) return;
    setReview({
      kind: "update",
      method: plan.method,
      params: plan.params,
      packages: plan.packages,
      authorization: plan.touchesProject
        ? captureWorkspaceAuthorization(host, workspace)
        : undefined,
    });
  }

  function confirmReview() {
    if (!review) return;
    if (
      review.authorization &&
      !isCurrentWorkspaceAuthorization(
        useAppStore.getState().host,
        useAppStore.getState().workspace,
        review.authorization,
      )
    ) {
      setReview(null);
      pushNotification("Project confirmation expired; review and confirm again", "warning");
      return;
    }
    const pending = review;
    setReview(null);
    if (pending.kind === "install") setInstallSource("");
    void runMutation(pending.method, pending.params as never, {
      projectAuthorization: pending.authorization,
    });
  }

  function confirmProjectMutation() {
    const pending = projectGate;
    if (!pending) return;
    if (!isCurrentWorkspaceAuthorization(
      useAppStore.getState().host,
      useAppStore.getState().workspace,
      pending.authorization,
    )) {
      setProjectGate(null);
      pushNotification("Project confirmation expired; review and confirm again", "warning");
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
      const response = await hostClient.request(
        "package.checkUpdates",
        workspaceContext(host, workspace),
        null,
        60_000,
      );
      const current = useAppStore.getState();
      if (
        current.host?.hostInstanceId !== host.hostInstanceId ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      ) return;
      if (!response.ok) throw new Error(response.error?.message ?? "Update check failed");
      const updateIds = new Set(response.result.updates.map((update) => update.packageId));
      if (current.packages?.workspaceId === workspace.id) {
        setPackages({
          ...current.packages,
          configured: current.packages.configured.map((item) => ({
            ...item,
            updateAvailable: updateIds.has(item.id),
          })),
          updateCheck: { supported: response.result.supported, checkedAt: Date.now() },
        });
      }
      pushNotification(
        response.result.supported === false
          ? "Update check is not supported by this host"
          : `${response.result.updates.length} update${response.result.updates.length === 1 ? "" : "s"} available`,
      );
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Update check failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function setResourcePreference(resource: ResourceRecord, preference: "inherit" | "enabled" | "disabled") {
    const update = buildResourcePreferenceUpdate(resource, resourceMode, preference);
    if (update) void runMutation("resource.setPreference", update);
  }

  function batchPreference(preference: "inherit" | "enabled" | "disabled") {
    const updates = buildResourcePreferenceUpdates(
      visiblePreferenceResources,
      resourceMode,
      preference,
    );
    if (updates.length) void runMutation("resource.setPreferences", { updates });
  }

  function setPackagePreference(
    resources: ResourceRecord[],
    mode: ResourceMode,
    preference: Preference,
  ) {
    const updates = buildResourcePreferenceUpdates(resources, mode, preference);
    if (updates.length) void runMutation("resource.setPreferences", { updates });
  }

  function clearResourceFilters() {
    setResourceQuery("");
    setResourceType("all");
    setResourceOrigin("all");
    setResourceOwnerId("");
  }

  function managePackageResources(packageId: string) {
    const pkg = allPackages.find((item) => item.id === packageId);
    setResourceOwnerId(packageId);
    setResourceMode(pkg?.scope === "user" && pkg.effective === false ? "user" : "project");
    setTab("resources");
  }

  function showResourceOwner(owner: ResourceRecord) {
    const ownerPackage = allPackages.find((item) => item.id === owner.packageId);
    setResourceOwnerId(owner.packageId ?? "");
    setResourceQuery(ownerPackage?.displayName ?? owner.name);
    setResourceType("extension");
  }

  async function openCatalog() {
    const url = "https://pi.dev/packages";
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function packageDiagnosticCount(item: PackageRecord): number {
    return (packages?.diagnostics ?? []).filter((diagnostic) =>
      diagnostic.source === item.id ||
      diagnostic.source === item.source ||
      diagnostic.source === item.identity,
    ).length;
  }

  function packageResourceTotal(item: PackageRecord): number | null {
    if (!item.resourceCounts) return null;
    return item.resourceCounts.extensions + item.resourceCounts.skills +
      item.resourceCounts.prompts + item.resourceCounts.themes;
  }

  function renderPackageResourceRow(item: PackageResourceListItem): ReactNode {
    const pkg = item.package;
    const summary = summarizeResources(item.resources);
    const preferenceState = packagePreferenceState(item.resources, resourceMode);
    const configurable = item.resources.filter((resource) =>
      canConfigureResource(resource, resourceMode)
    ).length;
    const diagnostics = item.resources.flatMap((resource) => resource.diagnostics);
    const activeLabel = summary.enabled === 0
      ? "Inactive"
      : summary.enabled === summary.total
        ? "Active"
        : `${summary.enabled}/${summary.total} active`;

    return (
      <li key={`package-resources:${item.id}`} className="grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Boxes size={14} className="text-accent" />
            <span className="truncate text-sm font-medium">{pkg.displayName}</span>
            {PACKAGE_RESOURCE_TYPES.map((type) => {
              const count = item.resources.filter((resource) => resource.type === type).length;
              return count > 0 ? (
                <span key={type} className="inline-flex items-center gap-1">
                  <TypeBadge type={type} />
                  {count > 1 && <span className="text-[10px] text-muted">{count}</span>}
                </span>
              ) : null;
            })}
            {diagnostics.some((diagnostic) => diagnostic.severity === "error") && <AlertTriangle size={13} className="text-danger" />}
          </div>
          {pkg.description && <p className="mt-1 text-xs text-muted">{pkg.description}</p>}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            <span>{scopeLabel(pkg.scope)} package / {pkg.kind}</span>
            {pkg.versionOrRef && <span>{pkg.versionOrRef}</span>}
            <span>{summary.total} resource{summary.total === 1 ? "" : "s"}</span>
          </div>
          <details className="mt-2 text-xs">
            <summary className="w-fit cursor-pointer select-none text-[10px] text-accent hover:underline">
              Show package resources
            </summary>
            <ul className="mt-2 divide-y divide-border border-y border-border">
              {item.resources.map((resource) => (
                <li key={resource.id} className="py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <TypeBadge type={resource.type} />
                    <span className="font-medium">{packageMemberName(resource, pkg)}</span>
                    {resource.type === "skill" && resource.manualOnly && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">Manual only</span>}
                    <span className={`ml-auto text-[10px] ${resource.enabled ? "text-success" : "text-muted"}`}>{resource.enabled ? "Active" : "Inactive"}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted" title={resource.path}>{resource.relativePath ?? resource.path}</p>
                  {resource.diagnostics.map((diagnostic, index) => (
                    <p key={`${diagnostic.message}-${index}`} className={`mt-1 text-[11px] ${diagnostic.severity === "error" ? "text-danger" : diagnostic.severity === "warning" ? "text-warning" : "text-muted"}`}>{diagnostic.message}</p>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        </div>
        <div className="flex min-w-40 self-start items-center justify-between gap-3 sm:justify-end">
          <span className={`text-[10px] ${summary.enabled > 0 ? "text-success" : "text-muted"}`}>{activeLabel}</span>
          {configurable > 0 ? (
            <PackagePreferenceControl
              label={`${pkg.displayName} package`}
              mode={resourceMode}
              state={preferenceState}
              disabled={mutationBlocked}
              onChange={(preference) => setPackagePreference(item.resources, resourceMode, preference)}
            />
          ) : (
            <span className="max-w-44 text-right text-[10px] text-muted">Read only</span>
          )}
        </div>
      </li>
    );
  }

  function renderResourceRow(resource: ResourceRecord): ReactNode {
    const owner = resource.control.kind === "owner-extension"
      ? resourcesById.get(resource.control.ownerResourceId)
      : undefined;
    const ownerPackage = allPackages.find(
      (item) => item.id === (resource.packageId ?? owner?.packageId),
    );
    const ownerLabel = owner
      ? ownerPackage ? packageMemberName(owner, ownerPackage) : owner.name
      : undefined;
    const configurable = canConfigureResource(resource, resourceMode);
    const preference = resourcePreference(resource, resourceMode);
    const readOnlyReason = resource.control.kind === "owner-extension"
      ? "Managed by extension"
      : resource.control.kind === "read-only" ? resource.control.reason : undefined;

    return (
      <li key={resource.id} className="grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={resource.type} />
            <span className="truncate text-sm font-medium">{resource.name}</span>
            {resource.type === "skill" && resource.manualOnly && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">Manual only</span>}
            {resource.diagnostics.some((item) => item.severity === "error") && <AlertTriangle size={13} className="text-danger" />}
          </div>
          {resource.description && <p className="mt-1 text-xs text-muted">{resource.description}</p>}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            <span>{scopeLabel(resource.scope)} / {resource.origin}</span>
            {ownerPackage && <span>Owner: {ownerPackage.displayName}</span>}
            {owner && (
              <button type="button" className="text-accent hover:underline" onClick={() => showResourceOwner(owner)}>
                Provided by {ownerLabel}
              </button>
            )}
            <span className="max-w-full truncate font-mono" title={resource.path}>{resource.relativePath ?? resource.path}</span>
          </div>
          {resource.diagnostics.length > 0 && (
            <ul className="mt-2 space-y-1">
              {resource.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.message}-${index}`} className={`text-[11px] ${diagnostic.severity === "error" ? "text-danger" : diagnostic.severity === "warning" ? "text-warning" : "text-muted"}`}>{diagnostic.message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-40 items-center justify-between gap-3 sm:justify-end">
          <span className={`text-[10px] ${resource.enabled ? "text-success" : "text-muted"}`}>{resource.enabled ? "Active" : "Inactive"}</span>
          {configurable ? (
            <div className="inline-flex h-8 rounded border border-border p-0.5">
              {(resourceMode === "project" ? ["inherit", "enabled", "disabled"] : ["enabled", "disabled"]).map((value) => (
                <button key={value} type="button" title={`${value} in ${resourceMode} scope`} className={`rounded px-2 text-[10px] capitalize ${preference === value ? "bg-surface-overlay text-foreground" : "text-muted hover:text-foreground"}`} disabled={mutationBlocked} onClick={() => setResourcePreference(resource, value as "inherit" | "enabled" | "disabled")}>{value}</button>
              ))}
            </div>
          ) : (
            <span className="max-w-44 text-right text-[10px] text-muted" title={readOnlyReason}>{readOnlyReason ?? "Read only"}</span>
          )}
        </div>
      </li>
    );
  }

  if (!workspace?.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
        Select and prepare a workspace to manage packages.
      </div>
    );
  }

  const configurableVisible = visiblePreferenceResources.filter((item) => canConfigureResource(item, resourceMode));
  const resourceSections = [
    {
      key: "packages",
      label: "Packages",
      items: visibleResourceItems.filter((item) => item.kind === "package"),
    },
    {
      key: "standalone",
      label: "Standalone",
      items: visibleResourceItems.filter((item) => item.kind === "resource" && item.resource.origin === "top-level" && item.resource.scope !== "temporary"),
    },
    {
      key: "runtime",
      label: "Runtime",
      items: visibleResourceItems.filter((item) => item.kind === "resource" && (item.resource.scope === "temporary" || item.resource.origin === "extension")),
    },
    {
      key: "other",
      label: "Other",
      items: visibleResourceItems.filter((item) => item.kind === "resource" && item.resource.origin !== "top-level" && item.resource.scope !== "temporary" && item.resource.origin !== "extension"),
    },
  ].filter((section) => section.items.length > 0);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-surface"
      aria-busy={pendingPreferenceUpdates.length > 0 || undefined}
    >
      {review && (
        <Dialog
          title={review.kind === "install" ? "Review package install" : "Review package update"}
          confirmLabel={review.kind === "install" ? "Install package" : review.method === "package.updateAll" ? "Update all" : "Update package"}
          destructive={review.kind === "update"}
          onCancel={() => setReview(null)}
          onConfirm={confirmReview}
        >
          {review.kind === "install" ? (
            <>
              <p>Packages can execute local code, including dependency lifecycle scripts. Extensions run with your current-user permissions. Skills and Prompts may direct Agent actions. Continue only if you trust this source.</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded border border-border bg-surface p-3 text-xs">
                <dt>Source</dt><dd className="break-all font-mono text-foreground">{(review.params as HostRequestParams["package.install"]).source}</dd>
                <dt>Scope</dt><dd className="capitalize text-foreground">{(review.params as HostRequestParams["package.install"]).scope}</dd>
              </dl>
              {review.authorization && <p className="mt-3 text-warning">This changes project settings for the current workspace.</p>}
            </>
          ) : (
            <>
              <p>Updates may change executable code and Agent instructions. Review the affected packages before continuing.</p>
              <ul className="mt-3 max-h-40 overflow-auto rounded border border-border bg-surface p-2 text-xs text-foreground">
                {review.packages.map((item) => <li key={item.id} className="flex justify-between gap-3 px-1 py-1"><span className="truncate">{item.displayName}</span><span className="shrink-0 text-muted">{item.versionOrRef ?? item.scope}</span></li>)}
              </ul>
              {review.authorization && <p className="mt-3 text-warning">This includes project packages in the current workspace.</p>}
            </>
          )}
        </Dialog>
      )}

      {projectGate && (
        <Dialog
          title="Confirm project resource change"
          confirmLabel="Apply change"
          onCancel={() => setProjectGate(null)}
          onConfirm={confirmProjectMutation}
        >
          <p>This changes package or resource preferences for the current workspace. The confirmation is tied to its current session and package generation.</p>
        </Dialog>
      )}

      {packageProgress && pendingPreferenceUpdates.length === 0 && (
        <div className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs">
          <RefreshCw size={13} className={progressActive ? "animate-spin" : ""} />
          <span className="font-medium capitalize">{packageProgress.action}</span>
          <span className="min-w-0 flex-1 truncate text-muted" title={packageProgress.source}>{packageProgress.message ?? packageProgress.source}</span>
          <span className={packageProgress.type === "error" ? "text-danger" : "text-muted"}>{progressIdle ? "Still waiting" : packageProgress.type}</span>
        </div>
      )}

      {pendingPreferenceUpdates.length > 0 && (
        <div
          className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs"
          role="status"
          aria-live="polite"
        >
          <RefreshCw size={13} className="animate-spin" />
          <span className="font-medium">Applying resource preferences</span>
          <span className="min-w-0 flex-1 truncate text-muted">
            Reloading Agent resources for {pendingPreferenceUpdates.length} change{pendingPreferenceUpdates.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {reconcileRequired && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs">
          <AlertTriangle size={14} className="text-warning" />
          <span className="min-w-48 flex-1 text-warning">The previous operation partially changed package state. Reload the authoritative state or retry it.</span>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void refresh()}>Reload state</button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !packageRetry}
            onClick={() => packageRetry && void runMutation(packageRetry.method as MutationMethod, packageRetry.params as never, { allowReconcileRetry: true })}
          >Retry operation</button>
        </div>
      )}

      {reloadRequired && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs">
          <span className="min-w-48 flex-1 text-warning">Session resources changed and must reload before the next prompt.</span>
          <button type="button" className={primaryButton} disabled={busy} onClick={() => void runMutation("package.reloadResources", null)}>Reload resources</button>
        </div>
      )}

      {loadState === "error" && packages && (
        <div className="flex flex-wrap items-center gap-2 border-b border-danger/35 bg-danger/10 px-4 py-2 text-xs">
          <AlertTriangle size={14} className="text-danger" />
          <span className="min-w-48 flex-1 text-danger">Refresh failed: {loadError}</span>
          <button type="button" className={secondaryButton} onClick={() => void refresh()}>
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      )}

      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <h1 className="mr-2 text-sm font-semibold">Packages</h1>
        <div role="tablist" className="flex h-8 rounded border border-border bg-surface p-0.5">
          <button role="tab" aria-selected={tab === "installed"} type="button" className={`rounded px-3 text-xs ${tab === "installed" ? "bg-surface-overlay" : "text-muted"}`} onClick={() => setTab("installed")}>Installed</button>
          <button role="tab" aria-selected={tab === "resources"} type="button" className={`rounded px-3 text-xs ${tab === "resources" ? "bg-surface-overlay" : "text-muted"}`} onClick={() => setTab("resources")}>Resources</button>
        </div>
        <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent" onClick={() => void openCatalog()}>pi.dev catalog <ExternalLink size={11} /></button>
        <div className="ml-auto flex items-center gap-1">
          {updateCheckSupported && <button type="button" title="Check for updates" className={secondaryButton} disabled={busy} onClick={() => void checkUpdates()}><RefreshCw size={14} /><span className="hidden sm:inline">Check</span></button>}
          <button type="button" title="Refresh packages" className={secondaryButton} disabled={loadState === "loading" || busy || mutationRunning} onClick={() => void refresh()}><RefreshCw size={14} className={loadState === "loading" ? "animate-spin" : ""} /></button>
          <button type="button" className={primaryButton} disabled={mutationBlocked || allPackages.length === 0} onClick={() => beginUpdateReview(allPackages, true)}><Download size={14} /><span className="hidden sm:inline">Update all</span></button>
        </div>
      </header>

      {loadState === "error" && !packages ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle size={24} className="text-danger" />
          <div><p className="text-sm font-medium">Packages could not be loaded</p><p className="mt-1 max-w-lg text-xs text-muted">{loadError}</p></div>
          <button type="button" className={secondaryButton} onClick={() => void refresh()}><RefreshCw size={13} />Try again</button>
        </div>
      ) : tab === "installed" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(280px,34%)_minmax(0,1fr)] md:overflow-hidden">
          <aside className="flex min-h-[300px] flex-col border-b border-border md:min-h-0 md:border-b-0 md:border-r">
            <div className="border-b border-border p-3">
              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
                <input className={`${inputClass} flex-1`} aria-label="Package source" placeholder="npm:package, git URL, or local path" value={installSource} onChange={(event) => setInstallSource(event.target.value)} />
                <div className="flex gap-2">
                  <select className={inputClass} aria-label="Install scope" value={installScope} onChange={(event) => setInstallScope(event.target.value as "user" | "project")}><option value="user">User</option><option value="project">Project</option></select>
                  <button type="button" className={primaryButton} disabled={mutationBlocked || !installSource.trim()} onClick={beginInstallReview}>Review</button>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-border p-3">
              <label className="relative min-w-40 flex-1"><Search size={13} className="pointer-events-none absolute left-2 top-2.5 text-muted" /><input aria-label="Search installed packages" className={`${inputClass} w-full pl-7`} placeholder="Search installed" value={installedQuery} onChange={(event) => setInstalledQuery(event.target.value)} /></label>
              <select aria-label="Package scope" className={inputClass} value={installedScope} onChange={(event) => setInstalledScope(event.target.value as PackageScopeFilter)}><option value="all">All scopes</option><option value="user">User</option><option value="project">Project</option></select>
              <select aria-label="Contained resource type" className={inputClass} value={installedType} onChange={(event) => setInstalledType(event.target.value as ResourceTypeFilter)}><option value="all">Contains any</option>{PACKAGE_RESOURCE_TYPES.map((type) => <option key={type} value={type}>Contains {type}</option>)}</select>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {loadState === "loading" && !packages && <div className="flex items-center gap-2 p-3 text-xs text-muted"><RefreshCw size={13} className="animate-spin" />Loading installed packages</div>}
              {loadState !== "loading" && visiblePackages.length === 0 && (
                <div className="p-4 text-center text-xs text-muted">
                  <PackageOpen size={24} className="mx-auto mb-2 opacity-50" />
                  <p>{hasActiveInstalledFilters(installedFilters) ? "No installed packages match these filters." : "No packages are installed yet."}</p>
                  {hasActiveInstalledFilters(installedFilters) && (
                    <button type="button" className={`${secondaryButton} mt-3`} onClick={() => { setInstalledQuery(""); setInstalledScope("all"); setInstalledType("all"); }}>
                      <X size={13} /> Clear filters
                    </button>
                  )}
                </div>
              )}
              <ul>
                {visiblePackages.map((item) => (
                  <li key={item.id}>
                    <button type="button" className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left hover:bg-surface-overlay ${selectedId === item.id ? "bg-accent/10" : ""}`} onClick={() => setSelectedId(item.id)}>
                      <Boxes size={15} className={selectedId === item.id ? "text-accent" : "text-muted"} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5"><span className="truncate text-xs font-medium">{item.displayName}</span>{item.updateAvailable && <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">Update</span>}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted">{scopeLabel(item.scope)} / {item.kind}{item.versionOrRef ? ` / ${item.versionOrRef}` : ""}{!item.effective ? " / Replaced by project" : item.projectOverride || item.overridesPackageId ? " / Workspace overrides" : ""}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted"><span>{packageResourceTotal(item) ?? "?"} resources</span>{packageDiagnosticCount(item) > 0 && <span className="inline-flex items-center gap-0.5 text-warning"><AlertTriangle size={10} />{packageDiagnosticCount(item)} diagnostic{packageDiagnosticCount(item) === 1 ? "" : "s"}</span>}</span>
                      </span>
                      <ChevronRight size={13} className="text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <main className="min-h-[360px] min-w-0 overflow-auto p-4 md:min-h-0 lg:p-5">
            {!selected ? (
              <div className="flex h-full min-h-64 flex-col items-center justify-center text-center text-muted"><PackageOpen size={30} className="mb-3 opacity-40" /><p className="text-sm">Select an installed package</p><p className="mt-1 text-xs">Metadata, relationships, and resource controls appear here.</p></div>
            ) : (
              <div className="mx-auto max-w-4xl">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{selected.displayName}</h2><span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] uppercase text-muted">{scopeLabel(selected.scope)}</span>{!selected.effective && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">Replaced by project</span>}</div>{selected.description && <p className="mt-1 text-sm text-muted">{selected.description}</p>}</div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={secondaryButton} disabled={mutationBlocked} onClick={() => beginUpdateReview([selected])}><Download size={13} />Update</button>
                    {selected.installedPath && <button type="button" className={secondaryButton} onClick={async () => { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("desktop_open_path", { path: selected.installedPath }); } catch { pushNotification("Open folder unavailable", "warning"); } }}><FolderOpen size={13} />Open</button>}
                    <button type="button" className={`${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`} disabled={mutationBlocked} onClick={() => { if (confirm(`Remove ${selected.displayName}?`)) void runMutation("package.remove", { packageId: selected.id }); }}><Trash2 size={13} />Remove</button>
                  </div>
                </div>

                <section className="mt-5 border-t border-border pt-4">
                  <h3 className="text-xs font-semibold uppercase text-muted">Package details</h3>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                    <div><dt className="text-muted">Source</dt><dd className="mt-0.5 break-all font-mono">{selected.source}</dd></div>
                    <div><dt className="text-muted">Identity</dt><dd className="mt-0.5 break-all font-mono">{selected.identity}</dd></div>
                    <div><dt className="text-muted">Type and version</dt><dd className="mt-0.5">{selected.kind}{selected.versionOrRef ? ` / ${selected.versionOrRef}` : ""}</dd></div>
                    <div><dt className="text-muted">Installed path</dt><dd className="mt-0.5 break-all font-mono">{selected.installedPath ?? "Managed by Pi"}</dd></div>
                  </dl>
                </section>

                {(selected.shadowedByPackageId || selected.overridesPackageId || selected.projectOverride) && (
                  <section className="mt-5 border-t border-border pt-4"><h3 className="text-xs font-semibold uppercase text-muted">Relationships</h3><div className="mt-2 rounded border border-border bg-surface-raised p-3 text-xs">{selected.shadowedByPackageId && <p><span className="text-muted">Replaced by project: </span>{allPackages.find((item) => item.id === selected.shadowedByPackageId)?.displayName ?? selected.shadowedByPackageId}</p>}{selected.overridesPackageId && <p><span className="text-muted">Overrides user package: </span>{allPackages.find((item) => item.id === selected.overridesPackageId)?.displayName ?? selected.overridesPackageId}</p>}{selected.projectOverride && <p><span className="text-muted">Workspace overrides: </span>{selected.projectOverride.source} / {selected.projectOverride.overrideCount} change{selected.projectOverride.overrideCount === 1 ? "" : "s"}</p>}</div></section>
                )}

                <section className="mt-5 border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase text-muted">Package resources</h3>
                      <p className="mt-1 text-xs text-muted">{selected.resourceCountsState === "unknownShadowed" && selectedPackageResources.length === 0 ? "Counts are unavailable because this package is replaced by the project." : `${summarizeResources(selectedPackageResources).enabled} enabled / ${summarizeResources(selectedPackageResources).disabled} disabled`}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <PackagePreferenceControl
                        label={`${selected.displayName} package`}
                        mode={selected.scope}
                        state={packagePreferenceState(selectedPackageResources, selected.scope)}
                        disabled={mutationBlocked}
                        onChange={(preference) => setPackagePreference(selectedPackageResources, selected.scope, preference)}
                      />
                      <button type="button" className={secondaryButton} onClick={() => managePackageResources(selected.id)}><Settings2 size={13} />Manage resources</button>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {PACKAGE_RESOURCE_TYPES.map((type) => {
                      const resources = selectedPackageResources.filter((resource) => resource.type === type);
                      const enabled = resources.filter((resource) => resource.enabled).length;
                      const state = resources.length === 0
                        ? "None"
                        : enabled === 0 ? "Disabled"
                        : enabled === resources.length ? "Enabled" : "Mixed";
                      return (
                        <div
                          key={type}
                          className="flex min-h-14 flex-col items-stretch justify-center rounded border border-border px-2 py-1.5 text-left text-xs"
                        >
                          <span className="flex items-center justify-between gap-2"><span>{pluralType(type)}</span><span className="font-mono text-muted">{enabled}/{resources.length}</span></span>
                          <span className="mt-0.5 text-[10px] text-muted">{state}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <Segmented value={resourceMode} values={["user", "project"] as const} onChange={setResourceMode} />
            <label className="relative min-w-48 flex-1 sm:max-w-sm"><Search size={13} className="pointer-events-none absolute left-2 top-2.5 text-muted" /><input aria-label="Search resources" className={`${inputClass} w-full pl-7`} placeholder="Search resources" value={resourceQuery} onChange={(event) => setResourceQuery(event.target.value)} /></label>
            <select aria-label="Resource source" className={inputClass} value={resourceOrigin} onChange={(event) => setResourceOrigin(event.target.value as ResourceOriginFilter)}><option value="all">All</option><option value="package">Package</option><option value="standalone">Standalone</option><option value="runtime">Runtime</option></select>
            <div className="flex min-w-0 items-center gap-1">
              <select aria-label="Resource owner" className={`${inputClass} max-w-52`} value={resourceOwnerId} onChange={(event) => setResourceOwnerId(event.target.value)}><option value="">All owners</option>{allPackages.map((item) => <option key={item.id} value={item.id}>{item.displayName} ({item.scope})</option>)}</select>
              {resourceOwnerId && <button type="button" title="Clear owner filter" aria-label="Clear owner filter" className={secondaryButton} onClick={() => setResourceOwnerId("")}><X size={13} /></button>}
            </div>
            {hasActiveResourceFilters(resourceFilters) && <button type="button" title="Clear all resource filters" aria-label="Clear all resource filters" className={secondaryButton} onClick={clearResourceFilters}><X size={13} /></button>}
          </div>
          <div role="tablist" aria-label="Resource type" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
            {(["all", ...PACKAGE_RESOURCE_TYPES] as ResourceTypeFilter[]).map((type) => (
              <button
                key={type}
                role="tab"
                aria-selected={resourceType === type}
                type="button"
                className={`h-7 shrink-0 rounded px-2.5 text-xs ${resourceType === type ? "bg-surface-overlay text-foreground" : "text-muted hover:text-foreground"}`}
                onClick={() => setResourceType(type)}
              >
                {type === "all" ? "All" : pluralType(type)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2 text-xs">
            <span className="text-muted">{visibleResourceItems.length} shown / {visiblePreferenceResources.length} resources / {configurableVisible.length} configurable</span>
            <span className="ml-auto text-muted">Set shown items:</span>
            {resourceMode === "project" && <button type="button" title="Inherit all resources in shown packages and shown standalone items" className={secondaryButton} disabled={mutationBlocked || !configurableVisible.length} onClick={() => batchPreference("inherit")}>Inherit</button>}
            <button type="button" title="Enable all resources in shown packages and shown standalone items" className={secondaryButton} disabled={mutationBlocked || !configurableVisible.length} onClick={() => batchPreference("enabled")}><Check size={13} />Enable</button>
            <button type="button" title="Disable all resources in shown packages and shown standalone items" className={secondaryButton} disabled={mutationBlocked || !configurableVisible.length} onClick={() => batchPreference("disabled")}><X size={13} />Disable</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loadState === "loading" && !packages ? (
              <div className="flex h-full min-h-64 items-center justify-center gap-2 p-8 text-xs text-muted"><RefreshCw size={13} className="animate-spin" />Loading resources</div>
            ) : visibleResourceItems.length === 0 ? (
              <div className="flex h-full min-h-64 flex-col items-center justify-center p-8 text-center text-muted">
                <Settings2 size={28} className="mb-3 opacity-40" />
                <p className="text-sm">
                  {allResources.length === 0
                    ? "No resources are available yet."
                    : hasActiveResourceFilters(resourceFilters)
                      ? "No resources match these filters."
                      : `No resources are available in ${resourceMode === "user" ? "User" : "Project"} mode.`}
                </p>
                <p className="mt-1 text-xs">
                  {allResources.length === 0
                    ? "Install a package or add a standalone Pi resource to populate this view."
                    : "Adjust the mode or filters to see other resources."}
                </p>
                {hasActiveResourceFilters(resourceFilters) && (
                  <button type="button" className={`${secondaryButton} mt-3`} onClick={clearResourceFilters}>
                    <X size={13} /> Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div>
                {resourceSections.map((section) => (
                    <section key={section.key} aria-labelledby={`resource-group-${section.key}`}>
                      <h3 id={`resource-group-${section.key}`} className="sticky top-0 z-10 border-y border-border bg-surface-raised px-4 py-1.5 text-[10px] font-semibold uppercase text-muted">{section.label} <span className="font-normal">({section.items.length})</span></h3>
                      <ul className="divide-y divide-border">
                        {section.items.map((item) => item.kind === "package"
                          ? renderPackageResourceRow(item)
                          : renderResourceRow(item.resource))}
                      </ul>
                    </section>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
