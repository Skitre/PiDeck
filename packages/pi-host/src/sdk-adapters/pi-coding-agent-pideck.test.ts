import { describe, expect, it } from "vitest";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { PiDeckExtensionUIDialogOptions } from "./pi-coding-agent-pideck.js";

function readPideck(options: ExtensionUIDialogOptions): PiDeckExtensionUIDialogOptions | undefined {
  return options.pideck;
}

async function callEditor(
  ui: Pick<ExtensionUIContext, "editor">,
  options: ExtensionUIDialogOptions,
): Promise<string | undefined> {
  return ui.editor("title", "", options);
}

describe("PiDeck ExtensionUIDialogOptions augmentation", () => {
  it("types pideck on SDK dialog options and editor(opts)", async () => {
    const options: ExtensionUIDialogOptions = {
      timeout: 1,
      pideck: { presentation: "modal", sourceLabel: "Host" },
    };
    expect(readPideck(options)).toEqual({ presentation: "modal", sourceLabel: "Host" });
    await expect(callEditor({ editor: async () => "ok" }, options)).resolves.toBe("ok");
  });
});
