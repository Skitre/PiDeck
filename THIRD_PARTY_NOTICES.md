# Third Party Notices

This file records third-party software distributed with or adapted into PiDeck.

## Bundled runtimes (shipped inside the Windows installer)

The Windows release bundles the following third-party runtimes under
`resources/` (staged by `scripts/prepare-release-runtime.mjs` and the sidecar
packaging pipeline; exact pinned versions and archive hashes live in
`scripts/release-runtime.lock.json`):

### Node.js

- Version: pinned in `scripts/release-runtime.lock.json` (`node.version`)
- Role: runs the Pi Host sidecar (`resources/node/node.exe`)
- License: MIT-style Node.js license, with bundled components under their own
  licenses — the full text ships in `resources/node/LICENSE`
- Source: <https://nodejs.org/>

### npm

- Bundled with the Node.js distribution above (`resources/node/npm.cmd`)
- Role: controlled package installs performed by the Pi Host
- License: Artistic License 2.0 (included in the Node.js distribution's
  `LICENSE` file)
- Source: <https://github.com/npm/cli>

### Portable Git (Git for Windows)

- Version: pinned in `scripts/release-runtime.lock.json` (`git.portable`)
- Role: git operations for package installs (`resources/git/`)
- License: **GNU General Public License v2.0** (with bundled components —
  MSYS2, OpenSSH, curl, etc. — under their own licenses; license texts ship
  inside the portable distribution)
- Source code availability (GPLv2 §3): the complete corresponding source is
  published by the Git for Windows project at
  <https://github.com/git-for-windows/git> for the exact tagged release pinned
  in the lock file. Distributions of PiDeck must keep this notice
  and the pinned tag so recipients can obtain the source.

### Tauri

- Crates: `tauri` 2.x, `tauri-plugin-dialog`, `tauri-plugin-shell` (see
  `apps/desktop/src-tauri/Cargo.toml` / `Cargo.lock` for exact versions)
- Role: desktop shell, IPC, packaging
- License: MIT OR Apache-2.0
- Source: <https://github.com/tauri-apps/tauri>

## Pi SDK family (`@earendil-works/pi-*`)

Pi Host ships this family at the exact versions pinned in
`packages/pi-host/package.json` and verified by
`scripts/release-sdk-evidence.mjs` (`PI_SDK_PACKAGES`). Current pin: **0.84.2**.

| Package                           | Role                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `@earendil-works/pi-ai`           | LLM API / model discovery                                                 |
| `@earendil-works/pi-agent-core`   | Agent core (lock-resolved; Host does not import it directly)              |
| `@earendil-works/pi-coding-agent` | Agent / Session / Package / Resource runtime (Node Pi Host; pnpm-patched) |
| `@earendil-works/pi-tui`          | TUI used by Extension UI                                                  |
| `@earendil-works/pi-client`       | SDK client protocol boundary (lock-resolved)                              |
| `@earendil-works/pi-protocol`     | SDK protocol (lock-resolved; not `@pideck/protocol`)                      |
| `@earendil-works/pi-telemetry`    | Telemetry contracts used by `pi-ai` / `pi-agent-core` (lock-resolved)     |

- License: MIT, as published with each npm package
- Source: <https://github.com/earendil-works/pi>

## Other runtime dependencies

JavaScript dependencies (React, Zustand, Streamdown/shiki, Tailwind CSS,
lucide-react, and transitive packages) are MIT or similarly permissive; see
each package's `package.json` and the root `pnpm-lock.yaml` for exact versions
and license fields. Rust dependencies are recorded in
`apps/desktop/src-tauri/Cargo.lock`.
