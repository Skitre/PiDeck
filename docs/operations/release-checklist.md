# Release Checklist — 临发布前必须走一遍生产级验证

> **当前暂停。** 本文保留为首次公开发布前恢复自动化验证时的设计参考；
> 文中发布级命令目前不可用。开发阶段打包使用 `pnpm package:release`。

> 日常迭代运行 `pnpm verify:quick`；PR 必须通过 `pnpm verify:p0`。
> 两者都不能证明安装包可发布。范围定义见 [P0 scope](./p0-scope.md)。

## 0. 前提

- [ ] 仓库已 `git init` 且工作区干净（`git status` 无未提交变更）——完整门控会记录 commit SHA 并要求 `dirty:false`
- [ ] `pnpm-lock.yaml` 稳定后，`scripts/release-runtime.lock.json` 的 `pnpmLock.sha256` 与实际哈希一致（每次改依赖后需重新 pin）
- [ ] `docs/operations/p0-status.json` 中所有实现项均为 `implemented`；`claimStatus` 在正式接受证据前仍为 `not-complete`
- [ ] CI `pideck-release` environment 已启用审批；runner 具有 `self-hosted, Windows, X64, pideck-release` 标签并从干净快照启动

## 1. 重新staging运行时（每次 lock 变更后必做）

```bash
pnpm package:sidecar:with-node   # 可选：单独检查 staging；package:release 会在发布门内自动执行
pnpm validate:resources
```

- [ ] `resources/pi-host/STAGING.json` records `stageTimingsMs` and a hoisted
  staging strategy; the compacted release contains `node_modules.zip` but no
  expanded `node_modules` or redundant `.pnpm` tree

> 注意：`resources/` 下的 staged 运行时与 `STAGING.json` 不入库，clean checkout 后必须重新执行。

## 2. Core 发布门

```bash
pnpm verify:release
```

依次通过：docs → typecheck → build → tests → Rust → `package:release`
→ core WebView2 E2E（settings migration visibility、prompt、stream、tool、abort、Host restart/rehydrate）
→ 安装后 core smoke → install/uninstall/orphan audit → Git 元数据和
candidate binding。证据写入
`artifacts/p0/<run-id>/verify-release.json`，必须记录 `profile:"core"`。

## 3. Full 回归门

```bash
pnpm verify:release:full
```

full workflow 在同一次桌面进程内先覆盖 core chat，再覆盖 Package/Extension；
另加 staged Host 的 M0 direct-only proof。候选目录和安装目录各启动一次 full
桌面，不再重复启动 core/M0 桌面。覆盖 local/npm/git Package、Project
Package 操作确认、资源持久化、错误中心和 Extension UI。Nightly 和正式 Release Candidate
必须运行 full profile。

## 4. 发布前必须关闭的安全项

以下项在 [review remediation TODO](../history/2026-07-18-remediation-todo.md) 中跟踪：

- [x] 生产构建启用严格 CSP（2026-07-18 已完成；dev 模式 `devCsp: null` 保持 HMR 可用）
- [x] `desktop_open_path` 已收敛（仅存在的本地目录/文件；文件只定位不执行；拒绝 UNC）；`shell:allow-open` 已限定为 http(s) URL
- [x] `THIRD_PARTY_NOTICES.md` 已覆盖 Node.js / npm / Portable Git（GPLv2 源码可得性）/ Tauri
- [ ] 安装包 Authenticode 签名 + 发布流程中的验签（**需要代码签名证书**：拿到证书后填 `tauri.conf.json` 的 `certificateThumbprint` 与 `timestampUrl`，并在 `windows-installer-integrity.mjs` 中加验签步骤）
- [ ] 构建机无恶意软件、Windows Defender 实时保护开启（2026-07-17 安装包曾被构建机上的 "Synaptics" EXE 感染型蠕虫包裹并被完整性门控拦下，2026-07-19 已清除；`package:release` 的完整性检查是最后防线，不是唯一防线）

## 5. 证据验收

- [ ] `verify-release.json.status === "passed"`
- [ ] `commit` 是当前发布提交，`dirty === false`
- [ ] core：`candidateBound === true`、`p0Complete === true`
- [ ] full：`profile === "full"`、`p0Complete === true`、`releaseComplete === true`
- [ ] `FINAL_RELEASE.json`、E2E 截图和所有子门日志已上传 CI artifact

安装 smoke 的进程清理和孤儿审计只匹配候选安装目录。即使如此，release
runner 仍必须专用或可还原，因为预安装阶段会卸载/清理已知 PiDeck 安装根。

## 6. 发布后

- [ ] 归档本次 `artifacts/p0/<run-id>/`（FINAL_RELEASE.json + 各子门日志）作为该版本的发布证据
- [ ] 证据经人工接受后，在后续文档提交中把 `p0-status.json.claimStatus` 改为 `complete`，填写被验证提交、profile、evidence path、`candidateBound` 和 `p0Complete`；不要在 release 运行中修改 tracked 文件
