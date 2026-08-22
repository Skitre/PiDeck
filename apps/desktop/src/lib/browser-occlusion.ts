import { useEffect, useSyncExternalStore } from "react";

const owners = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Hide native Browser while a covering HTML surface is open. Last release restores. */
export function acquireBrowserOcclusion(owner: string): () => void {
  const size = owners.size;
  owners.add(owner);
  if (owners.size !== size) emit();
  return () => releaseBrowserOcclusion(owner);
}

function releaseBrowserOcclusion(owner: string): void {
  if (!owners.delete(owner)) return;
  emit();
}

export function isBrowserOccluded(): boolean {
  return owners.size > 0;
}

function subscribeBrowserOcclusion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useIsBrowserOccluded(): boolean {
  return useSyncExternalStore(subscribeBrowserOcclusion, isBrowserOccluded, () => false);
}

export function useBrowserOcclusion(owner: string, active = true): void {
  useEffect(() => {
    if (!active) return;
    return acquireBrowserOcclusion(owner);
  }, [owner, active]);
}

export function resetBrowserOcclusionForTests(): void {
  if (owners.size === 0) return;
  owners.clear();
  emit();
}
