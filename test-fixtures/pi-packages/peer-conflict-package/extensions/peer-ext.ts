import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function peerConflictExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    return;
  });
}
