import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resources = join(root, "apps", "desktop", "src-tauri", "resources");

// tauri-build validates configured bundle resource paths even during cargo test.
await Promise.all([
  mkdir(join(resources, "pi-host"), { recursive: true }),
  mkdir(join(resources, "node"), { recursive: true }),
  mkdir(join(resources, "git"), { recursive: true }),
]);

console.log("Prepared Tauri resource directories for Rust tests");
