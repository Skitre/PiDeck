/** Sidebar collapse preferences — localStorage-backed, safe in non-DOM tests. */
export function sidebarPref(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setSidebarPref(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
