/**
 * M0/R1 fixture Extension — marker written ONLY inside session_start handler.
 * Harness must not write the success marker itself.
 *
 * Env:
 *   PI_DESKTOP_SPIKE_NONCE  — required random nonce for this run
 *   PI_DESKTOP_SPIKE_MARKER — absolute path for the marker file
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION as SDK_VERSION } from "@earendil-works/pi-coding-agent";

export default function spikeExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const nonce = process.env.PI_DESKTOP_SPIKE_NONCE;
    const marker = process.env.PI_DESKTOP_SPIKE_MARKER;
    if (!nonce || !marker) {
      throw new Error("spike-extension: missing PI_DESKTOP_SPIKE_NONCE or PI_DESKTOP_SPIKE_MARKER");
    }
    // source path best-effort from stack / import meta
    const sourcePath = import.meta.url;
    const body = [
      `nonce=${nonce}`,
      `sdk=${SDK_VERSION}`,
      `source=${sourcePath}`,
      `ts=${new Date().toISOString()}`,
      `handler=session_start`,
    ].join("\n");
    writeFileSync(marker, body + "\n", "utf8");
  });
}
