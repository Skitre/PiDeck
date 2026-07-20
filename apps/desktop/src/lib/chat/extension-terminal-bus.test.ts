import { describe, expect, it } from "vitest";
import {
  clearExtensionTerminal,
  pushExtensionTerminalFrame,
  subscribeExtensionTerminal,
} from "./extension-terminal-bus";

describe("extension-terminal-bus", () => {
  it("buffers frames before subscribe and replays them in order", () => {
    const received: string[] = [];
    pushExtensionTerminalFrame("r1", "one");
    pushExtensionTerminalFrame("r1", "two");
    const unsubscribe = subscribeExtensionTerminal("r1", (data) => received.push(data));
    expect(received).toEqual(["onetwo"]);
    pushExtensionTerminalFrame("r1", "three");
    expect(received).toEqual(["onetwo", "three"]);
    unsubscribe();
    clearExtensionTerminal("r1");
  });

  it("stops delivering after unsubscribe and re-buffers for the next subscriber", () => {
    const first: string[] = [];
    const unsubscribe = subscribeExtensionTerminal("r2", (data) => first.push(data));
    pushExtensionTerminalFrame("r2", "a");
    unsubscribe();
    pushExtensionTerminalFrame("r2", "b");
    expect(first).toEqual(["a"]);

    const second: string[] = [];
    subscribeExtensionTerminal("r2", (data) => second.push(data));
    expect(second).toEqual(["b"]);
    clearExtensionTerminal("r2");
  });

  it("clear drops buffered frames", () => {
    pushExtensionTerminalFrame("r3", "junk");
    clearExtensionTerminal("r3");
    const received: string[] = [];
    subscribeExtensionTerminal("r3", (data) => received.push(data));
    expect(received).toEqual([]);
    clearExtensionTerminal("r3");
  });

  it("keeps streams isolated per requestId", () => {
    const a: string[] = [];
    const b: string[] = [];
    subscribeExtensionTerminal("ra", (data) => a.push(data));
    subscribeExtensionTerminal("rb", (data) => b.push(data));
    pushExtensionTerminalFrame("ra", "for-a");
    pushExtensionTerminalFrame("rb", "for-b");
    expect(a).toEqual(["for-a"]);
    expect(b).toEqual(["for-b"]);
    clearExtensionTerminal("ra");
    clearExtensionTerminal("rb");
  });
});
