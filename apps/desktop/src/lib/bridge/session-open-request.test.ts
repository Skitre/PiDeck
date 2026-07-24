import { describe, expect, it, vi } from "vitest";
import { requestSessionOpenWithRetry, shouldRetrySessionOpen } from "./session-open-request";

describe("requestSessionOpenWithRetry", () => {
  it("retries transient service graph contention", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const });
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(80);
  });

  it("does not retry permanent failures", async () => {
    const response = {
      ok: false as const,
      error: { code: "SESSION_NOT_FOUND", retryable: false },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(shouldRetrySessionOpen(response.error)).toBe(false);
  });

  it("stops retrying when the request generation is no longer current", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    }));
    let current = true;
    const wait = vi.fn(async () => {
      current = false;
    });

    await expect(
      requestSessionOpenWithRetry(request, wait, () => current),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds persistent graph contention", async () => {
    const response = {
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls).toEqual([[80], [160], [240], [400], [600]]);
  });
});
