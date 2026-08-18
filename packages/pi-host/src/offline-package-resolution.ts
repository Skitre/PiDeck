/**
 * Keep implicit resource loading off the network.
 *
 * `DefaultResourceLoader.reload()` calls its own private `DefaultPackageManager`
 * with `resolve()` and no `onMissing` handler. In that shape the SDK installs
 * silently: any configured npm package that is absent from disk, or whose
 * installed version no longer satisfies the configured range, triggers a real
 * `npm install`, and an absent git package triggers a real `git clone`.
 *
 * Two problems follow. Host startup, workspace selection, and session
 * create/open are all required to stay offline, and that private package
 * manager is unreachable from PiDeck, so the child process it spawns cannot be
 * cancelled or bounded.
 *
 * The SDK gates exactly this behaviour on `PI_OFFLINE`, re-reading the variable
 * on every call, so scoping it around implicit reloads makes the offline
 * guarantee structural rather than a convention. Explicit package operations
 * (`installNpm` / `installGit` reached through `package.install` and friends)
 * do not consult the flag, so PiDeck's own install flow is unaffected.
 *
 * Scope matters: the flag is process-wide, and setting it globally would also
 * disable the update-check capability. Every caller below runs under
 * `serviceGraphLock`, so no other resolution can observe the temporary value.
 */
const OFFLINE_ENV = "PI_OFFLINE";

/**
 * Run an implicit resource load with SDK package auto-install disabled.
 *
 * Missing packages are skipped rather than fetched; they surface through the
 * normal resource diagnostics, and the user installs them from the Packages
 * page. Use this for implicit reloads, including post-mutation session/loader
 * reload: install/update already fetched the target package, and reload must
 * not resurrect an unrelated package the user just removed.
 */
export async function withoutImplicitPackageInstall<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[OFFLINE_ENV];
  process.env[OFFLINE_ENV] = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[OFFLINE_ENV];
    else process.env[OFFLINE_ENV] = previous;
  }
}

/** True while an implicit load is suppressing auto-install. Test/diagnostic use. */
export function implicitPackageInstallSuppressed(): boolean {
  const value = process.env[OFFLINE_ENV];
  if (!value) return false;
  const normalized = value.toLowerCase();
  return value === "1" || normalized === "true" || normalized === "yes";
}
