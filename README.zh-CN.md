# PiDeck

[English](./README.md) | [简体中文](./README.zh-CN.md)

PiDeck 是 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的桌面端界面。它将 Pi SDK 转化为一个可视化工作空间，用于管理对话、工具调用、会话、模型和 Packages。

> **P0 源码门禁：已通过。** `pnpm verify:p0` 目前已在 Apple Silicon Mac 上通过，覆盖文档检查、类型检查、单元测试与 Host 集成测试、前端生产构建和 Rust 测试。

PiDeck 现已可以从源码开始早期试用。签名安装包和发布级分发属于下一阶段：Windows 仍是当前的打包目标，macOS `.app` / DMG 打包尚未实现。

## 已实现功能

- 支持思考过程、工具调用与结果、停止生成和异常恢复的流式对话。
- 工作区与会话的浏览、创建、重新打开和状态恢复。
- Provider、模型、思考等级和用量控制。
- Extensions、Skills、Prompts 和 Themes 的 Package 管理。
- Extension UI 以及集成的工作区 Shell 终端。
- 通过 `~/.pi/agent` 和项目 `.pi` 目录与 Pi 共享数据。

PiDeck 当前固定使用 Pi SDK `0.80.7`。

## 平台状态

| 平台 | 从源码运行 | 安装包 |
|---|---:|---:|
| Windows 11 x64 | 支持 | 可生成开发用 NSIS；尚非签名的公开发行版 |
| macOS Apple Silicon | 早期试用 | 尚未实现 |

macOS 可以通过 `tauri:dev` 运行完整应用。Windows 专用的 `dev:fast` 和 `package:release` 工作流不应在 macOS 上使用。

## 快速开始

### 环境要求

- Node.js **22.19.0**
- pnpm **9.15.0**
- Rust stable
- [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

请使用指定的 pnpm 版本。pnpm 11 会忽略本仓库使用的 `patchedDependencies` 配置位置，从而可能安装错误的 Pi SDK 依赖树。

在 macOS 上进行桌面开发，只安装 Xcode Command Line Tools 即可：

```bash
xcode-select --install
```

在 macOS 上，可以通过 `fnm` 和 Corepack 安装项目所需的 Node 与 pnpm 版本：

```bash
brew install fnm
eval "$(fnm env --use-on-cd --shell zsh)"
fnm install 22.19.0
fnm use 22.19.0

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

### 安装并启动

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @pideck/desktop run tauri:dev
```

第一次启动需要编译 Tauri 应用，可能耗时数分钟；后续启动会复用 Rust 构建缓存。

## 不要求安装 Pi CLI

PiDeck 直接将 `@earendil-works/pi-coding-agent` 作为应用依赖使用，不会调用全局安装的 `pi` 可执行文件。因此，即使电脑上没有安装 Pi CLI，PiDeck 也可以正常使用。

PiDeck 默认使用 `~/.pi/agent`。如果以后安装 Pi CLI 并继续使用它的默认数据目录，CLI 与 PiDeck 可以共享：

- 会话和对话历史
- 认证信息和模型设置
- Packages、Extensions、Skills、Prompts 和 Themes

项目资源位于各工作区的 `.pi` 目录中；当两个应用打开同一个工作区时，这些资源也会共享。

为了获得最佳兼容性，建议让 CLI 版本与 PiDeck 固定的 SDK 版本保持接近。版本高出很多的 CLI 可能写入 SDK `0.80.7` 无法识别的设置或会话条目。不要同时通过 CLI 和 PiDeck 修改同一个会话。

## 验证代码

```bash
# 文档、类型检查以及全部 JavaScript/TypeScript 测试
pnpm verify:quick

# 完整 P0 源码门禁：快速检查、生产构建和 Rust 测试
pnpm verify:p0
```

如果首次下载 Rust 依赖时因为 crates.io 连接过慢而失败，可以使用以下命令重试：

```bash
CARGO_HTTP_TIMEOUT=600 CARGO_HTTP_LOW_SPEED_LIMIT=1 CARGO_NET_RETRY=10 pnpm test:rust
```

## 安全说明

选择工作区会立即授权并加载其中的项目资源，`.pi/extensions` 内的代码可以使用当前用户权限在本机执行。请只打开可信的工作区，并且只安装可信来源的 Packages。

Provider 凭据、设置、Packages 和会话属于用户数据。不要将 `~/.pi/agent` 中的文件提交到本仓库。

## 当前发布边界

P0 源码门禁通过，说明已经实现的核心功能能够完成构建并通过自动化检查；它本身并不代表某个可下载安装包已经通过发行认证。

公开发布前，项目仍需补齐平台原生打包证据和代码签名。Windows 开发候选安装包可通过以下命令生成：

```bash
pnpm package:release
```

该命令仅支持 Windows。macOS 打包、签名和公证仍属于后续工作。源码与发布边界的精确定义请参阅 [P0 范围与验证](./docs/operations/p0-scope.md)。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/desktop` | React/Vite 界面与 Tauri 2 桌面宿主 |
| `packages/protocol` | Rust、Host 和 UI 进程之间的类型化协议 |
| `packages/pi-host` | Node sidecar 与 Pi SDK 的唯一所有者 |
| `docs` | 架构、开发与发布文档 |
| `test-fixtures` | 用于测试的 Packages 和 Extensions |
| `scripts` | 验证、运行时 staging 与打包工具 |

## 文档

- [文档索引](./docs/README.md)
- [架构概览](./docs/architecture/overview.md)
- [开发指南](./docs/operations/development.md)
- [P0 范围与验证](./docs/operations/p0-scope.md)
- [发布说明与限制](./docs/operations/release.md)

## 许可证

MIT — 参阅 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
