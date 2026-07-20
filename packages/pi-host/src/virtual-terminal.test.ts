import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "./virtual-terminal.js";

function collector() {
  const chunks: string[] = [];
  return {
    chunks,
    onData: (data: string) => chunks.push(data),
    text: () => chunks.join(""),
  };
}

describe("VirtualTerminal", () => {
  it("forwards writes and cursor/clear operations as ANSI to onData", () => {
    const out = collector();
    const vt = new VirtualTerminal({ onData: out.onData });
    vt.write("hello");
    vt.moveBy(3);
    vt.moveBy(-2);
    vt.moveBy(0);
    vt.hideCursor();
    vt.showCursor();
    vt.clearLine();
    vt.clearFromCursor();
    vt.clearScreen();
    vt.setTitle("Panel");
    expect(out.text()).toBe(
      "hello\x1b[3B\x1b[2A\x1b[?25l\x1b[?25h\x1b[K\x1b[J\x1b[2J\x1b[H\x1b]0;Panel\x07",
    );
  });

  it("defaults to 100x32 and reports no kitty protocol", () => {
    const vt = new VirtualTerminal({ onData: () => {} });
    expect(vt.columns).toBe(100);
    expect(vt.rows).toBe(32);
    expect(vt.kittyProtocolActive).toBe(false);
  });

  it("routes input to the started handler and stops routing after stop", () => {
    const vt = new VirtualTerminal({ onData: () => {} });
    const received: string[] = [];
    vt.input("before-start"); // dropped, no handler yet
    vt.start(
      (data) => received.push(data),
      () => {},
    );
    vt.input("\r");
    vt.stop();
    vt.input("after-stop");
    expect(received).toEqual(["\r"]);
  });

  it("resize clamps, updates dimensions, and notifies", () => {
    const vt = new VirtualTerminal({ onData: () => {} });
    let resizes = 0;
    vt.start(
      () => {},
      () => {
        resizes += 1;
      },
    );
    vt.resize(120, 40);
    expect(vt.columns).toBe(120);
    expect(vt.rows).toBe(40);
    expect(resizes).toBe(1);

    // Same size is a no-op.
    vt.resize(120, 40);
    expect(resizes).toBe(1);

    // Out-of-range values clamp instead of breaking the TUI.
    vt.resize(1, 99999);
    expect(vt.columns).toBe(20);
    expect(vt.rows).toBe(1000);
    expect(resizes).toBe(2);
  });
});
