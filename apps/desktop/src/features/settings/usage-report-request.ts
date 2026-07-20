type RetryableUsageReportResponse =
  | { ok: true }
  | { ok: false; error: { code?: string; retryable?: boolean } };

export function shouldRetryUsageReport(error: {
  code?: string;
  retryable?: boolean;
}): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

export async function requestUsageReportWithRetry<T extends RetryableUsageReportResponse>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (response.ok || !shouldRetryUsageReport(response.error) || attempt === 5) {
      return response;
    }
    await wait(100 * (attempt + 1));
  }
}
