# Pi Desktop 与 pi-web 对照及 P0 路线图

## 目标

Pi Desktop 已经完成 Pi SDK、模型与 thinking level、Session 恢复、流式消息、Pi Packages 和 Extension UI 的基础接入。下一阶段的目标不是复制 pi-web 的服务器界面，而是把当前的单会话桌面 GUI 升级为能够可靠监督多个 Pi Session 的本地工作台。

调研基线：

- [pi-web README](https://github.com/jmfederico/pi-web)
- [pi-web Changelog](https://github.com/jmfederico/pi-web/blob/main/CHANGELOG.md)
- [SessionSocket](https://github.com/jmfederico/pi-web/blob/main/src/client/src/sessionSocket.ts)
- [Session persistence](https://github.com/jmfederico/pi-web/blob/main/src/client/src/sessionPersistence.ts)
- [PI WEB plugin API](https://github.com/jmfederico/pi-web/blob/main/docs/plugins.md)

## 当前差距

### 已具备

- Pi SDK 0.80.7 是 Session、模型、工具、资源和 Package 的唯一事实来源。
- Workspace 选择、信任、恢复和 Host 崩溃重连。
- Session 创建、打开、列表、自动命名和 Transcript。
- prompt、steer、follow-up、abort、compaction 和 retry 状态。
- 模型与 thinking level 选择。
- Pi Package 安装、更新、移除、资源开关和 reload。
- Extension UI 的 select、confirm、input、editor、status、widget 和 notification。

### 关键缺口

1. Host 的 Workspace Graph 只有一个 `SessionManager` 和一个 `AgentSession`。打开另一个 Session 会释放旧运行时，因此不能后台并行。
2. Host 身份把 `sessionId/sessionRevision` 作为全局当前值，事件和请求不能独立路由到多个 Session。
3. Session 列表此前由页面组件持有，缺少跨页面的权威 Catalog、运行状态和每会话草稿。
4. Session 缺少搜索、手动重命名、归档、删除、reload 和批量清理。
5. Provider 认证仍依赖用户手工配置 Pi agent 目录。
6. 图片协议已经存在，但 Composer 和 Transcript 尚未提供附件体验。
7. `session.getStats` 尚未投射 token、context 和 cost。
8. Pi prompts、commands、skills 和 workspace files 缺少 `/`、`@` 补全入口。

## P0 范围

### P0.1 Session Catalog 与前端生命周期

状态：已实现，并已接入多 Session Host Runtime。

- 使用规范化的全局 Session Catalog，按 `sessionId` 保存摘要和运行状态。
- Session 列表只在 Host epoch 或 Workspace epoch 变化时清空，不受 Chat、Packages、Settings 页面切换影响。
- 将 active Session snapshot 投射为 `starting`、`running`、`queued`、`idle`、`error` 或 `inactive` 状态。
- 每个 Session 独立保存未发送草稿。
- `session.infoChanged` 同时更新 Catalog 和当前 Transcript 标题。

验收：

- 在 Chat、Packages、Settings 间切换，Session 列表和草稿不消失。
- 新建或打开 Session 后，Catalog 不依赖下一次 `session.list` 才能显示。
- Agent streaming、compaction、retry、queue 和 error 能反映在对应 Session 行。

### P0.2 多 Session Host Runtime

状态：多 Runtime 核心、前后台切换与 UI 重连状态恢复已实现，详细可观测性仍待完善。

已实现的 P0.2a：

- 新增严格校验的 `session.runtimeChanged` 事件。
- Host 可以在不修改全局当前 Session 的情况下，为指定 Session 身份发送事件。
- 事件序列仍由 Host 全局单调递增。
- React 将后台 Session 的 runtime 事件按 Workspace 接收，并只更新对应 Catalog 行，不污染当前 Transcript。

已实现的 P0.2b：

- 从运行中的 Session A 切换到 B 时，A 的 AgentSession、SessionManager、资源图和 Extension UI 绑定保留在后台。
- 不同 AgentSession 使用独立 operation lock，因此 A、B 可以同时 prompt/streaming。
- 后台 Agent 事件只发布 runtime 状态；不会写入当前 Session 的 Transcript 或 tools。
- 后台 Session 完成后自动释放运行时，持久记录继续由 Pi Session 文件负责。
- Package、Workspace 和全局 Settings 变更在任一后台 Session 存活时被阻止，避免资源图不一致。
- 后台 Extension UI 响应使用请求自身的 Session identity，不会误发给当前 Session。

已实现的 P0.2c：

- 点击运行中的后台 Session 会直接提升现有 Runtime，不重新读取 Session 文件，也不终止正在进行的 turn。
- 当前前台 Session 若仍在运行，会在同一事务中降级为后台 Runtime；若空闲则释放。
- 每次 promotion 分配新的单调递增 `sessionRevision`，并重建 snapshot/tools identity。
- Extension UI binding 支持 identity migration；未决请求和后续 status/widget/notification 不会因 promotion 丢失或串线。
- 后台 Extension status/widget 在前端被安全接收但不会覆盖当前 Session 的可见状态。
- `session.list` 返回前台及后台 Runtime 的状态和 Session revision；React 重载或 UI 重连后可恢复 Catalog 中的运行状态。

当前剩余项：Host 进程重启后的最终持久状态恢复、每 Session 的详细 activity/错误历史，以及针对真实长时间模型调用的桌面 E2E。

将当前单槽位结构：

```text
WorkspaceGraph
  sessionManager
  agentSession
  sessionSnapshot
```

改造成：

```text
WorkspaceRuntime
  shared Settings / Packages / Models
  activeSessionId
  SessionRuntimeRegistry
    sessionId -> SessionManager / AgentSession / snapshot / extensions / locks
```

约束：

- UI 当前选中的 Session 与后台运行的 Session 分离。
- Agent 请求按目标 `sessionId/sessionRevision` 路由，不再依赖 Host 的单一当前 Session。
- Event envelope 必须携带目标 Session 身份；全局 Host/Workspace revision 仍负责阻止跨 epoch 事件。
- 每个 Session 有独立 agent operation lock；Package/resource reload 使用 Workspace 级写屏障。
- Workspace 切换和 Host shutdown 必须 abort/dispose Registry 中的全部运行时。
- Extension UI 请求按 Session 排队，切换页面不能取消后台 Session 的请求。

验收：

- Session A 运行时可以打开 Session B，A 不被 abort。
- A、B 可以同时 streaming，事件不会串到另一份 Transcript。
- Host 重连后能够重新列出各 Session 的最终持久状态。
- Package reload 不会让不同 Session 使用不一致的资源图。

### P0.3 Session 管理

状态：已实现。

- 已实现侧边栏搜索和 Runtime 状态筛选。
- 已实现当前 idle Session 的行内重命名；运行中禁止重命名。
- 已实现 `.archive` 隔离的归档、恢复、永久删除和批量清理；Runtime 占用时禁止归档。
- 已实现 active idle Session 的 candidate-commit 磁盘 reload；运行中禁止 reload，失败时保留旧 Runtime。
- 已对新建 Session 使用乐观插入，并用服务端结果按 `sessionId` 去重。

### P0.4 Provider 配置、认证与诊断

状态：实现中。

- Settings 提供独立 Providers 工作区，支持自定义 Provider 的新增、修改、复制与删除。
- Provider 配置以 Pi 的 `models.json` 为唯一事实来源；React 只通过 Host 协议读写配置。
- API key 通过 Pi SDK `AuthStorage` 写入 `auth.json`，Host 只向客户端返回脱敏认证状态。
- 支持 Base URL、API 协议、Bearer Authorization、自定义 Headers 和模型参数。
- 支持从 Provider 拉取远端模型并手动添加模型；拉取结果与启用模型严格分离。
- 思考强度按“Provider 能力字段 → 已知模型档案 → 模型 ID 推测”自动识别，并允许逐模型手动覆盖 `thinkingLevelMap`。
- 远端模型只有被勾选后才写入 Provider 的 `models` 集合，也只有这些模型会出现在会话页模型框中。
- 取消勾选不会删除远端模型；重新刷新仍可发现。当前会话使用的模型不得在没有替代模型时被取消或删除。
- 保存前校验完整候选配置，保留未编辑 Provider 和未知字段，并通过临时文件、备份和原子替换提交。
- 用 Pi SDK 的公开认证能力列出 Provider 状态，并区分“已配置”与“已验证”。
- 支持 API key；Provider OAuth 和按协议发送真实测试请求作为后续增量。
- Provider 结构变更在任一 Session 运行时被阻止，避免共享 ModelRegistry 与运行时状态分裂。
- AUTH_REQUIRED 提示包含明确的 Provider、修复动作和重试入口。

## P1

- 图片粘贴、拖放、文件选择、缩略图和 Transcript 内联显示。
- `/` command/prompt 补全和 `@` workspace file 补全。
- Token、context window、cost 和 compaction 指示。
- Windows 完成、失败和等待确认通知。
- Command palette、可配置快捷键、Session 快速切换。
- 长对话增量加载、缓存、虚拟化和滚动位置恢复。
- 文件树、Git status/diff、worktree 和内置终端。

## P2/P3

- Agent 发起的独立 Session 与 tracked subsessions。
- Pi Package 提供桌面 action、workspace panel 和状态项的稳定插件 API。
- 多 Project 注册表。
- 远程 machine/fleet；仅在明确需要远程开发时引入。

## 不直接照搬 pi-web 的部分

- HTTP 网关、反向代理和浏览器上传路径白名单不是本地桌面 MVP 的前置条件。
- 不在 P0 引入任意浏览器 JavaScript 插件加载；它扩大信任边界且与 Pi Packages 有重叠。
- 不把 Pi Desktop 做成完整 IDE。文件预览、Git 和终端应围绕 Agent 工作流，而不是复制编辑器全部能力。
- Pi 的 TUI-only `ExtensionUIContext.custom` 不应伪装成兼容；桌面端只实现能稳定映射的公开能力。

## 实施顺序

1. P0.1 全局 Session Catalog、状态和草稿。
2. 协议 v2 身份设计与兼容测试。
3. P0.2 SessionRuntimeRegistry 和按 Session 路由的事件。
4. P0.3 Session 管理。
5. P0.4 Provider 认证与诊断。
6. P1 输入、可观测性和 Workspace 工具。
