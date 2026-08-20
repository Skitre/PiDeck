import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import crossSpawn from "cross-spawn";

/**
 * Same split as the SDK 0.82.1 `spawnProcess`: Windows goes through
 * `cross-spawn@7.0.6` so `.cmd` shims resolve; other platforms use Node spawn.
 */
export function spawnProcess(command: string, args: readonly string[], options: SpawnOptions) {
  return process.platform === "win32"
    ? crossSpawn(command, [...args], options)
    : nodeSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return process.platform === "win32"
    ? crossSpawn.sync(command, [...args], options)
    : nodeSpawnSync(command, [...args], options);
}
