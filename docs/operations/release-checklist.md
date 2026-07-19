# Release Checklist — 临发布前必须走一遍生产级验证

> **提醒**：日常开发只跑轻量的 `pnpm verify:p0`（doc links + typecheck + test）。
> 它**不能**证明可发布。任何对外发布（installer 交付、tag、公开下载）之前，必须完整走完本清单。

## 0. 前提

- [ ] 仓库已 `git init` 且工作区干净（`git status` 无未提交变更）——完整门控会记录 commit SHA 并要求 `dirty:false`
- [ ] `pnpm-lock.yaml` 稳定后，`scripts/release-runtime.lock.json` 的 `pnpmLock.sha256` 与实际哈希一致（每次改依赖后需重新 pin）

## 1. 重新staging运行时（每次 lock 变更后必做）

```bash
pnpm package:sidecar:with-node   # 重新 staging 受控 Node/npm/Portable Git + sidecar，重写 STAGING.json
pnpm validate:resources
```

> 注意：`resources/` 下的 staged 运行时与 `STAGING.json` 不入库，clean checkout 后必须重新执行。

## 2. 完整生产级门控（一条命令聚合）

```bash
pnpm verify:release
```

等价于依次通过：docs 链接 → typecheck → build → 全量测试 → Rust 测试 → `package:release`（NSIS 安装包 + 哈希绑定）→ M0 扩展验证 → 真实桌面 E2E → 安装后 smoke（受控 PATH、install/uninstall、孤儿进程审计）→ git 元数据（真实 SHA + `dirty:false`）→ candidate/证据绑定。任一子门失败即整体失败。证据落在 `artifacts/p0/<run-id>/verify-p0.json`。

## 3. 发布前必须关闭的安全项

以下项在 [review remediation TODO](../reviews/2026-07-18-remediation-todo.md) 中跟踪：

- [x] 生产构建启用严格 CSP（2026-07-18 已完成；dev 模式 `devCsp: null` 保持 HMR 可用）
- [x] `desktop_open_path` 已收敛（仅存在的本地目录/文件；文件只定位不执行；拒绝 UNC）；`shell:allow-open` 已限定为 http(s) URL
- [x] `THIRD_PARTY_NOTICES.md` 已覆盖 Node.js / npm / Portable Git（GPLv2 源码可得性）/ Tauri
- [ ] 安装包 Authenticode 签名 + 发布流程中的验签（**需要代码签名证书**：拿到证书后填 `tauri.conf.json` 的 `certificateThumbprint` 与 `timestampUrl`，并在 `windows-installer-integrity.mjs` 中加验签步骤）
- [ ] 构建机无恶意软件、Windows Defender 实时保护开启（2026-07-17 安装包曾被构建机上的 "Synaptics" EXE 感染型蠕虫包裹并被完整性门控拦下，2026-07-19 已清除；`package:release` 的完整性检查是最后防线，不是唯一防线）

## 4. 发布后

- [ ] 归档本次 `artifacts/p0/<run-id>/`（FINAL_RELEASE.json + 各子门日志）作为该版本的发布证据
