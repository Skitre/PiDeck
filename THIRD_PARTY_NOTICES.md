# Third Party Notices

This file records third-party software distributed with or adapted into Pi Desktop Manager.

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
  in the lock file. Distributions of Pi Desktop Manager must keep this notice
  and the pinned tag so recipients can obtain the source.

### Tauri

- Crates: `tauri` 2.x, `tauri-plugin-dialog`, `tauri-plugin-shell` (see
  `apps/desktop/src-tauri/Cargo.toml` / `Cargo.lock` for exact versions)
- Role: desktop shell, IPC, packaging
- License: MIT OR Apache-2.0
- Source: <https://github.com/tauri-apps/tauri>

## @earendil-works/pi-coding-agent

- Package: `@earendil-works/pi-coding-agent@0.80.7`
- Role: Sole Agent / Session / Package / Resource runtime (Node Pi Host)
- License: As published with the npm package

## Other runtime dependencies

JavaScript dependencies (React, Zustand, Streamdown/shiki, Tailwind CSS,
lucide-react, and transitive packages) are MIT or similarly permissive; see
each package's `package.json` and the root `pnpm-lock.yaml` for exact versions
and license fields. Rust dependencies are recorded in
`apps/desktop/src-tauri/Cargo.lock`.
