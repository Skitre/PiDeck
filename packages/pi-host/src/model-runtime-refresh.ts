/**
 * Explicit model-refresh helpers.
 *
 * `ModelRegistry.refresh()` is a void facade over `ModelRuntime.refresh`.
 * Routing every PiDeck refresh through `refreshModelsLocal` keeps the
 * no-network guarantee auditable: startup,
 * provider list/save/remove/setEnabled, models.json reconciliation, and
 * session create/open must all use this helper.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { logger } from "./logger.js";

export type RefreshOptions = {
  /** Host shutdown signal, or an operation signal that composes with it. */
  signal?: AbortSignal;
};

function reportErrors(scope: string, result: ModelsRefreshResult): ModelsRefreshResult {
  if (result.aborted) logger.debug(`${scope} model refresh aborted`);
  for (const [providerId, error] of result.errors) {
    // Provider id and message only — never the credential or request headers.
    logger.warn(`${scope} model refresh failed for a provider`, {
      providerId,
      error: error.message,
    });
  }
  return result;
}

/**
 * Reconcile against on-disk `models.json` and the cached catalog. Never reaches
 * the network, so it is safe on every startup and configuration path.
 */
export async function refreshModelsLocal(
  runtime: ModelRuntime,
  options: RefreshOptions = {},
): Promise<ModelsRefreshResult> {
  return reportErrors(
    "local",
    await runtime.refresh({ allowNetwork: false, signal: options.signal }),
  );
}
