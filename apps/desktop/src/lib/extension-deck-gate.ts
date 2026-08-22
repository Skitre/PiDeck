const STORAGE_KEY = "pideck.extension-deck-v1";

let resolved: boolean | undefined;

function readGate(): boolean {
  try {
    const env = (import.meta as { env?: { VITE_EXTENSION_DECK_V1?: string } }).env
      ?.VITE_EXTENSION_DECK_V1;
    if (env === "0" || env === "false") return false;
    if (env === "1" || env === "true") return true;
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    /* ignore unavailable storage */
  }
  return true;
}

/** Internal one-release rollout gate. Read once before Dock state initializes. */
export function isExtensionDeckV1Enabled(): boolean {
  if (resolved === undefined) resolved = readGate();
  return resolved;
}

export function resetExtensionDeckV1GateForTests(value?: boolean): void {
  resolved = value;
}
