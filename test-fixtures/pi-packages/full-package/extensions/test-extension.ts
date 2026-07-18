import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const testExtension: ExtensionFactory = (api: ExtensionAPI) => {
  api.on("session_start", async () => {
    return;
  });
};

export default testExtension;
