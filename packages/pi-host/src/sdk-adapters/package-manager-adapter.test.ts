import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import "./install-host-sdk-adapters.js";
import { installPackageManagerAdapter } from "./package-manager-adapter.js";

describe("package-manager adapter", () => {
  it("is idempotent and installs setOperationSignal", () => {
    installPackageManagerAdapter();
    installPackageManagerAdapter();
    expect(typeof DefaultPackageManager.prototype.setOperationSignal).toBe("function");
  });
});
