import type { SerializableUsage, SessionUsageReportItem } from "@pideck/protocol";
import { describe, expect, it } from "vitest";
import {
  ALL_RANGE_TREND_DAYS,
  axisTickIndices,
  buildHeatmapWeeks,
  buildUsageDashboard,
  currentStreak,
  dailySeries,
  filterSessionsByRange,
  formatPercent,
  heatmapIntensity,
  localDateKey,
  rangeStartMs,
  tokenParts,
} from "./usage-dashboard";

const NOW = new Date(2026, 7, 18, 16, 30, 0).getTime();

function atDay(year: number, month: number, day: number, hour = 15): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function usage(
  overrides: Partial<Omit<SerializableUsage, "cost">> & {
    cost?: Partial<SerializableUsage["cost"]>;
  } = {},
): SerializableUsage {
  const { cost, ...rest } = overrides;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...rest,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...cost,
    },
  };
}

function session(
  overrides: Partial<SessionUsageReportItem> & Pick<SessionUsageReportItem, "updatedAt">,
): SessionUsageReportItem {
  return {
    sessionId: overrides.sessionId ?? overrides.sessionPath ?? "session",
    sessionPath: overrides.sessionPath ?? "/sessions/session.jsonl",
    archived: false,
    messageCount: 1,
    usage: usage({ totalTokens: 100, input: 60, output: 40 }),
    ...overrides,
  };
}

describe("usage dashboard dates", () => {
  it("starts a 7-day range on the local morning six days earlier", () => {
    expect(localDateKey(rangeStartMs(7, NOW))).toBe("2026-08-12");
    expect(localDateKey(rangeStartMs(30, NOW))).toBe("2026-07-20");
  });

  it("keeps a session from the first morning of the range", () => {
    const included = session({
      sessionPath: "in",
      updatedAt: atDay(2026, 8, 12, 0),
    });
    const excluded = session({
      sessionPath: "out",
      updatedAt: atDay(2026, 8, 11, 23),
    });
    expect(
      filterSessionsByRange([included, excluded], 7, NOW).map((item) => item.sessionPath),
    ).toEqual(["in"]);
  });
});

describe("usage dashboard streak", () => {
  it("counts through today when today is active", () => {
    expect(currentStreak(["2026-08-16", "2026-08-17", "2026-08-18"], NOW)).toBe(3);
  });

  it("still counts a streak that ended yesterday", () => {
    expect(currentStreak(["2026-08-16", "2026-08-17"], NOW)).toBe(2);
  });

  it("is zero when the last active day is older than yesterday", () => {
    expect(currentStreak(["2026-08-15"], NOW)).toBe(0);
  });
});

describe("usage dashboard charts", () => {
  it("builds a Sunday-aligned heatmap that includes today and hides later days", () => {
    const weeks = buildHeatmapWeeks(new Map(), NOW);
    expect(dateIsSunday(weeks[0][0].dateKey)).toBe(true);
    expect(weeks.some((week) => week.some((cell) => cell.dateKey === "2026-08-18"))).toBe(true);
    const todayWeek = weeks.find((week) => week.some((cell) => cell.dateKey === "2026-08-18"));
    expect(todayWeek?.filter((cell) => cell.future).map((cell) => cell.dateKey)).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
    ]);
  });

  it("emits one trend bucket per day in the selected window", () => {
    expect(dailySeries(new Map(), 7, NOW)).toHaveLength(7);
    expect(dailySeries(new Map(), 30, NOW)).toHaveLength(30);
    expect(dailySeries(new Map(), "all", NOW)).toHaveLength(ALL_RANGE_TREND_DAYS);
    expect(dailySeries(new Map(), 7, NOW)[0]?.dateKey).toBe("2026-08-12");
    expect(dailySeries(new Map(), 7, NOW).at(-1)?.dateKey).toBe("2026-08-18");
  });

  it("splits the donut by token composition, not by model", () => {
    const parts = tokenParts({
      sessionCount: 1,
      messageCount: 1,
      tokens: 1000,
      cost: 0,
      input: 670,
      output: 270,
      cacheRead: 38,
      cacheWrite: 22,
      reasoning: 0,
    });
    expect(parts.map((part) => [part.key, formatPercent(part.percent)])).toEqual([
      ["input", "67%"],
      ["output", "27%"],
      ["cacheRead", "3.8%"],
      ["cacheWrite", "2.2%"],
    ]);
  });

  it("buckets heatmap intensity by share of the busiest day", () => {
    expect(heatmapIntensity(0, 100)).toBe(0);
    expect(heatmapIntensity(20, 100)).toBe(1);
    expect(heatmapIntensity(40, 100)).toBe(2);
    expect(heatmapIntensity(60, 100)).toBe(3);
    expect(heatmapIntensity(80, 100)).toBe(4);
  });

  it("places axis ticks every five days on a 30-day series", () => {
    expect(axisTickIndices(30)).toEqual([0, 5, 10, 15, 20, 25, 29]);
  });
});

describe("buildUsageDashboard", () => {
  const sessions = [
    session({
      sessionPath: "today",
      updatedAt: atDay(2026, 8, 18),
      messageCount: 2,
      usage: usage({
        input: 80,
        output: 20,
        totalTokens: 100,
        cost: { total: 0.02 },
      }),
    }),
    session({
      sessionPath: "last-week",
      updatedAt: atDay(2026, 8, 10),
      messageCount: 3,
      usage: usage({ input: 200, output: 50, totalTokens: 250, cost: { total: 0.05 } }),
    }),
    session({
      sessionPath: "older",
      updatedAt: atDay(2026, 6, 1),
      messageCount: 8,
      usage: usage({ input: 900, output: 100, totalTokens: 1000, cost: { total: 0.2 } }),
    }),
  ];

  it("filters cards and the session list to the selected range", () => {
    const last7 = buildUsageDashboard(sessions, 7, NOW);
    const last30 = buildUsageDashboard(sessions, 30, NOW);
    const all = buildUsageDashboard(sessions, "all", NOW);

    expect(last7.totals.sessionCount).toBe(1);
    expect(last7.rangeSessions.map((item) => item.sessionPath)).toEqual(["today"]);
    expect(last30.totals.sessionCount).toBe(2);
    expect(last30.totals.tokens).toBe(350);
    expect(last30.activeDays).toBe(2);
    expect(all.totals.sessionCount).toBe(3);
    expect(all.totals.messageCount).toBe(13);
  });

  it("keeps the heatmap on all-time last-update activity", () => {
    const last7 = buildUsageDashboard(sessions, 7, NOW);
    const juneWeek = last7.heatmap.find((week) =>
      week.some((cell) => cell.dateKey === "2026-06-01"),
    );
    expect(juneWeek?.find((cell) => cell.dateKey === "2026-06-01")?.totals.tokens).toBe(1000);
    expect(last7.streak).toBe(1);
  });
});

function dateIsSunday(dateKey: string): boolean {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getDay() === 0;
}
