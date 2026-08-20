import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./src/sdk-adapters/install-host-sdk-adapters.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
