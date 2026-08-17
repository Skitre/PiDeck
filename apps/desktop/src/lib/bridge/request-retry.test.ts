import { describe, expect, it, vi } from "vitest";
import { requestWithRetry } from "./request-retry";

describe("requestWithRetry", () => {
  it("retries transient failures until the request succeeds", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "STALE_REVISION", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { models: [] } });
    const wait = vi.fn(async () => {});

    const result = await requestWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { models: [] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });

  it("does not retry a non-retryable failure", async () => {
    const response = {
      ok: false as const,
      error: { code: "INTERNAL_ERROR", retryable: false },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops after five retryable failures", async () => {
    const response = {
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls).toEqual([[80], [160], [240], [320]]);
  });

  it("cancels retries when the caller no longer wants the result", async () => {
    let active = true;
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    }));
    const wait = vi.fn(async () => {
      active = false;
    });

    await expect(requestWithRetry(request, wait, () => active)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
