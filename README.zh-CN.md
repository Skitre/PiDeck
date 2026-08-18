<div align="center">

# PiDeck

**[Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的原生桌面应用**

与你的编码智能体对话、实时查看工具调用、管理会话/模型/Packages —— 全部在一个可视化工作空间里。

[![CI](https://github.com/Skitre/PiDeck/actions/workflows/p0.yml/badge.svg)](https://github.com/Skitre/PiDeck/actions/workflows/p0.yml)
[![Release](https://img.shields.io/github/v/release/Skitre/PiDeck?include_prereleases)](https://github.com/Skitre/PiDeck/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](#下载安装)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) | [简体中文](./README.zh-CN.md)

<img src="docs/assets/readme/workspace-new-zh.png" alt="PiDeck 工作区中的新对话" width="840">

</div>

## 功能亮点

- **流式对话** —— 实时展示智能体的思考过程、工具调用和执行结果,一键停止生成,会话异常自动恢复。
- **会话与工作区** —— 跨项目浏览、搜索、创建和重新打开会话,对话历史完整恢复到离开时的状态。
- **模型与 Provider** —— 在界面里切换 Provider、模型和思考等级,每个对话的用量一目了然。
- **内置 Git** —— 查看变更、按 hunk 暂存/撤销、浏览分支历史,不用离开应用。
- **工作区 Dock** —— 浏览项目文件树、在提示词中引用文件、在内置浏览器标签中打开对话链接,并把终端常驻在对话旁边。
- **Packages** —— 浏览 pi.dev 目录,安装和管理用户级 Extensions、Skills、Prompts 和 Themes。
- **Extension UI 与终端** —— 扩展可以渲染自己的交互面板,集成的工作区终端一个快捷键即达。
- **顺手好用** —— PiDeck / Vercel / Apple 三套主题,自定义键盘快捷键和右键菜单,界面支持简体中文和 English。

![Extension 交互提问与 Git 改动面板](docs/assets/readme/features-1.png)

![Markdown 渲染、Extension 部件与分支历史](docs/assets/readme/features-2.png)

## 界面预览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/readme/workspace-sessions-apple-zh.png" alt="Apple 主题下的工作区">
      <br><sub>Apple 主题 · 工作区</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/readme/settings-appearance-zh.png" alt="外观设置中的 PiDeck、Vercel、Apple 三套主题">
      <br><sub>主题风格 · PiDeck / Vercel / Apple</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/readme/settings-models-apple-zh.png" alt="Apple 主题下的模型服务">
      <br><sub>Apple 主题 · 模型服务</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/readme/chat-tools-zh.png" alt="流式回复与工具调用">
      <br><sub>Vercel · 流式回复与工具</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/readme/dock-mcp-zh.png" alt="对话与 MCP 服务器 Dock">
      <br><sub>Vercel · 工作区 Dock / MCP</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/readme/chat-brainstorm-zh.png" alt="Brainstorm 模式浮层">
      <br><sub>Vercel · Brainstorm 浮层</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/readme/extension-ask-zh.png" alt="对话中的 Extension 交互提问">
      <br><sub>Vercel · Extension 交互提问</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/readme/packages-installed-zh.png" alt="已安装的用户级包">
      <br><sub>包管理 · 已安装</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/readme/packages-market-zh.png" alt="包市场目录">
      <br><sub>包管理 · 市场</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/readme/usage-zh.png" alt="用量看板与 Token 趋势">
      <br><sub>用量看板</sub>
    </td>
  </tr>
</table>

## 下载安装

从[最新 Release](https://github.com/Skitre/PiDeck/releases) 下载对应平台的安装包:

| 平台 | 文件 |
|---|---|
| Windows 11 x64 | `PiDeck_<version>_x64-setup.exe` |
| macOS Apple Silicon | `PiDeck_<version>_aarch64.dmg` |
| macOS Intel | `PiDeck_<version>_x64.dmg` |

这些安装包属于早期开发候选版,尚不是已验收、经平台认证的公开发行版。
PiDeck 会自动检查并原地安装更新。

> **早期测试版说明。** Windows 候选包尚未通过已验收的 Authenticode
> 签名;macOS 候选包可能使用 ad-hoc 签名,而不是 Developer ID 签名与公证。
> 因此 SmartScreen 或 Gatekeeper 可能发出警告或阻止运行。发布状态、验证
> 边界与签名进展见[发布说明](./docs/operations/release.md)。

## 与 Pi CLI 协同,但不依赖它

PiDeck 内置 Pi SDK(当前为 `0.82.1`)和独立的 Node 运行时,开箱即用:
不需要全局安装 `pi` 命令行或 Node;Windows 版还内置了 Git。

如果你同时使用 Pi CLI,两者共享 `~/.pi/agent`(认证、模型设置、用户级
Packages)和各工作区 `.pi` 目录(会话与历史)。PiDeck 不会加载或管理
`<workspace>/.pi` 中的项目级 Package。建议让 CLI 版本与 PiDeck 固定的
SDK 版本保持接近,并避免同时在两个应用中编辑同一个会话。

## 从源码构建

环境要求:[Node](./.node-version) ≥ 22.19.0、pnpm 9.15.0、Rust stable,以及
[Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。Windows 和
macOS 的工具链一键安装步骤见[开发指南](./docs/operations/development.md)。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @pideck/desktop run tauri:dev
```

首次启动需要编译 Tauri 应用,可能耗时数分钟;后续启动复用构建缓存。验证
代码可运行 `pnpm verify:quick`(文档、类型、JS/TS 测试)或
`pnpm verify:p0`(追加生产构建和 Rust 测试)。原生安装包通过
`pnpm package:release` 构建。

## 安全说明

PiDeck 只从 `~/.pi/agent` 加载用户级 Package。打开工作区不会执行
`<workspace>/.pi/extensions`。请只安装可信来源的 Packages。Provider
凭据、设置和会话属于 `~/.pi/agent` 下的用户数据，切勿提交到任何仓库。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/desktop` | React/Vite 界面与 Tauri 2 桌面宿主 |
| `packages/protocol` | Rust、Host 和 UI 进程间的类型化协议 |
| `packages/pi-host` | 持有 Pi SDK 的 Node sidecar |
| `docs` | [架构](./docs/architecture/overview.md)、[开发](./docs/operations/development.md)与[发布](./docs/operations/release.md)文档 |
| `scripts` | 验证、运行时 staging 与打包工具 |

更多内容见[文档索引](./docs/README.md)。

## 许可证

MIT —— 参阅 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 友情链接

- **[Linux DO](https://linux.do/)** — Linux DO：学AI，上L站！
