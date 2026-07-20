import { describe, expect, it, vi } from "vitest";
import {
  requestUsageReportWithRetry,
  shouldRetryUsageReport,
} from "./usage-report-request";

describe("usage report request retry", () => {
  it("retries transient service graph contention", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { sessions: [] } });
    const wait = vi.fn(async () => {});

    const response = await requestUsageReportWithRetry(request, wait);

    expect(response.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(100);
  });

  it("does not retry permanent or stale errors", () => {
    expect(shouldRetryUsageReport({ code: "SERVICE_GRAPH_BUSY", retryable: false })).toBe(false);
    expect(shouldRetryUsageReport({ code: "STALE_REVISION", retryable: true })).toBe(false);
  });
});
