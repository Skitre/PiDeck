import { describe, expect, it } from "vitest";
import { busySendMethod } from "./busy-send";

describe("busySendMethod", () => {
  it("defaults missing and follow-up settings to agent.followUp", () => {
    expect(busySendMethod(undefined)).toBe("agent.followUp");
    expect(busySendMethod("followUp")).toBe("agent.followUp");
  });

  it("uses agent.steer only when the setting is steer", () => {
    expect(busySendMethod("steer")).toBe("agent.steer");
  });
});
