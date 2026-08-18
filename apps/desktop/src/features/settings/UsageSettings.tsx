import type { HostResponseEnvelope, SessionUsageReport } from "@pideck/protocol";
import { Archive, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SectionHeader } from "../../components/SectionHeader";
import { formatTokenCount } from "../../lib/format-token-count";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import type { MessageKey } from "../../lib/i18n";
import { useLocale, useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { requestUsageReportWithRetry } from "./usage-report-request";
import {
  TOKEN_PART_KEYS,
  axisTickIndices,
  buildUsageDashboard,
  dateKeyToLocalDate,
  formatPercent,
  heatmapIntensity,
  weekMonthLabel,
  weekdayLabels,
  type DailyUsage,
  type HeatmapCell,
  type TokenPart,
  type TokenPartKey,
  type UsageDashboard,
  type UsageRange,
  type UsageTotals,
} from "./usage-dashboard";

type UsageReportResponse = HostResponseEnvelope<"session.usageReport">;

const RANGES: UsageRange[] = [7, 30, "all"];

const TOKEN_PART_COLORS: Record<TokenPartKey, string> = {
  input: "var(--color-accent)",
  output: "var(--color-success)",
  cacheRead: "var(--color-info)",
  cacheWrite: "var(--color-warning)",
  reasoning: "color-mix(in srgb, var(--color-focus) 62%, var(--color-foreground))",
};

const TOKEN_PART_LABELS: Record<TokenPartKey, MessageKey> = {
  input: "usageInput",
  output: "usageOutput",
  cacheRead: "usageCacheRead",
  cacheWrite: "usageCacheWrite",
  reasoning: "usageReasoning",
};

const RANGE_LABELS: Record<UsageRange, MessageKey> = {
  7: "usageRange7",
  30: "usageRange30",
  all: "usageRangeAll",
};

const HEATMAP_FILL: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "color-mix(in srgb, var(--color-foreground) 8%, var(--color-surface-overlay))",
  1: "color-mix(in srgb, var(--color-accent) 28%, var(--color-surface-raised))",
  2: "color-mix(in srgb, var(--color-accent) 48%, var(--color-surface-raised))",
  3: "color-mix(in srgb, var(--color-accent) 72%, var(--color-surface-raised))",
  4: "var(--color-accent)",
};

let usageReportInFlight: {
  key: string;
  promise: Promise<UsageReportResponse>;
} | null = null;

function sharedUsageReportRequest(
  key: string,
  request: () => Promise<UsageReportResponse>,
): Promise<UsageReportResponse> {
  if (usageReportInFlight?.key === key) return usageReportInFlight.promise;
  const promise = requestUsageReportWithRetry(request);
  usageReportInFlight = { key, promise };
  const clear = () => {
    if (usageReportInFlight?.promise === promise) usageReportInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

function formatCost(cost: number): string {
  if (cost <= 0) return "--";
  if (cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

function useSessionUsageReport() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const [report, setReport] = useState<SessionUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;

  useEffect(() => {
    if (!hostInstanceId || !workspaceId || workspaceRevision === undefined) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    const current = useAppStore.getState();
    const requestHost = current.host;
    const requestWorkspace = current.workspace;
    if (
      !requestHost ||
      !requestWorkspace ||
      requestHost.hostInstanceId !== hostInstanceId ||
      requestWorkspace.id !== workspaceId ||
      requestWorkspace.revision !== workspaceRevision
    ) {
      return;
    }
    let cancelled = false;
    const expectedHostId = requestHost.hostInstanceId;
    const expectedWorkspaceId = requestWorkspace.id;
    const requestKey = `${expectedHostId}:${expectedWorkspaceId}:${requestWorkspace.revision}:${refreshKey}`;
    setLoading(true);
    setError(null);

    void sharedUsageReportRequest(requestKey, () =>
      hostClient.request(
        "session.usageReport",
        workspaceContext(requestHost, requestWorkspace),
        null,
        120_000,
      ),
    )
      .then((response) => {
        const current = useAppStore.getState();
        if (
          cancelled ||
          current.host?.hostInstanceId !== expectedHostId ||
          current.workspace?.id !== expectedWorkspaceId
        ) {
          return;
        }
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setReport(response.result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostInstanceId, workspaceId, workspaceRevision, refreshKey]);

  return {
    report,
    error,
    loading,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}

export function UsageSettings() {
  const t = useT();
  const locale = useLocale();
  const { report, error, loading, refresh } = useSessionUsageReport();
  const [range, setRange] = useState<UsageRange>(30);
  const now = report?.generatedAt ?? Date.now();
  const dashboard = useMemo(
    () => buildUsageDashboard(report?.sessions ?? [], range, now),
    [report, range, now],
  );
  const dateLocale = locale === "zh" ? "zh-CN" : "en-US";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SectionHeader title={t("navUsage")} subtitle={t("usageSubtitle")}>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-muted sm:inline">{t("usageRange")}</span>
          <div
            data-ui="segmented"
            className="inline-flex h-8 rounded-md border border-border p-0.5"
            role="group"
            aria-label={t("usageRange")}
          >
            {RANGES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                data-ui="segmented-item"
                data-state={range === value ? "active" : "inactive"}
                className={`rounded px-2.5 text-xs ${
                  range === value
                    ? "bg-selection font-medium text-selection-foreground"
                    : "text-muted hover:text-foreground"
                }`}
                onClick={() => setRange(value)}
              >
                {t(RANGE_LABELS[value])}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
            title={t("usageRefresh")}
            aria-label={t("usageRefresh")}
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 pb-8 pt-1">
          {error ? (
            <div className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          ) : null}

          {!report && loading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted">
              {t("usageLoading")}
            </div>
          ) : (
            <>
              <OverviewCards dashboard={dashboard} ready={Boolean(report)} />
              <HeatmapCard
                weeks={dashboard.heatmap}
                maxTokens={dashboard.heatmapMaxTokens}
                locale={dateLocale}
              />
              <DailyTrendCard
                trend={dashboard.trend}
                maxTokens={dashboard.trendMaxTokens}
                locale={dateLocale}
                range={range}
              />
              <TokenMixCard
                parts={dashboard.parts}
                totals={dashboard.totals}
                emptyMessage={
                  report && report.sessions.length > 0 ? t("usageEmptyRange") : t("usageEmpty")
                }
              />
              <SessionListCard
                sessions={dashboard.rangeSessions}
                emptyMessage={
                  report && report.sessions.length > 0 ? t("usageEmptyRange") : t("usageEmpty")
                }
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewCards({ dashboard, ready }: { dashboard: UsageDashboard; ready: boolean }) {
  const t = useT();
  const { totals } = dashboard;
  const cards = [
    {
      label: t("usageTotalTokens"),
      value: ready ? formatTokenCount(totals.tokens) : "--",
    },
    {
      label: t("usageSessions"),
      value: ready ? totals.sessionCount.toLocaleString() : "--",
    },
    {
      label: t("usageMessageCount"),
      value: ready ? totals.messageCount.toLocaleString() : "--",
    },
    {
      label: t("usageActiveDays"),
      value: ready ? dashboard.activeDays.toLocaleString() : "--",
    },
    {
      label: t("usageStreak"),
      value: ready ? dashboard.streak.toLocaleString() : "--",
    },
    {
      label: t("usageTotalCost"),
      value: ready ? formatCost(totals.cost) : "--",
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted">{t("usageOverviewHint")}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {cards.map((card) => (
          <article
            key={card.label}
            aria-label={card.label}
            className="rounded-lg border border-border px-4 py-3.5"
          >
            <p className="text-[11px] text-muted">{card.label}</p>
            <p className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">{card.value}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="mb-4">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-0.5 text-[11px] text-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function HeatmapCard({
  weeks,
  maxTokens,
  locale,
}: {
  weeks: HeatmapCell[][];
  maxTokens: number;
  locale: string;
}) {
  const t = useT();
  const weekdays = weekdayLabels(locale);
  const columns = `14px repeat(${weeks.length}, minmax(0, 1fr))`;
  return (
    <ChartCard title={t("usageHeatmap")} hint={t("usageHeatmapHint")}>
      <div className="overflow-x-auto">
        <div className="grid w-full min-w-[640px]" style={{ gridTemplateColumns: columns, gap: 3 }}>
          <span />
          {weeks.map((week, index) => (
            <span
              key={`month-${week[0]?.dateKey ?? index}`}
              className="overflow-visible text-[9px] leading-none text-muted"
            >
              <span className="inline-block w-max">
                {weekMonthLabel(week, locale, index === 0)}
              </span>
            </span>
          ))}
          {weekdays.map((label, row) => (
            <HeatmapRow
              key={`row-${row}`}
              label={label}
              showLabel={row % 2 === 1}
              cells={weeks.map((week) => week[row])}
              maxTokens={maxTokens}
            />
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted">
        <span>{t("usageHeatmapLess")}</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span
            key={level}
            className="size-2.5 rounded-[2px]"
            style={{ background: HEATMAP_FILL[level] }}
          />
        ))}
        <span>{t("usageHeatmapMore")}</span>
      </div>
    </ChartCard>
  );
}

function HeatmapRow({
  label,
  showLabel,
  cells,
  maxTokens,
}: {
  label: string;
  showLabel: boolean;
  cells: Array<HeatmapCell | undefined>;
  maxTokens: number;
}) {
  return (
    <>
      <span
        className={`flex items-center text-[9px] leading-none text-muted ${showLabel ? "" : "invisible"}`}
      >
        {label}
      </span>
      {cells.map((cell, index) => {
        if (!cell) return <span key={`${label}-empty-${index}`} />;
        const level = heatmapIntensity(cell.totals.tokens, maxTokens);
        return (
          <div
            key={cell.dateKey}
            title={
              cell.future
                ? undefined
                : `${cell.dateKey} · ${formatTokenCount(cell.totals.tokens)} · ${cell.totals.sessionCount}`
            }
            className={`aspect-square w-full rounded-[2px] ${cell.future ? "invisible" : ""}`}
            style={{ background: HEATMAP_FILL[level] }}
          />
        );
      })}
    </>
  );
}

function DailyTrendCard({
  trend,
  maxTokens,
  locale,
  range,
}: {
  trend: DailyUsage[];
  maxTokens: number;
  locale: string;
  range: UsageRange;
}) {
  const t = useT();
  const ticks = axisTickIndices(trend.length);
  return (
    <ChartCard
      title={t("usageDailyTrend")}
      hint={range === "all" ? t("usageDailyTrendHintAll") : t("usageDailyTrendHint")}
    >
      <div className="flex h-44 items-end gap-px">
        {trend.map((day) => {
          const height = maxTokens > 0 ? (day.tokens / maxTokens) * 100 : 0;
          return (
            <div
              key={day.dateKey}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${day.dateKey} · ${formatTokenCount(day.tokens)}`}
            >
              {day.tokens > 0 ? (
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-t-[2px]"
                  style={{ height: `${Math.max(height, 2)}%` }}
                >
                  {TOKEN_PART_KEYS.map((key) => {
                    const value = day[key];
                    if (value <= 0) return null;
                    return (
                      <div
                        key={key}
                        style={{
                          height: `${(value / day.tokens) * 100}%`,
                          background: TOKEN_PART_COLORS[key],
                        }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="h-px w-full bg-border" />
              )}
            </div>
          );
        })}
      </div>
      <div className="relative mt-2 h-4">
        {ticks.map((index) => {
          const day = trend[index];
          if (!day) return null;
          return (
            <span
              key={day.dateKey}
              className="absolute -translate-x-1/2 text-[10px] tabular-nums text-muted"
              style={{ left: `${((index + 0.5) / trend.length) * 100}%` }}
            >
              {dateKeyToLocalDate(day.dateKey).toLocaleDateString(locale, {
                month: "numeric",
                day: "numeric",
              })}
            </span>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
        {TOKEN_PART_KEYS.map((key) => (
          <span key={key} className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="size-2 rounded-[2px]" style={{ background: TOKEN_PART_COLORS[key] }} />
            {t(TOKEN_PART_LABELS[key])}
          </span>
        ))}
      </div>
    </ChartCard>
  );
}

function TokenMixCard({
  parts,
  totals,
  emptyMessage,
}: {
  parts: TokenPart[];
  totals: UsageTotals;
  emptyMessage: string;
}) {
  const t = useT();
  return (
    <ChartCard title={t("usageTokenMix")} hint={t("usageTokenMixHint")}>
      <div className="grid items-center gap-6 md:grid-cols-[auto_1fr]">
        <TokenDonut parts={parts} total={totals.tokens} />
        <ul className="flex flex-col gap-2.5">
          {parts.length === 0 ? (
            <li className="text-sm text-muted">{emptyMessage}</li>
          ) : (
            parts.map((part) => (
              <li key={part.key} className="flex items-center gap-3 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: TOKEN_PART_COLORS[part.key] }}
                />
                <span className="min-w-0 flex-1 truncate">{t(TOKEN_PART_LABELS[part.key])}</span>
                <span className="tabular-nums text-muted">{formatTokenCount(part.value)}</span>
                <span className="w-10 text-right tabular-nums text-muted">
                  {formatPercent(part.percent)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </ChartCard>
  );
}

function TokenDonut({ parts, total }: { parts: TokenPart[]; total: number }) {
  const t = useT();
  const size = 168;
  const stroke = 22;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="relative mx-auto size-[168px]">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--color-foreground) 8%, var(--color-surface-overlay))"
          strokeWidth={stroke}
        />
        {parts.map((part) => {
          const length = (part.percent / 100) * circumference;
          const circle = (
            <circle
              key={part.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={TOKEN_PART_COLORS[part.key]}
              strokeWidth={stroke}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += length;
          return circle;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-lg font-semibold tabular-nums">{formatTokenCount(total)}</p>
        <p className="text-[11px] text-muted">{t("usageTokensUnit")}</p>
      </div>
    </div>
  );
}

function SessionListCard({
  sessions,
  emptyMessage,
}: {
  sessions: UsageDashboard["rangeSessions"];
  emptyMessage: string;
}) {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{t("usageSessionsHeading")}</h2>
      </div>
      {sessions.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">{emptyMessage}</div>
      ) : (
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead className="bg-surface-raised text-[11px] text-muted">
            <tr className="interface-density-table-header-row border-b border-border">
              <th scope="col" className="w-[42%] px-4 py-2.5 font-medium">
                {t("usageColSession")}
              </th>
              <th scope="col" className="w-[24%] px-3 py-2.5 font-medium">
                {t("usageColUpdated")}
              </th>
              <th scope="col" className="w-[18%] px-3 py-2.5 text-right font-medium">
                {t("usageColTokens")}
              </th>
              <th scope="col" className="w-[16%] px-4 py-2.5 text-right font-medium">
                {t("usageColCost")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.sessionPath}
                className="interface-density-table-row border-b border-border/70 last:border-b-0"
              >
                <td className="px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {session.archived && (
                      <>
                        <Archive size={13} className="shrink-0 text-muted" aria-hidden />
                        <span className="sr-only">{t("usageArchived")}</span>
                      </>
                    )}
                    <span className="truncate font-medium" title={session.sessionPath}>
                      {session.name ?? t("usageUntitledSession")}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-muted">
                    {t("usageMessages", { count: session.messageCount.toLocaleString() })}
                  </p>
                </td>
                <td className="px-3 py-3 text-muted">
                  {new Date(session.updatedAt).toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatTokenCount(session.usage.totalTokens)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">
                  {formatCost(session.usage.cost.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
