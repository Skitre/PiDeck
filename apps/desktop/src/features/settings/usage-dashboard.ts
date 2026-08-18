import type { SessionUsageReportItem } from "@pideck/protocol";

export type UsageRange = 7 | 30 | "all";
export type TokenPartKey = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

export const TOKEN_PART_KEYS: TokenPartKey[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
];

const HEATMAP_WEEKS = 53;
export const ALL_RANGE_TREND_DAYS = 90;

export type UsageTotals = {
  sessionCount: number;
  messageCount: number;
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export type DailyUsage = UsageTotals & { dateKey: string };

export type HeatmapCell = {
  dateKey: string;
  future: boolean;
  totals: UsageTotals;
};

export type TokenPart = {
  key: TokenPartKey;
  value: number;
  percent: number;
};

export type UsageDashboard = {
  rangeSessions: SessionUsageReportItem[];
  totals: UsageTotals;
  activeDays: number;
  streak: number;
  heatmap: HeatmapCell[][];
  heatmapMaxTokens: number;
  trend: DailyUsage[];
  trendMaxTokens: number;
  parts: TokenPart[];
};

function emptyTotals(): UsageTotals {
  return {
    sessionCount: 0,
    messageCount: 0,
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

export function localDateKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateKeyToLocalDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addLocalDays(dateKey: string, days: number): string {
  const date = dateKeyToLocalDate(dateKey);
  date.setDate(date.getDate() + days);
  return localDateKey(date.getTime());
}

function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function rangeStartMs(range: 7 | 30, now: number): number {
  const start = new Date(startOfLocalDay(now));
  start.setDate(start.getDate() - (range - 1));
  return start.getTime();
}

export function filterSessionsByRange(
  sessions: SessionUsageReportItem[],
  range: UsageRange,
  now: number,
): SessionUsageReportItem[] {
  if (range === "all") return sessions;
  const cutoff = rangeStartMs(range, now);
  return sessions.filter((session) => session.updatedAt >= cutoff);
}

function addSessionUsage(target: UsageTotals, session: SessionUsageReportItem): UsageTotals {
  const usage = session.usage;
  return {
    sessionCount: target.sessionCount + 1,
    messageCount: target.messageCount + session.messageCount,
    tokens: target.tokens + usage.totalTokens,
    cost: target.cost + usage.cost.total,
    input: target.input + usage.input,
    output: target.output + usage.output,
    cacheRead: target.cacheRead + usage.cacheRead,
    cacheWrite: target.cacheWrite + usage.cacheWrite,
    reasoning: target.reasoning + (usage.reasoning ?? 0),
  };
}

function aggregateSessions(sessions: SessionUsageReportItem[]): UsageTotals {
  return sessions.reduce(addSessionUsage, emptyTotals());
}

function bucketSessionsByDay(sessions: SessionUsageReportItem[]): Map<string, UsageTotals> {
  const buckets = new Map<string, UsageTotals>();
  for (const session of sessions) {
    const key = localDateKey(session.updatedAt);
    buckets.set(key, addSessionUsage(buckets.get(key) ?? emptyTotals(), session));
  }
  return buckets;
}

export function currentStreak(dateKeys: Iterable<string>, now: number): number {
  const active = new Set(dateKeys);
  let cursor = localDateKey(now);
  if (!active.has(cursor)) {
    cursor = addLocalDays(cursor, -1);
    if (!active.has(cursor)) return 0;
  }
  let streak = 0;
  while (active.has(cursor)) {
    streak += 1;
    cursor = addLocalDays(cursor, -1);
  }
  return streak;
}

export function heatmapIntensity(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function buildHeatmapWeeks(
  buckets: Map<string, UsageTotals>,
  now: number,
  weekCount = HEATMAP_WEEKS,
): HeatmapCell[][] {
  const today = startOfLocalDay(now);
  const todayKey = localDateKey(today);
  const first = new Date(today);
  first.setDate(first.getDate() - (weekCount * 7 - 1));
  first.setDate(first.getDate() - first.getDay());

  const weeks: HeatmapCell[][] = [];
  const cursor = new Date(first);
  while (weeks.length < weekCount + 2) {
    const week: HeatmapCell[] = [];
    for (let index = 0; index < 7; index += 1) {
      const key = localDateKey(cursor.getTime());
      week.push({
        dateKey: key,
        future: cursor.getTime() > today,
        totals: buckets.get(key) ?? emptyTotals(),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
    if (week.some((cell) => cell.dateKey === todayKey)) break;
  }
  return weeks;
}

export function weekMonthLabel(week: HeatmapCell[], locale: string, isFirstWeek: boolean): string {
  const visible = week.filter((cell) => !cell.future);
  if (visible.length === 0) return "";
  const firstOfMonth = visible.find((cell) => dateKeyToLocalDate(cell.dateKey).getDate() === 1);
  if (!firstOfMonth && !isFirstWeek) return "";
  const cell = firstOfMonth ?? visible[0];
  return dateKeyToLocalDate(cell.dateKey).toLocaleDateString(locale, { month: "short" });
}

export function dailySeries(
  buckets: Map<string, UsageTotals>,
  range: UsageRange,
  now: number,
): DailyUsage[] {
  const days = range === "all" ? ALL_RANGE_TREND_DAYS : range;
  const cursor = new Date(startOfLocalDay(now));
  cursor.setDate(cursor.getDate() - (days - 1));
  const end = startOfLocalDay(now);
  const series: DailyUsage[] = [];
  while (cursor.getTime() <= end) {
    const dateKey = localDateKey(cursor.getTime());
    series.push({ dateKey, ...(buckets.get(dateKey) ?? emptyTotals()) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

export function tokenParts(totals: UsageTotals): TokenPart[] {
  const raw = TOKEN_PART_KEYS.map((key) => ({ key, value: totals[key] })).filter(
    (part) => part.value > 0,
  );
  const sum = raw.reduce((total, part) => total + part.value, 0);
  return raw.map((part) => ({
    ...part,
    percent: sum > 0 ? (part.value / sum) * 100 : 0,
  }));
}

export function formatPercent(percent: number): string {
  if (percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function axisTickIndices(length: number): number[] {
  if (length <= 0) return [];
  if (length <= 8) return Array.from({ length }, (_, index) => index);
  const step = length <= 16 ? 2 : 5;
  const ticks: number[] = [];
  for (let index = 0; index < length; index += step) ticks.push(index);
  if (ticks[ticks.length - 1] !== length - 1) ticks.push(length - 1);
  return ticks;
}

export function weekdayLabels(locale: string): string[] {
  const sunday = new Date(2026, 7, 16);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + index);
    return date.toLocaleDateString(locale, { weekday: "narrow" });
  });
}

export function buildUsageDashboard(
  sessions: SessionUsageReportItem[],
  range: UsageRange,
  now: number,
): UsageDashboard {
  const rangeSessions = filterSessionsByRange(sessions, range, now)
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const totals = aggregateSessions(rangeSessions);
  const rangeBuckets = bucketSessionsByDay(rangeSessions);
  const allBuckets = bucketSessionsByDay(sessions);
  const heatmap = buildHeatmapWeeks(allBuckets, now);
  let heatmapMaxTokens = 0;
  for (const week of heatmap) {
    for (const cell of week) {
      if (!cell.future) heatmapMaxTokens = Math.max(heatmapMaxTokens, cell.totals.tokens);
    }
  }
  const trend = dailySeries(allBuckets, range, now);
  return {
    rangeSessions,
    totals,
    activeDays: rangeBuckets.size,
    streak: currentStreak(allBuckets.keys(), now),
    heatmap,
    heatmapMaxTokens,
    trend,
    trendMaxTokens: trend.reduce((max, day) => Math.max(max, day.tokens), 0),
    parts: tokenParts(totals),
  };
}
