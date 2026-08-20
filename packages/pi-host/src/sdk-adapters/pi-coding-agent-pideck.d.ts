/**
 * Host-owned PiDeck dialog hints. The SDK patch no longer adds `pideck`
 * onto ExtensionUIDialogOptions; this augmentation restores the type for Host.
 */
export interface PiDeckExtensionUIDialogOptions {
  presentation?: "inline" | "modal";
  sourceLabel?: string;
  correlationId?: string;
  risk?: "normal" | "high";
  allowFreeform?: boolean;
  optionDetails?: Array<{
    id: string;
    description?: string;
    destructive?: boolean;
  }>;
}

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionUIDialogOptions {
    pideck?: import("./pi-coding-agent-pideck.js").PiDeckExtensionUIDialogOptions;
  }

  interface ExtensionUIContext {
    editor(
      title: string,
      prefill?: string,
      opts?: import("@earendil-works/pi-coding-agent").ExtensionUIDialogOptions,
    ): Promise<string | undefined>;
  }
}
