type RetryableSessionOpenResponse =
  | { ok: true }
  | { ok: false; error: { code?: string; retryable?: boolean } };

const SESSION_OPEN_RETRY_DELAYS_MS = [80, 160, 240, 400, 600] as const;

export function shouldRetrySessionOpen(error: {
  code?: string;
  retryable?: boolean;
}): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

export async function requestSessionOpenWithRetry<T extends RetryableSessionOpenResponse>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  shouldContinue: () => boolean = () => true,
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    if (!shouldContinue()) return null;
    const response = await request();
    if (
      response.ok ||
      !shouldRetrySessionOpen(response.error) ||
      attempt === SESSION_OPEN_RETRY_DELAYS_MS.length
    ) {
      return response;
    }
    await wait(SESSION_OPEN_RETRY_DELAYS_MS[attempt]!);
  }
}
