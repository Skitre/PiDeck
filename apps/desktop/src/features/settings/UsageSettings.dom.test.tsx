/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SerializableUsage,
  SessionUsageReport,
  SessionUsageReportItem,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { UsageSettings } from "./UsageSettings";

const GENERATED_AT = new Date(2026, 7, 18, 16, 30, 0).getTime();

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
  };
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
  name: string,
  updatedAt: number,
  tokens: number,
  messageCount: number,
): SessionUsageReportItem {
  return {
    sessionId: name,
    sessionPath: `/sessions/${name}.jsonl`,
    name,
    updatedAt,
    archived: false,
    messageCount,
    usage: usage({
      input: tokens * 0.6,
      output: tokens * 0.4,
      totalTokens: tokens,
      cost: { total: tokens / 100_000 },
    }),
  };
}

function atDay(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 15).getTime();
}

function report(): SessionUsageReport {
  return {
    workspaceId: "w1",
    generatedAt: GENERATED_AT,
    totals: {
      sessionCount: 4,
      messageCount: 14,
      usage: usage({ totalTokens: 18_000, input: 10_800, output: 7_200 }),
    },
    sessions: [
      session("today", atDay(2026, 8, 18), 1_000, 2),
      session("this-week", atDay(2026, 8, 15), 2_000, 3),
      session("this-month", atDay(2026, 8, 1), 5_000, 4),
      session("older", atDay(2026, 6, 20), 10_000, 5),
    ],
  };
}

function envelope(result: SessionUsageReport): HostResponseEnvelope<"session.usageReport"> {
  return {
    protocolVersion: 1,
    id: "usage-test",
    method: "session.usageReport",
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  };
}

describe("UsageSettings dashboard", () => {
  let request: MockInstance<typeof hostClient.request>;

  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().setDesktopSettings({ language: "en" } as never);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    request = vi.spyOn(hostClient, "request").mockResolvedValue(envelope(report()));
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().setDesktopSettings(null);
  });

  it("shows range cards, charts, and filters the session list", async () => {
    const user = userEvent.setup();
    render(<UsageSettings />);

    await waitFor(() => {
      expect(
        within(screen.getByRole("article", { name: "Token usage" })).getByText("8k"),
      ).toBeInTheDocument();
    });

    expect(
      within(screen.getByRole("article", { name: "Sessions" })).getByText("3"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "Messages" })).getByText("9"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lifetime totals for sessions last updated in this range. Streak uses all activity.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Activity heatmap" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daily token trend" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Token mix" })).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByText("this-month")).toBeInTheDocument();
    expect(screen.queryByText("older")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(
      within(screen.getByRole("article", { name: "Sessions" })).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "Token usage" })).getByText("3k"),
    ).toBeInTheDocument();
    expect(screen.queryByText("this-month")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All time" }));
    expect(
      within(screen.getByRole("article", { name: "Sessions" })).getByText("4"),
    ).toBeInTheDocument();
    expect(screen.getByText("older")).toBeInTheDocument();
    expect(
      screen.getByText("Last 90 days. Each session's tokens are counted on its last update day"),
    ).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("session.usageReport", expect.anything(), null, 120_000);
  });
});
