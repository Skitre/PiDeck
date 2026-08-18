import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Github,
  PackageOpen,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { SectionHeader } from "../../components/SectionHeader";
import type {
  HostRequestParams,
  PackageCatalog,
  PackageCatalogItem,
  PackageMutationResult,
  PackageRecord,
  ResourceRecord,
  ResourcePreferenceUpdate,
  ResourceType,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import {
  captureRequestGeneration,
  hostContext,
  isExpectedPackageMutationCompletion,
  mergeHostIdentity,
  sessionPackageContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { useLocale, useT, type Translate } from "../../lib/i18n/use-t";
import {
  PACKAGE_RESOURCE_TYPES,
  PACKAGE_LIST_PARAMS,
  applyOptimisticResourcePreferences,
  buildResourcePreferenceUpdate,
  buildResourcePreferenceUpdates,
  canConfigureResource,
  catalogPageRange,
  filterInstalledPackages,
  filterResources,
  formatCatalogPublishedAt,
  formatDownloadsPerMonth,
  hasActiveInstalledFilters,
  isCatalogItemInstalled,
  planPackageUpdate,
  resourcePreference,
  summarizeResources,
  type CatalogSort,
  type ResourceMode,
  type ResourceTypeFilter,
} from "./packages-model";

type MutationMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.reloadResources"
  | "resource.setPreference"
  | "resource.setPreferences";

type MutationReview = {
  kind: "install" | "update" | "remove";
  method: "package.install" | "package.update" | "package.updateAll" | "package.remove";
  params:
    | HostRequestParams["package.install"]
    | HostRequestParams["package.update"]
    | HostRequestParams["package.updateAll"]
    | HostRequestParams["package.remove"];
  packages: PackageRecord[];
};

type LoadState = "idle" | "loading" | "ready" | "error";

// Host deadline (10m) plus cancellation/reconcile grace and transport margin.
const PACKAGE_MUTATION_REQUEST_TIMEOUT_MS = 615_000;
const PACKAGE_LIST_BUSY_RETRY_INITIAL_MS = 250;
const PACKAGE_LIST_BUSY_RETRY_MAX_MS = 2_000;

const inputClass =
  "box-border h-8 min-h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-focus";

function scopeLabel(t: Translate, scope: PackageRecord["scope"] | ResourceRecord["scope"]): string {
  return scope === "temporary"
    ? t("packagesScopeRuntime")
    : scope === "project"
      ? t("packagesScopeProject")
      : t("packagesScopeUser");
}

function pluralType(t: Translate, type: ResourceType): string {
  return type === "extension"
    ? t("typeExtensions")
    : type === "skill"
      ? t("typeSkills")
      : type === "prompt"
        ? t("typePrompts")
        : t("typeThemes");
}

function singularType(t: Translate, type: ResourceType): string {
  return type === "extension"
    ? t("typeExtension")
    : type === "skill"
      ? t("typeSkill")
      : type === "prompt"
        ? t("typePrompt")
        : t("typeTheme");
}

function isResourceType(type: string): type is ResourceType {
  return (PACKAGE_RESOURCE_TYPES as readonly string[]).includes(type);
}

function TypeBadge({ type }: { type: string }) {
  const t = useT();
  if (!isResourceType(type)) {
    return (
      <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] font-medium text-muted">
        {type}
      </span>
    );
  }
  const colors: Record<ResourceType, string> = {
    extension: "bg-accent/15 text-accent",
    skill: "bg-success/15 text-success",
    prompt: "bg-warning/15 text-warning",
    theme: "bg-surface-overlay text-muted",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${colors[type]}`}>
      {singularType(t, type)}
    </span>
  );
}

function packageMemberName(t: Translate, resource: ResourceRecord, pkg: PackageRecord): string {
  if (resource.type === "extension" && /^(?:index|main)\.[cm]?[jt]sx?$/i.test(resource.name)) {
    return t("packagesExtensionSuffix", { name: pkg.displayName });
  }
  return resource.name;
}

type Preference = "inherit" | "enabled" | "disabled";
type PreferenceState = Preference | "mixed" | null;

function preferenceLabel(t: Translate, value: Preference): string {
  return value === "inherit"
    ? t("packagesPrefInherit")
    : value === "enabled"
      ? t("packagesPrefEnabled")
      : t("packagesPrefDisabled");
}

function packagePreferenceState(resources: ResourceRecord[], mode: ResourceMode): PreferenceState {
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
  const t = useT();
  const values: Preference[] =
    mode === "project" ? ["inherit", "enabled", "disabled"] : ["enabled", "disabled"];
  return (
    <div className="flex min-w-0 items-center gap-2">
      {state === "mixed" && (
        <span className="text-[11px] text-warning">{t("packagesStateMixed")}</span>
      )}
      <div
        role="group"
        aria-label={label}
        data-ui="segmented"
        className="inline-flex h-8 rounded-md border border-border p-0.5"
      >
        {values.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={t("packagesPrefAria", { value: preferenceLabel(t, value), label })}
            aria-pressed={state === value}
            data-ui="segmented-item"
            data-state={state === value ? "active" : "inactive"}
            className={`rounded px-2 text-xs capitalize ${state === value ? "bg-selection text-selection-foreground" : "text-muted hover:text-foreground"}`}
            disabled={disabled || state === null}
            onClick={() => onChange(value)}
          >
            {preferenceLabel(t, value)}
          </button>
        ))}
      </div>
    </div>
  );
}

const MARKET_CATALOG_TIMEOUT_MS = 30_000;
const MARKET_QUERY_DEBOUNCE_MS = 300;

function MarketPackageCard({
  item,
  installed,
  locale,
  t,
  mutationBlocked,
  onOpen,
  onInstall,
}: {
  item: PackageCatalogItem;
  installed: boolean;
  locale: "en" | "zh";
  t: Translate;
  mutationBlocked: boolean;
  onOpen: (url: string) => void;
  onInstall: (item: PackageCatalogItem) => void;
}) {
  return (
    <article
      data-market-card={item.name}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-[13px] font-semibold">
          <button
            type="button"
            className="min-w-0 truncate text-left hover:underline"
            title={t("packagesMarketOpenPage", { name: item.name })}
            aria-label={t("packagesMarketOpenPage", { name: item.name })}
            onClick={() => onOpen(item.pageUrl)}
          >
            {item.name}
          </button>
        </h3>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {item.types.map((type) => (
            <TypeBadge key={type} type={type} />
          ))}
        </div>
      </div>
      <p className="line-clamp-2 min-h-10 text-xs leading-5 text-muted" title={item.description}>
        {item.description}
      </p>
      <div className="mt-auto flex items-center gap-2 text-[11px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {item.author && (
            <span className="min-w-0 truncate" title={item.author}>
              {item.author}
            </span>
          )}
          {item.downloadsPerMonth !== undefined && (
            <span className="shrink-0 tabular-nums">
              {t("packagesMarketDownloads", {
                count: formatDownloadsPerMonth(item.downloadsPerMonth),
              })}
            </span>
          )}
          {item.publishedAt !== undefined && (
            <span
              className="shrink-0 tabular-nums"
              title={t("packagesMarketPublished", {
                date: formatCatalogPublishedAt(item.publishedAt, locale),
              })}
            >
              {formatCatalogPublishedAt(item.publishedAt, locale)}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {item.githubUrl && (
            <button
              type="button"
              className="text-muted hover:text-foreground"
              title={t("packagesMarketOpenGithub", { name: item.name })}
              aria-label={t("packagesMarketOpenGithub", { name: item.name })}
              onClick={() => onOpen(item.githubUrl!)}
            >
              <Github size={12} />
            </button>
          )}
          {item.npmUrl && (
            <button
              type="button"
              className="text-muted hover:text-foreground"
              title={t("packagesMarketOpenNpm", { name: item.name })}
              aria-label={t("packagesMarketOpenNpm", { name: item.name })}
              onClick={() => onOpen(item.npmUrl!)}
            >
              <ExternalLink size={12} />
            </button>
          )}
          {installed ? (
            <span className="inline-flex items-center gap-1 text-success">
              <Check size={12} />
              {t("packagesMarketInstalled")}
            </span>
          ) : (
            <button
              type="button"
              className={primaryButton}
              disabled={mutationBlocked}
              onClick={() => onInstall(item)}
            >
              <Download size={13} />
              {t("packagesInstallAction")}
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

function MarketCatalogGrid({
  items,
  allPackages,
  locale,
  t,
  mutationBlocked,
  onOpen,
  onInstall,
}: {
  items: PackageCatalogItem[];
  allPackages: PackageRecord[];
  locale: "en" | "zh";
  t: Translate;
  mutationBlocked: boolean;
  onOpen: (url: string) => void;
  onInstall: (item: PackageCatalogItem) => void;
}) {
  return (
    <div className="scrollbar-auto-hide grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 lg:grid-cols-2 2xl:grid-cols-3">
      {items.map((item) => (
        <MarketPackageCard
          key={item.name}
          item={item}
          installed={isCatalogItemInstalled(item, allPackages)}
          locale={locale}
          t={t}
          mutationBlocked={mutationBlocked}
          onOpen={onOpen}
          onInstall={onInstall}
        />
      ))}
    </div>
  );
}

export function PackagesPage() {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const packages = useAppStore((state) => state.packages);
  const packageProgress = useAppStore((state) => state.packageProgress);
  const packageRetry = useAppStore((state) => state.packageRetry);
  const setPackages = useAppStore((state) => state.applyPackageSnapshot);
  const applyPackageMutationResult = useAppStore((state) => state.applyPackageMutationResult);
  const setPackageRetry = useAppStore((state) => state.setPackageRetry);
  const pushNotification = useAppStore((state) => state.pushNotification);

  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedType, setInstalledType] = useState<ResourceTypeFilter>("all");
  const [installSource, setInstallSource] = useState("");
  const [marketCatalog, setMarketCatalog] = useState<PackageCatalog | null>(null);
  const [marketState, setMarketState] = useState<LoadState>("idle");
  const [marketError, setMarketError] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketType, setMarketType] = useState<ResourceTypeFilter>("all");
  const [marketSort, setMarketSort] = useState<CatalogSort>("downloads");
  const marketRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [pendingPreferenceUpdates, setPendingPreferenceUpdates] = useState<
    ResourcePreferenceUpdate[]
  >([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [review, setReview] = useState<MutationReview | null>(null);
  const [dismissedProgressOp, setDismissedProgressOp] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshRequest = useRef(0);

  const allPackages = useMemo(() => packages?.configured ?? [], [packages?.configured]);
  const allResources = useMemo(
    () => applyOptimisticResourcePreferences(packages?.resources ?? [], pendingPreferenceUpdates),
    [packages?.resources, pendingPreferenceUpdates],
  );
  const selected = allPackages.find((item) => item.id === selectedId);
  const installedFilters = useMemo(
    () => ({ query: installedQuery, scope: "all" as const, type: installedType }),
    [installedQuery, installedType],
  );
  const visiblePackages = useMemo(
    () => filterInstalledPackages(allPackages, allResources, installedFilters),
    [allPackages, allResources, installedFilters],
  );
  const visibleMarketItems = marketCatalog?.items ?? [];
  const marketRange = marketCatalog ? catalogPageRange(marketCatalog) : null;
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
  const knownUpdates = allPackages.filter((item) => item.updateAvailable).length;
  const updateCheckDone = updateCheckSupported && packages?.updateCheck?.checkedAt !== undefined;
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
    const isCurrentRequest = () => {
      const current = useAppStore.getState();
      return (
        request === refreshRequest.current &&
        current.host?.hostInstanceId === expected.hostId &&
        current.workspace?.id === expected.workspaceId &&
        current.workspace?.revision === expected.workspaceRevision
      );
    };
    setLoadState("loading");
    setLoadError("");
    try {
      const requestList = () =>
        hostClient.request(
          "package.list",
          workspaceContext(host, workspace),
          PACKAGE_LIST_PARAMS,
          60_000,
        );
      const retryDeadline = Date.now() + PACKAGE_MUTATION_REQUEST_TIMEOUT_MS;
      let retryDelay = PACKAGE_LIST_BUSY_RETRY_INITIAL_MS;
      let response = await requestList();
      while (
        !response.ok &&
        response.error?.code === "SERVICE_GRAPH_BUSY" &&
        response.error.retryable === true &&
        Date.now() < retryDeadline
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        if (!isCurrentRequest()) return;
        retryDelay = Math.min(retryDelay * 2, PACKAGE_LIST_BUSY_RETRY_MAX_MS);
        response = await requestList();
      }
      const current = useAppStore.getState();
      if (!isCurrentRequest()) return;
      if (!response.ok) throw new Error(response.error?.message ?? t("notifPackagesLoadFailed"));
      setPackages(response.result);
      const nextHost = current.host && mergeHostIdentity(current.host, response);
      if (nextHost) current.setHost(nextHost);
      setLoadState("ready");
    } catch (error) {
      if (request !== refreshRequest.current) return;
      const message = error instanceof Error ? error.message : t("notifPackagesLoadFailed");
      setLoadError(message);
      setLoadState("error");
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      refreshRequest.current += 1;
    };
    // Package data is always loaded at all scope; controls below are local view filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId, workspace?.id, workspace?.revision]);

  async function loadMarket(args: { page?: number; refresh?: boolean } = {}) {
    if (!host) return;
    const request = ++marketRequest.current;
    const expectedHostId = host.hostInstanceId;
    const page = args.page ?? marketCatalog?.page ?? 1;
    const params: HostRequestParams["package.catalog"] = {
      page,
      sort: marketSort,
      ...(args.refresh ? { refresh: true } : {}),
      ...(marketQuery.trim() ? { query: marketQuery.trim() } : {}),
      ...(marketType !== "all" ? { type: marketType } : {}),
    };
    setMarketState("loading");
    setMarketError("");
    try {
      const response = await hostClient.request(
        "package.catalog",
        hostContext(host),
        params,
        MARKET_CATALOG_TIMEOUT_MS,
      );
      if (
        request !== marketRequest.current ||
        useAppStore.getState().host?.hostInstanceId !== expectedHostId
      ) {
        return;
      }
      if (!response.ok) {
        setMarketError(response.error?.message ?? t("packagesMarketError"));
        setMarketState(marketCatalog ? "ready" : "error");
        return;
      }
      setMarketCatalog(response.result);
      setMarketState("ready");
    } catch (error) {
      if (request !== marketRequest.current) return;
      setMarketError(error instanceof Error ? error.message : t("packagesMarketError"));
      setMarketState(marketCatalog ? "ready" : "error");
    }
  }

  useEffect(() => {
    marketRequest.current += 1;
    setMarketCatalog(null);
    setMarketState("idle");
    setMarketError("");
  }, [host?.hostInstanceId]);

  useEffect(() => {
    if (tab === "market" && marketState === "idle") void loadMarket({ page: 1 });
    // The first page is host-global; later pages and filters request on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, marketState, host?.hostInstanceId]);

  useEffect(() => {
    if (tab !== "market" || marketState === "idle") return;
    const timer = window.setTimeout(() => void loadMarket({ page: 1 }), MARKET_QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketQuery]);

  useEffect(() => {
    if (tab !== "market" || marketState === "idle") return;
    void loadMarket({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketType, marketSort]);

  function beginCatalogInstall(item: PackageCatalogItem) {
    if (!host || !workspace) return;
    const params: HostRequestParams["package.install"] = {
      source: item.installSource,
      scope: "user",
    };
    setReview({
      kind: "install",
      method: "package.install",
      params,
      packages: [],
    });
  }

  useEffect(() => {
    if (!progressActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progressActive, packageProgress?.operationId]);

  useEffect(() => {
    // A finished operation should not occupy the strip forever.
    if (packageProgress?.type !== "complete") return;
    const operationId = packageProgress.operationId;
    const timer = window.setTimeout(() => setDismissedProgressOp(operationId), 5_000);
    return () => window.clearTimeout(timer);
  }, [packageProgress?.type, packageProgress?.operationId]);

  useEffect(() => {
    if (!selectedId || allPackages.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
  }, [allPackages, selectedId]);

  useEffect(() => {
    setPendingPreferenceUpdates([]);
  }, [workspace?.id, workspace?.revision]);

  function applyMutationResult(result: PackageMutationResult) {
    applyPackageMutationResult(result);
    if (result.status === "partialFailure" || result.reconcileRequired) {
      pushNotification(
        result.warnings
          .map((warning) => warning.message)
          .filter(Boolean)
          .join("; ") || t("notifPackagesPartialFailure"),
        "warning",
      );
    } else if (result.status === "failed") {
      pushNotification(result.warnings[0]?.message ?? t("notifPackagesOperationFailed"), "error");
    }
  }

  async function runMutation<M extends MutationMethod>(
    method: M,
    params: HostRequestParams[M],
    options?: { allowReconcileRetry?: boolean },
  ) {
    if (!host || !workspace) return;
    if (
      (reloadRequired || reconcileRequired) &&
      method !== "package.reloadResources" &&
      !options?.allowReconcileRetry
    ) {
      pushNotification(
        reconcileRequired
          ? t("notifPackagesReconcileBeforeMutation")
          : t("notifPackagesReloadBeforeMutation"),
        "warning",
      );
      return;
    }
    const generation = captureRequestGeneration(host);
    const optimisticUpdates =
      method === "resource.setPreference"
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
        PACKAGE_MUTATION_REQUEST_TIMEOUT_MS,
      );
      const current = useAppStore.getState();
      if (
        !isExpectedPackageMutationCompletion(current.host, generation, response) ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      )
        return;
      if (!response.ok)
        throw new Error(response.error?.message ?? t("notifPackagesOperationFailed"));
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
      pushNotification(
        error instanceof Error ? error.message : t("notifPackagesOperationFailed"),
        "error",
      );
    } finally {
      if (optimisticUpdates.length > 0) setPendingPreferenceUpdates([]);
      setBusy(false);
    }
  }

  function beginInstallReview() {
    if (!host || !workspace || !installSource.trim()) return;
    const params: HostRequestParams["package.install"] = {
      source: installSource.trim(),
      scope: "user",
    };
    setReview({
      kind: "install",
      method: "package.install",
      params,
      packages: [],
    });
  }

  function beginRemoveReview(pkg: PackageRecord) {
    if (!host || !workspace) return;
    setReview({
      kind: "remove",
      method: "package.remove",
      params: { packageId: pkg.id },
      packages: [pkg],
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
    });
  }

  function confirmReview() {
    if (!review) return;
    const pending = review;
    setReview(null);
    if (pending.kind === "install") setInstallSource("");
    void runMutation(pending.method, pending.params as never);
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
      )
        return;
      if (!response.ok)
        throw new Error(response.error?.message ?? t("notifPackagesUpdateCheckFailed"));
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
          ? t("notifPackagesUpdateCheckUnsupported")
          : response.result.updates.length === 1
            ? t("notifPackagesUpdateAvailable", { count: response.result.updates.length })
            : t("notifPackagesUpdatesAvailable", { count: response.result.updates.length }),
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifPackagesUpdateCheckFailed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function setResourcePreference(
    resource: ResourceRecord,
    preference: "inherit" | "enabled" | "disabled",
    mode: ResourceMode,
  ) {
    const update = buildResourcePreferenceUpdate(resource, mode, preference);
    if (update) void runMutation("resource.setPreference", update);
  }

  function setPackagePreference(
    resources: ResourceRecord[],
    mode: ResourceMode,
    preference: Preference,
  ) {
    const updates = buildResourcePreferenceUpdates(resources, mode, preference);
    if (updates.length) void runMutation("resource.setPreferences", { updates });
  }

  async function openExternal(url: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  async function openCatalog() {
    await openExternal("https://pi.dev/packages");
  }

  function packageDiagnosticCount(item: PackageRecord): number {
    return (packages?.diagnostics ?? []).filter(
      (diagnostic) =>
        diagnostic.source === item.id ||
        diagnostic.source === item.source ||
        diagnostic.source === item.identity,
    ).length;
  }

  function packageResourceTotal(item: PackageRecord): number | null {
    if (!item.resourceCounts) return null;
    return (
      item.resourceCounts.extensions +
      item.resourceCounts.skills +
      item.resourceCounts.prompts +
      item.resourceCounts.themes
    );
  }

  function renderSelectedResourceRow(resource: ResourceRecord, pkg: PackageRecord) {
    const mode = pkg.scope;
    const configurable = canConfigureResource(resource, mode);
    const preference = resourcePreference(resource, mode);
    const readOnlyReason =
      resource.control.kind === "owner-extension"
        ? t("packagesManagedByExtension")
        : resource.control.kind === "read-only"
          ? resource.control.reason
          : undefined;

    return (
      <li key={resource.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={resource.type} />
            <span className="truncate text-sm font-medium">
              {packageMemberName(t, resource, pkg)}
            </span>
            {resource.type === "skill" && resource.manualOnly && (
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted">
                {t("packagesManualOnly")}
              </span>
            )}
            {resource.diagnostics.some((item) => item.severity === "error") && (
              <AlertTriangle size={13} className="text-danger" />
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted" title={resource.path}>
            {resource.relativePath ?? resource.path}
          </p>
          {resource.diagnostics.map((diagnostic, index) => (
            <p
              key={`${diagnostic.message}-${index}`}
              className={`mt-1 text-[11px] ${diagnostic.severity === "error" ? "text-danger" : diagnostic.severity === "warning" ? "text-warning" : "text-muted"}`}
            >
              {diagnostic.message}
            </p>
          ))}
        </div>
        <div className="flex min-w-40 items-center justify-end gap-3">
          <span className={`text-[11px] ${resource.enabled ? "text-success" : "text-muted"}`}>
            {resource.enabled ? t("packagesActive") : t("packagesInactive")}
          </span>
          {configurable ? (
            <div
              data-ui="segmented"
              className="inline-flex h-8 rounded-md border border-border p-0.5"
            >
              {(["enabled", "disabled"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  title={t("packagesPrefScopeTitle", {
                    value: preferenceLabel(t, value),
                    mode: scopeLabel(t, mode),
                  })}
                  data-ui="segmented-item"
                  data-state={preference === value ? "active" : "inactive"}
                  className={`rounded px-2 text-xs capitalize ${preference === value ? "bg-selection text-selection-foreground" : "text-muted hover:text-foreground"}`}
                  disabled={mutationBlocked}
                  onClick={() => setResourcePreference(resource, value, mode)}
                >
                  {preferenceLabel(t, value)}
                </button>
              ))}
            </div>
          ) : (
            <span className="max-w-44 text-right text-[11px] text-muted" title={readOnlyReason}>
              {readOnlyReason ?? t("packagesReadOnly")}
            </span>
          )}
        </div>
      </li>
    );
  }

  if (!workspace?.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
        {t("packagesSelectWorkspace")}
      </div>
    );
  }

  const packageUpdateActions = (
    <div
      className="flex items-center gap-1 border-b border-border px-3 py-2"
      data-package-update-actions
    >
      {updateCheckSupported && (
        <button
          type="button"
          title={t("packagesCheckTitle")}
          className={secondaryButton}
          disabled={busy}
          onClick={() => void checkUpdates()}
        >
          <RefreshCw size={14} />
          <span className="hidden sm:inline">{t("packagesCheck")}</span>
        </button>
      )}
      <button
        type="button"
        title={t("packagesRefreshTitle")}
        className={secondaryButton}
        disabled={loadState === "loading" || busy || mutationRunning}
        onClick={() => void refresh()}
      >
        <RefreshCw size={14} className={loadState === "loading" ? "animate-spin" : ""} />
      </button>
      <button
        type="button"
        className={primaryButton}
        title={t("packagesUpdateAllTitle")}
        aria-label={t("packagesUpdateAllTitle")}
        disabled={
          mutationBlocked || allPackages.length === 0 || (updateCheckDone && knownUpdates === 0)
        }
        onClick={() => beginUpdateReview(allPackages, true)}
      >
        <Download size={14} />
        <span className="hidden sm:inline">
          {updateCheckDone && knownUpdates > 0
            ? t("packagesUpdateAllCount", { count: knownUpdates })
            : t("packagesUpdateAll")}
        </span>
      </button>
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-surface"
      aria-busy={pendingPreferenceUpdates.length > 0 || undefined}
    >
      {review && (
        <Dialog
          title={
            review.kind === "install"
              ? t("packagesInstallReviewTitle")
              : review.kind === "remove"
                ? t("packagesRemoveReviewTitle")
                : t("packagesUpdateReviewTitle")
          }
          confirmLabel={
            review.kind === "install"
              ? t("packagesInstallConfirm")
              : review.kind === "remove"
                ? t("packagesRemoveConfirm")
                : review.method === "package.updateAll"
                  ? t("packagesUpdateAllConfirm")
                  : t("packagesUpdateConfirm")
          }
          tone={review.kind === "remove" ? "danger" : "default"}
          onCancel={() => setReview(null)}
          onConfirm={confirmReview}
        >
          {review.kind === "install" ? (
            <>
              <p>{t("packagesInstallWarning")}</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("packagesSource")}</dt>
                <dd className="break-all font-mono text-foreground">
                  {(review.params as HostRequestParams["package.install"]).source}
                </dd>
                <dt>{t("packagesScope")}</dt>
                <dd className="capitalize text-foreground">
                  {(review.params as HostRequestParams["package.install"]).scope}
                </dd>
              </dl>
            </>
          ) : review.kind === "remove" ? (
            <>
              <p>{t("packagesRemoveWarning")}</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("packagesPackage")}</dt>
                <dd className="truncate text-foreground">{review.packages[0]?.displayName}</dd>
                <dt>{t("packagesSource")}</dt>
                <dd className="break-all font-mono text-foreground">
                  {review.packages[0]?.source}
                </dd>
                <dt>{t("packagesScope")}</dt>
                <dd className="text-foreground">
                  {review.packages[0] ? scopeLabel(t, review.packages[0].scope) : ""}
                </dd>
                <dt>{t("packagesResources")}</dt>
                <dd className="text-foreground">
                  {review.packages[0]
                    ? (packageResourceTotal(review.packages[0]) ?? t("packagesUnknown"))
                    : ""}
                </dd>
              </dl>
            </>
          ) : (
            <>
              <p>{t("packagesUpdateWarning")}</p>
              <ul className="mt-3 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 text-xs text-foreground">
                {review.packages.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3 px-1 py-1">
                    <span className="truncate">{item.displayName}</span>
                    <span className="shrink-0 text-muted">{item.versionOrRef ?? item.scope}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Dialog>
      )}

      <SectionHeader title={t("navPackages")} subtitle={t("packagesSubtitle")}>
        <div
          role="group"
          aria-label={t("packagesViewGroup")}
          data-ui="segmented"
          className="inline-flex h-8 rounded-md border border-border p-0.5"
        >
          {(
            [
              ["installed", "packagesTabInstalled"],
              ["market", "packagesTabMarket"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              type="button"
              data-ui="segmented-item"
              data-state={tab === id ? "active" : "inactive"}
              className={`rounded px-2.5 text-xs ${
                tab === id
                  ? "bg-selection font-medium text-selection-foreground"
                  : "text-muted hover:text-foreground"
              }`}
              onClick={() => setTab(id)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 text-xs text-muted hover:text-accent"
          onClick={() => void openCatalog()}
        >
          {t("packagesCatalogLink")} <ExternalLink size={11} />
        </button>
      </SectionHeader>

      {packageProgress &&
        pendingPreferenceUpdates.length === 0 &&
        dismissedProgressOp !== packageProgress.operationId && (
          <div
            data-settings-top-banner
            className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs"
          >
            <RefreshCw size={13} className={progressActive ? "animate-spin" : ""} />
            <span className="min-w-0 flex-1 truncate text-muted" title={packageProgress.source}>
              {packageProgress.message ?? packageProgress.source}
            </span>
            <span className={packageProgress.type === "error" ? "text-danger" : "text-muted"}>
              {progressIdle
                ? t("packagesProgressStillWaiting")
                : packageProgress.type === "error"
                  ? t("packagesProgressFailed")
                  : packageProgress.type === "complete"
                    ? t("packagesProgressDone")
                    : t("packagesProgressWorking")}
            </span>
            <button
              type="button"
              title={t("commonDismiss")}
              aria-label={t("packagesProgressDismiss")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => setDismissedProgressOp(packageProgress.operationId)}
            >
              <X size={13} />
            </button>
          </div>
        )}

      {pendingPreferenceUpdates.length > 0 && (
        <div
          data-settings-top-banner
          className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs"
          role="status"
          aria-live="polite"
        >
          <RefreshCw size={13} className="animate-spin" />
          <span className="font-medium">{t("packagesApplyingPrefs")}</span>
          <span className="min-w-0 flex-1 truncate text-muted">
            {t("packagesApplyingPrefsDetail", { count: pendingPreferenceUpdates.length })}
          </span>
        </div>
      )}

      {reconcileRequired && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs"
        >
          <AlertTriangle size={14} className="text-warning" />
          <span className="min-w-48 flex-1 text-warning">{t("packagesReconcileWarning")}</span>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t("packagesReloadState")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !packageRetry}
            onClick={() =>
              packageRetry &&
              void runMutation(
                packageRetry.method as MutationMethod,
                packageRetry.params as never,
                { allowReconcileRetry: true },
              )
            }
          >
            {t("packagesRetryOperation")}
          </button>
        </div>
      )}

      {reloadRequired && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs"
        >
          <span className="min-w-48 flex-1 text-warning">{t("packagesReloadRequired")}</span>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => void runMutation("package.reloadResources", null)}
          >
            {t("packagesReloadResources")}
          </button>
        </div>
      )}

      {loadState === "error" && packages && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-danger/35 bg-danger/10 px-4 py-2 text-xs"
        >
          <AlertTriangle size={14} className="text-danger" />
          <span className="min-w-48 flex-1 text-danger">
            {t("packagesRefreshFailed", { message: loadError })}
          </span>
          <button type="button" className={secondaryButton} onClick={() => void refresh()}>
            <RefreshCw size={13} /> {t("packagesTryAgain")}
          </button>
        </div>
      )}

      {tab === "market" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <label className="relative min-w-48 flex-1">
              <Search
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                className={`${inputClass} w-full pl-7`}
                aria-label={t("packagesMarketSearchAria")}
                placeholder={t("packagesMarketSearchPlaceholder")}
                value={marketQuery}
                onChange={(event) => setMarketQuery(event.target.value)}
              />
            </label>
            <select
              className={inputClass}
              aria-label={t("packagesMarketTypeAria")}
              value={marketType}
              onChange={(event) => setMarketType(event.target.value as ResourceTypeFilter)}
            >
              <option value="all">{t("packagesMarketTypeAll")}</option>
              {PACKAGE_RESOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {singularType(t, type)}
                </option>
              ))}
            </select>
            <select
              className={inputClass}
              aria-label={t("packagesMarketSortAria")}
              value={marketSort}
              onChange={(event) => setMarketSort(event.target.value as CatalogSort)}
            >
              <option value="downloads">{t("packagesMarketSortDownloads")}</option>
              <option value="recent">{t("packagesMarketSortRecent")}</option>
            </select>
            <button
              type="button"
              className={secondaryButton}
              title={t("packagesMarketRefresh")}
              aria-label={t("packagesMarketRefresh")}
              disabled={marketState === "loading"}
              onClick={() => void loadMarket({ refresh: true })}
            >
              <RefreshCw size={13} className={marketState === "loading" ? "animate-spin" : ""} />
            </button>
            {marketCatalog && marketRange && (
              <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                <button
                  type="button"
                  className={secondaryButton}
                  title={t("packagesMarketPrev")}
                  aria-label={t("packagesMarketPrev")}
                  disabled={marketState === "loading" || marketCatalog.page <= 1}
                  onClick={() => void loadMarket({ page: marketCatalog.page - 1 })}
                >
                  <ChevronLeft size={13} />
                </button>
                <span className="min-w-24 text-center tabular-nums">
                  {t("packagesMarketRange", {
                    start: marketRange.start,
                    end: marketRange.end,
                    total: marketCatalog.total,
                  })}
                </span>
                <button
                  type="button"
                  className={secondaryButton}
                  title={t("packagesMarketNext")}
                  aria-label={t("packagesMarketNext")}
                  disabled={
                    marketState === "loading" || marketCatalog.page >= marketCatalog.lastPage
                  }
                  onClick={() => void loadMarket({ page: marketCatalog.page + 1 })}
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          </div>
          {marketState === "error" && !marketCatalog ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <AlertTriangle size={24} className="text-danger" />
              <div>
                <p className="text-sm font-medium">{t("packagesMarketError")}</p>
                <p className="mt-1 max-w-lg text-xs text-muted">{marketError}</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void loadMarket({ refresh: true, page: 1 })}
                >
                  <RefreshCw size={13} />
                  {t("packagesTryAgain")}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void openCatalog()}
                >
                  <ExternalLink size={13} />
                  {t("packagesMarketOpenSite")}
                </button>
              </div>
            </div>
          ) : marketCatalog === null ? (
            <p className="p-8 text-center text-sm text-muted">{t("packagesMarketLoading")}</p>
          ) : visibleMarketItems.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted">{t("packagesMarketEmpty")}</p>
          ) : (
            <MarketCatalogGrid
              items={visibleMarketItems}
              allPackages={allPackages}
              locale={locale}
              t={t}
              mutationBlocked={mutationBlocked}
              onOpen={(url) => void openExternal(url)}
              onInstall={beginCatalogInstall}
            />
          )}
        </div>
      ) : loadState === "error" && !packages ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle size={24} className="text-danger" />
          <div>
            <p className="text-sm font-medium">{t("packagesLoadFailedTitle")}</p>
            <p className="mt-1 max-w-lg text-xs text-muted">{loadError}</p>
          </div>
          <button type="button" className={secondaryButton} onClick={() => void refresh()}>
            <RefreshCw size={13} />
            {t("packagesTryAgain")}
          </button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(280px,34%)_minmax(0,1fr)] md:overflow-hidden">
          <aside className="flex min-h-[300px] flex-col border-b border-border md:min-h-0 md:border-b-0 md:border-r">
            <div className="border-b border-border p-3">
              <div className="flex flex-col gap-2">
                <input
                  className={`${inputClass} w-full`}
                  aria-label={t("packagesSourceLabel")}
                  placeholder={t("packagesSourcePlaceholder")}
                  value={installSource}
                  onChange={(event) => setInstallSource(event.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={mutationBlocked || !installSource.trim()}
                    onClick={beginInstallReview}
                  >
                    {t("packagesInstallAction")}
                  </button>
                </div>
              </div>
            </div>
            {packageUpdateActions}
            <div className="flex flex-wrap gap-2 border-b border-border p-3">
              <label className="relative min-w-40 flex-1">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2 top-2.5 text-muted"
                />
                <input
                  aria-label={t("packagesSearchInstalledLabel")}
                  className={`${inputClass} w-full pl-7`}
                  placeholder={t("packagesSearchInstalled")}
                  value={installedQuery}
                  onChange={(event) => setInstalledQuery(event.target.value)}
                />
              </label>
              <select
                aria-label={t("packagesFilterType")}
                className={inputClass}
                value={installedType}
                onChange={(event) => setInstalledType(event.target.value as ResourceTypeFilter)}
              >
                <option value="all">{t("packagesFilterContainsAny")}</option>
                {PACKAGE_RESOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t("packagesFilterContains", { type: singularType(t, type) })}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {loadState === "loading" && !packages && (
                <div className="flex items-center gap-2 p-3 text-xs text-muted">
                  <RefreshCw size={13} className="animate-spin" />
                  {t("packagesLoadingInstalled")}
                </div>
              )}
              {loadState !== "loading" && visiblePackages.length === 0 && (
                <div className="p-4 text-center text-xs text-muted">
                  <PackageOpen size={24} className="mx-auto mb-2 opacity-50" />
                  <p>
                    {hasActiveInstalledFilters(installedFilters)
                      ? t("packagesNoneMatchFilters")
                      : t("packagesNoneInstalled")}
                  </p>
                  {hasActiveInstalledFilters(installedFilters) && (
                    <button
                      type="button"
                      className={`${secondaryButton} mt-3`}
                      onClick={() => {
                        setInstalledQuery("");
                        setInstalledType("all");
                      }}
                    >
                      <X size={13} /> {t("packagesClearFilters")}
                    </button>
                  )}
                </div>
              )}
              <ul>
                {visiblePackages.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={selectedId === item.id ? "true" : undefined}
                      data-ui="nav-item"
                      data-state={selectedId === item.id ? "active" : "inactive"}
                      className={`interface-density-compact-list-row flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-overlay ${selectedId === item.id ? "theme-nav-active bg-nav-active text-nav-active-foreground" : ""}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <Boxes
                        size={15}
                        className={selectedId === item.id ? "text-accent" : "text-muted"}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{item.displayName}</span>
                          {item.updateAvailable && (
                            <span className="rounded bg-warning/15 px-1 text-[11px] text-warning">
                              {t("packagesUpdateChip")}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted">
                          {scopeLabel(t, item.scope)} / {item.kind}
                          {item.versionOrRef ? ` / ${item.versionOrRef}` : ""}
                          {!item.effective
                            ? ` / ${t("packagesReplacedByProject")}`
                            : item.projectOverride || item.overridesPackageId
                              ? ` / ${t("packagesWorkspaceOverrides")}`
                              : ""}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                          <span>
                            {t(
                              packageResourceTotal(item) === 1
                                ? "packagesResourceCount"
                                : "packagesResourcesCount",
                              { count: packageResourceTotal(item) ?? "?" },
                            )}
                          </span>
                          {packageDiagnosticCount(item) > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-warning">
                              <AlertTriangle size={10} />
                              {packageDiagnosticCount(item) === 1
                                ? t("packagesDiagnostic", { count: packageDiagnosticCount(item) })
                                : t("packagesDiagnostics", { count: packageDiagnosticCount(item) })}
                            </span>
                          )}
                        </span>
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
              <div className="flex h-full min-h-64 flex-col items-center justify-center text-center text-muted">
                <PackageOpen size={30} className="mb-3 opacity-40" />
                <p className="text-sm">{t("packagesSelectHintTitle")}</p>
                <p className="mt-1 text-xs">{t("packagesSelectHintBody")}</p>
              </div>
            ) : (
              <div className="mx-auto max-w-4xl">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{selected.displayName}</h2>
                      <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] uppercase text-muted">
                        {scopeLabel(t, selected.scope)}
                      </span>
                      {!selected.effective && (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
                          {t("packagesReplacedByProject")}
                        </span>
                      )}
                    </div>
                    {selected.description && (
                      <p className="mt-1 text-sm text-muted">{selected.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={mutationBlocked}
                      onClick={() => beginUpdateReview([selected])}
                    >
                      <Download size={13} />
                      {t("packagesUpdate")}
                    </button>
                    {selected.installedPath && (
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={async () => {
                          try {
                            const { invoke } = await import("@tauri-apps/api/core");
                            await invoke("desktop_open_path", { path: selected.installedPath });
                          } catch {
                            pushNotification(t("packagesOpenFolderFailed"), "warning");
                          }
                        }}
                      >
                        <FolderOpen size={13} />
                        {t("packagesOpenFolder")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`}
                      disabled={mutationBlocked}
                      onClick={() => beginRemoveReview(selected)}
                    >
                      <Trash2 size={13} />
                      {t("packagesRemove")}
                    </button>
                  </div>
                </div>

                <section className="mt-5 border-t border-border pt-4">
                  <h3 className="text-xs font-semibold uppercase text-muted">
                    {t("packagesDetailsGroup")}
                  </h3>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted">{t("packagesSource")}</dt>
                      <dd className="mt-0.5 break-all font-mono">{selected.source}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("packagesIdentity")}</dt>
                      <dd className="mt-0.5 break-all font-mono">{selected.identity}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("packagesTypeVersion")}</dt>
                      <dd className="mt-0.5">
                        {selected.kind}
                        {selected.versionOrRef ? ` / ${selected.versionOrRef}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("packagesInstalledPath")}</dt>
                      <dd className="mt-0.5 break-all font-mono">
                        {selected.installedPath ?? t("packagesManagedByPi")}
                      </dd>
                    </div>
                  </dl>
                </section>

                {(selected.shadowedByPackageId ||
                  selected.overridesPackageId ||
                  selected.projectOverride) && (
                  <section className="mt-5 border-t border-border pt-4">
                    <h3 className="text-xs font-semibold uppercase text-muted">
                      {t("packagesRelationshipsGroup")}
                    </h3>
                    <div className="mt-2 rounded-md border border-border bg-surface-raised p-3 text-xs">
                      {selected.shadowedByPackageId && (
                        <p>
                          <span className="text-muted">{t("packagesReplacedByProjectLabel")}</span>
                          {allPackages.find((item) => item.id === selected.shadowedByPackageId)
                            ?.displayName ?? selected.shadowedByPackageId}
                        </p>
                      )}
                      {selected.overridesPackageId && (
                        <p>
                          <span className="text-muted">{t("packagesOverridesUserLabel")}</span>
                          {allPackages.find((item) => item.id === selected.overridesPackageId)
                            ?.displayName ?? selected.overridesPackageId}
                        </p>
                      )}
                      {selected.projectOverride && (
                        <p>
                          <span className="text-muted">{t("packagesWorkspaceOverridesLabel")}</span>
                          {selected.projectOverride.source} /{" "}
                          {selected.projectOverride.overrideCount === 1
                            ? t("packagesOverrideChange", {
                                count: selected.projectOverride.overrideCount,
                              })
                            : t("packagesOverrideChanges", {
                                count: selected.projectOverride.overrideCount,
                              })}
                        </p>
                      )}
                    </div>
                  </section>
                )}

                <section className="mt-5 border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase text-muted">
                        {t("packagesResourcesGroup")}
                      </h3>
                      <p className="mt-1 text-xs text-muted">
                        {selected.resourceCountsState === "unknownShadowed" &&
                        selectedPackageResources.length === 0
                          ? t("packagesCountsUnavailable")
                          : t("packagesEnabledDisabled", {
                              enabled: summarizeResources(selectedResources).enabled,
                              disabled: summarizeResources(selectedResources).disabled,
                            })}
                      </p>
                    </div>
                    <PackagePreferenceControl
                      label={t("packagesPackageAria", { name: selected.displayName })}
                      mode={selected.scope}
                      state={packagePreferenceState(selectedPackageResources, selected.scope)}
                      disabled={mutationBlocked}
                      onChange={(preference) =>
                        setPackagePreference(selectedPackageResources, selected.scope, preference)
                      }
                    />
                  </div>
                  {!(
                    selected.resourceCountsState === "unknownShadowed" &&
                    selectedPackageResources.length === 0
                  ) && (
                    <div className="mt-3 space-y-4">
                      {PACKAGE_RESOURCE_TYPES.map((type) => {
                        const resources = selectedResources.filter(
                          (resource) => resource.type === type,
                        );
                        if (resources.length === 0) return null;
                        return (
                          <div key={type}>
                            <h4 className="text-[11px] font-semibold uppercase text-muted">
                              {pluralType(t, type)}
                            </h4>
                            <ul className="mt-1 divide-y divide-border">
                              {resources.map((resource) =>
                                renderSelectedResourceRow(resource, selected),
                              )}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
