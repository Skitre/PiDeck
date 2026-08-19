import assert from "node:assert/strict";
import { test } from "node:test";
import { unexpectedSourceChanges } from "./verified-source-build.mjs";

test("ignores Tauri generated schema rewrites after cargo test", () => {
  assert.deepEqual(
    unexpectedSourceChanges(
      [
        " M apps/desktop/src-tauri/gen/schemas/windows-schema.json",
        " M apps/desktop/src-tauri/gen/schemas/desktop-schema.json",
        " M apps/desktop/src-tauri/gen/schemas/acl-manifests.json",
        " M apps/desktop/src-tauri/gen/schemas/capabilities.json",
      ].join("\n"),
    ),
    [],
  );
});

test("still fails closed on tracked source edits and untracked files", () => {
  assert.deepEqual(
    unexpectedSourceChanges(
      [
        " M apps/desktop/src-tauri/gen/schemas/windows-schema.json",
        " M packages/pi-host/src/main.ts",
        "?? scratch.ts",
      ].join("\n"),
    ),
    [" M packages/pi-host/src/main.ts", "?? scratch.ts"],
  );
});

test("normalizes Windows path separators in porcelain output", () => {
  assert.deepEqual(
    unexpectedSourceChanges(" M apps\\desktop\\src-tauri\\gen\\schemas\\windows-schema.json"),
    [],
  );
});
