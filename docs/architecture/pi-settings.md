# Pi settings files

Pi stores its settings as plain JSON, and hand-editing is an official mechanism:
the SDK preserves keys it doesn't know about (its own saves are scoped,
incremental writes under a file lock), and PiDeck's Settings → General →
**More settings** block reveals the file for exactly this workflow.

## Locations and precedence

| Scope | Path | Notes |
|---|---|---|
| Global | `<agentDir>/settings.json` | `<agentDir>` defaults to `~/.pi/agent`, overridable via `PI_CODING_AGENT_DIR` |
| Project | `<workspace>/.pi/settings.json` | Only loaded when the project is trusted |

Project settings deep-merge over global settings (project wins). PiDeck's More
settings block opens the **global** file. PiDeck hardcodes
`projectTrusted: false`, so a project file is not merged. Compaction and other
overrides live only in `~/.pi/agent/settings.json`.

## What takes effect in PiDeck

Settings are read from disk only when the Host creates its `SettingsManager`
(Host start / workspace open), so **restart the Host after editing** —
Settings → General → More settings has a restart button next to the file link.

Applied after a Host restart:

- `httpProxy`, `httpIdleTimeoutMs` — applied process-wide by the Host's network
  bootstrap (mirrors the Pi CLI entrypoint, which is the only place the SDK
  itself applies them; explicit `HTTP_PROXY`/`HTTPS_PROXY` environment
  variables win over the settings value)
- `compaction.reserveTokens`, `compaction.keepRecentTokens` — read live at every
  compaction decision
- `retry.maxRetries`, `retry.baseDelayMs`, `retry.provider.*` — read live at
  every retry decision
- `shellPath`, `shellCommandPrefix` — bash tool execution environment
- `npmCommand` — package install/update command (e.g. a mirror or pnpm)
- `thinkingBudgets.*` — thinking token budgets per level
- `images.blockImages`, `images.autoResize`
- `branchSummary.reserveTokens`, `branchSummary.skipPrompt`
- `websocketConnectTimeoutMs`

Never applied in PiDeck (writing them changes nothing):

- `sessionDir` — resolved at SessionManager construction; the Host always uses
  the default per-workspace session directories
- `defaultProjectTrust` — the Host hardcodes `projectTrusted: false`
- `enabledModels` — only consumed by the Pi CLI/TUI model list
- TUI-only keys (16): `theme`, `terminal.*`, `editorPaddingX`, `outputPad`,
  `autocompleteMaxVisible`, `showHardwareCursor`, `doubleEscapeAction`,
  `quietStartup`, `collapseChangelog`, `lastChangelogVersion`, `treeFilterMode`,
  `markdown.codeBlockIndent`, `externalEditor`, `showCacheMissNotices`,
  `hideThinkingBlock`, `enableSkillCommands`

## Caveat: a broken file silently suppresses saves

If the JSON is malformed, the SDK loads defaults, records a load error
(surfaced in the Host stderr log at startup), and — while the file stays
broken — silently suppresses its own future writes to it. Fix the syntax and
restart the Host to recover.
