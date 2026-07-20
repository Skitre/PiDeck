/**
 * C6 Extension UI fixture — blocking UI only when hasUI (after bindExtensions).
 * Marker written ONLY inside the Extension handler, never by harness.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let invocationCount = 0;

export default function uiBlockingExtension(pi: ExtensionAPI) {
  pi.registerFlag("ui-fixture-active", {
    description: "Verifies the extension runtime remains active across session replacement",
    type: "boolean",
    default: true,
  });

  pi.on("session_start", async (_event, ctx) => {
    // During createAgentSession, UI may not be bound yet — skip blocking path
    if (!ctx.hasUI || !ctx.ui) {
      return;
    }
    const marker = process.env.PIDECK_UI_MARKER;
    if (!marker) {
      throw new Error("ui-blocking-extension: missing PIDECK_UI_MARKER");
    }
    const nonce = process.env.PIDECK_UI_NONCE;
    if (!nonce) {
      throw new Error("ui-blocking-extension: missing PIDECK_UI_NONCE");
    }
    invocationCount += 1;
    const runtimeActive = pi.getFlag("ui-fixture-active") === true;
    const ui = ctx.ui;
    ui.setStatus("ui-fixture", "running");
    ui.notify("ui-fixture-start", "info");

    const selected = await ui.select("Pick fixture option", ["alpha", "beta", "gamma"]);
    const confirmed = await ui.confirm("Confirm fixture", "Proceed with beta?");
    const typed = await ui.input("Fixture input", "type here");

    // ui.custom round-trip: inline component (no pi-tui import — the fixture
    // runs from a tmpdir where runtime deps do not resolve).
    const options = ["one", "two", "three"];
    let index = 0;
    const customPicked = await ui.custom<string>((tui, _theme, _keybindings, done) => ({
      render: () => options.map((option, i) => (i === index ? `> ${option}` : `  ${option}`)),
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "\x1b[B") index = Math.min(options.length - 1, index + 1);
        else if (data === "\x1b[A") index = Math.max(0, index - 1);
        else if (data === "\r") {
          done(options[index]!);
          return;
        }
        tui.requestRender();
      },
    }));

    const body = [
      `selected=${selected ?? ""}`,
      `confirmed=${String(confirmed)}`,
      `typed=${typed ?? ""}`,
      `customPicked=${customPicked ?? ""}`,
      `handler=session_start`,
      `hasUI=true`,
      `nonce=${nonce}`,
      `invocationCount=${invocationCount}`,
      `runtimeActive=${String(runtimeActive)}`,
      `ts=${new Date().toISOString()}`,
    ].join("\n");
    writeFileSync(marker, body + "\n", "utf8");
    ui.setStatus("ui-fixture", undefined);
  });
}
