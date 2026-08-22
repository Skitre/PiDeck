# Extension UI 界面

[English](./extension-ui-surfaces.md) | [简体中文](./extension-ui-surfaces.zh-CN.md)

本文盘点 Pi coding-agent **Extension UI 动词**（SDK 0.84.2）以及 PiDeck 现在怎么落地。姊妹篇是 [Extension presentation](./extension-presentation.md)（英文）：Presentation v1 契约、行内 / 模态路由、渲染器快照。Session 身份、队列和分组仍在 [Chat runtime](./chat-runtime.md)（英文）。

这不是实施计划。以后若做 Host 自有组件库，仍然从这些动词出发。

## 怎么判断一个扩展的 UI

在**调用时**按扩展实际调用的方法分类，不要静态扫包去猜它长得像不像 TUI。

- `ctx.hasUI` 在 TUI、RPC（以及 PiDeck）里为 true。对话框和通知可用。
- SDK 文档把 `ctx.mode === "tui"` 当作真终端能力的守卫（`custom()`、widget 工厂、页脚 / 页头工厂、活的 `onTerminalInput`）。
- `ui.custom()` 是不透明的：工厂返回 `@earendil-works/pi-tui` 组件树。Host 若不在构造后走一遍活树，分不出 `SettingsList` 和手写 `render()`。
- PiDeck 是**进程内 Host**，不是 SDK 那套 JSON stdin/stdout RPC 客户端。绑定走 `packages/pi-host/src/extension-ui-bridge.ts` 里的 `AgentSession.bindExtensions({ uiContext, mode: "rpc" })`。扩展因此看到 `mode: "rpc"`，但 Host 仍用 VirtualTerminal 实现 `custom()` 和 widget 工厂。不要拿 SDK RPC 模式的行为去套（RPC 会丢掉工厂，`custom()` 直接返回 `undefined`）。

## 动词一览

权威来源：`@earendil-works/pi-coding-agent` 的 `ExtensionUIContext`（`dist/core/extensions/types.d.ts`）。对话框选项是 `signal` 和 `timeout`。PiDeck 在阻塞对话框上额外接受可选的 `pideck` hint（呈现方式、风险、文案）。超时：`select` / `input` / `editor` 得到 `undefined`；`confirm` 得到 `false`。

状态含义：

- **已接线** — Host 发协议事件；Desktop 有对应界面。
- **快照** — 渲成纯文本 / xterm 帧；不是原生控件。
- **空操作** — 接住、忽略，或返回桩值。从不碰 SDK 私有 setter。

### 阻塞对话框

这四个是结构化的。Host 自有组件库不用拆 TUI 树就能映射。上游 RPC 也把同样四个当成请求 / 响应对话框。

| 方法 | TUI | 返回值 | PiDeck |
| --- | --- | --- | --- |
| `select(title, options, opts?)` | 有焦点的列表 | `string \| undefined` | 行内卡片或模态 |
| `confirm(title, message, opts?)` | 是 / 否 | `boolean` | 同上 |
| `input(title, placeholder?, opts?)` | 单行输入 | `string \| undefined` | 同上 |
| `editor(title, prefill?)` | 多行编辑 | `string \| undefined` | 同上（仍应用 `pideck` hint） |

路由（`legacy-modal` / `auto` / `inline-first`）、高风险 → 模态、以及调用来源，都以 Host 为准。见 [Extension presentation](./extension-presentation.md)。

### 即发即忘的外壳

| 方法 | TUI | SDK RPC | PiDeck |
| --- | --- | --- | --- |
| `notify(message, info\|warning\|error)` | 类似 toast 的提示 | 事件 | 通知中心 |
| `setStatus(key, text\|undefined)` | 页脚状态槽 | 事件 | 状态条 |
| `setWidget(key, string[] \| factory, { placement? })` | 贴在编辑器上方或下方的常驻条（默认 `aboveEditor`） | 只传字符串数组；工厂丢掉 | Widget 抽屉；工厂变成**只读**快照 |
| `setTitle(title)` | 终端 / 标签页标题 | 事件 | **空操作** |

TUI 字符串 widget 最多 **10 行**（`InteractiveMode.MAX_WIDGET_LINES`）。PiDeck 在事件上保留 `belowEditor`，其它 placement 都当默认（上方）槽。

### 流式加载指示

这四个都是 TUI 加载器外壳。SDK RPC 和 PiDeck 都是**空操作**。

| 方法 | TUI |
| --- | --- |
| `setWorkingMessage(message?)` | 流式加载文案 |
| `setWorkingVisible(visible)` | 显示 / 隐藏加载行 |
| `setWorkingIndicator(options?)` | 转圈帧 |
| `setHiddenThinkingLabel(label?)` | 隐藏 thinking 块的标签 |

### `custom(factory, options?)`

替换编辑器（或弹出 overlay），直到工厂调用 `done(result)`。选项：`overlay`、`overlayOptions`、`onHandle`。工厂参数是 `(tui, theme, keybindings, done)`，通常用 `@earendil-works/pi-tui` 原语拼（`SelectList`、`SettingsList`、`Input`、`Editor`、`Loader` / `CancellableLoader`、`Markdown`、`ScrollView`、`Box`、`HStack` / `VStack`、`Text`、`TruncatedText`、`Image`、`Spacer`）。

| Host | 行为 |
| --- | --- |
| TUI | 有焦点的组件；`handleInput` 生效 |
| SDK RPC | 返回 `undefined`；没有帧 |
| PiDeck | VirtualTerminal + xterm，走 `extensionUi.customFrame`；键盘 / 缩放转到该 Session 的 custom 请求 |

### 编辑器与 TUI 外壳

多数只在 TUI 里有意义。PiDeck 做成桩，避免扩展崩掉。

| 方法 | TUI | PiDeck |
| --- | --- | --- |
| `onTerminalInput(handler)` | 在焦点组件**之前**听 stdin；`{ consume: true }` 截键 | 空的 unsubscribe |
| `pasteToEditor` / `setEditorText` / `getEditorText` | 输入框 | 空操作 / `""` |
| `addAutocompleteProvider` | 叠在内置补全上 | 空操作 |
| `setEditorComponent` / `getEditorComponent` | 替换核心编辑器 | 空操作 / `undefined` |
| `setFooter` / `setHeader` | 替换 TUI 外壳 | 空操作 |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | 活主题 | 桩主题 `pideck-stub`；`setTheme` 返回 `{ success: false }` |
| `getToolsExpanded` / `setToolsExpanded` | TUI 转录里工具输出是否展开 | 恒为 `false` / 空操作 |

### 不是 `ctx.ui`，但也会改画面

| API | 作用 | PiDeck |
| --- | --- | --- |
| `pi.registerMessageRenderer` | 某种消息类型的自定义转录正文 | Host 渲折叠 / 展开的**纯文本快照**；没有扩展 HTML |
| `pi.registerEntryRenderer` | Session entry 渲染 | 已接线处走同一套快照 |
| `pi.registerMarkdownTransformer` | Markdown 改写 | 不是 Desktop 自有的 HTML 渲染器 |
| `pi.sendMessage` | 自定义转录消息 | 有 Presentation v1 就用；否则回退 / 活动行 |
| `pi.registerCommand` / `pi.registerShortcut` | 斜杠命令和快捷键 | 命令注册表；见 [Commands and menus](./commands-and-menus.md) |

`display: false` 的消息不进阅读流。配上已注册的渲染器，就是 **visible-anchor**：后面一条隐藏消息去改前面那条可见消息的渲染器状态。

## 输入路由和 `setWidget`

Widget 是**展示槽**，不是有焦点的控件。

Pi TUI 键盘分发（`@earendil-works/pi-tui` 的 `tui.js`）：

1. 先跑 `inputListeners`（也就是 `onTerminalInput`）。监听器可以 `{ consume: true }` 或改写 `data`。
2. 剩下的输入进 `focusedComponent.handleInput`。

Interactive mode 把焦点一直放在**输入框**上，除非对话框或 `custom()` 抢走。Widget 只是 `addChild` 进 `widgetContainerAbove` / `widgetContainerBelow`。TUI **从不**对 widget 做 `setFocus`，所以工厂里的 `handleInput` 基本是死的。

RPC 更窄：只发字符串行，没有工厂，也不等人回。

PiDeck 的工厂 widget 渲进 VirtualTerminal，`onData` 被忽略。抽屉里是快照：不能打字、不能聚焦、不能当迷你 TUI。

| 你想要的 | 该用的接口 |
| --- | --- |
| 一直看得见的摘要 | `setWidget` |
| 空闲时偷几个导航键 | TUI：`onTerminalInput` / `registerShortcut`，再 `setWidget` 重画 |
| 完整输入输出（列表、确认、打字） | `custom` / `select` / `confirm` / `input` / `editor` |

不要把 widget 做成可拖的交互式 TUI 面。

## PiDeck 现在把这些动词放哪

| 动词类别 | Desktop 界面 |
| --- | --- |
| 阻塞对话框 | 聊天里的行内请求卡，或 `ExtensionUiModal` |
| `notify` | 通知中心 |
| `setStatus` | 聊天状态条 |
| `setWidget` | Composer 旁的 widget 抽屉（`ExtensionWidgets.tsx`）；按 `aboveEditor` / `belowEditor` 分区 |
| `custom()` | xterm 自定义面板，绑在请求的 Session 身份上 |
| 自定义消息 / 渲染器 | 转录：Presentation v1、执行轨迹活动行，或渲染器快照 |
| `setTitle`、加载器 API、编辑器外壳、`onTerminalInput` | 未使用 |

后台 Session 保留请求上捕获的 Host 身份。响应、输入、缩放 RPC 必须对上那个 owner。

## 用例：`pi-subagents`

已发布的 **`npm:pi-subagents`**（用户级扩展）不是 SDK 内置。SDK 的 `examples/extensions/subagent/` 更瘦：`registerTool` + `exec` 拉起子进程，再用 `ui.confirm` 管项目级 agent。两套不要混。

发布包几乎把上面这些会动画面的动词都用了一遍：

| 能力 | 接口 | TUI |
| --- | --- | --- |
| FleetView | `setWidget`，默认 `belowEditor` | 编辑器下的紧凑摘要。方向键浏览**不是** widget 焦点；靠 `onTerminalInput` / 快捷键，再重画 widget |
| Fleet 检查器 | `ui.custom()`（`/subagents-fleet`，另有快捷键） | 有焦点的 TUI：选子代理、看 transcript、steer、确认后 stop |
| Doctor | `registerMessageRenderer` + `sendMessage` | 先发一条可见消息；再发一条 **隐藏** 收尾（`display: false`）去改同一渲染器 |
| 主管协调 | `sendMessage`，`customType: "subagent_supervisor_request"` | 转录里的 agent 协议文本，不是可点控件 |
| 斜杠命令结果 | custom type + 渲染器 | 转录 |
| 停止选择 / 确认 | `select` / `confirm` | 对话框 |
| 编辑 agent 提示 | `editor` | 对话框 |
| 失败 / 暂停完成 | `notify` | 成功则保持安静 |
| RPC Host | 行首为 `PI_SUBAGENT_*_JSON:` 的 widget | 给 RPC 客户端的传输；**不要**当作用户 widget 来画 |

PiDeck 现在**没有 FleetView，也没有 fleet 检查器**。转录侧覆盖：

- 旧的 `subagent_supervisor_request` → Presentation v1 `audience: "agent"` 活动行，进执行轨迹。**不要**解析 `Reply with:`。
- Doctor 那种隐藏消息的渲染器快照；Desktop 用 `messageIndex` 对活的尾部，持久化行用 entry ID。
- 扩展兼容矩阵只模仿了一部分动词，不是那个发布包。

Subagents 仍是 PiDeck 产品范围里的 **SDK 非目标**（见 `docs/history/2026-07-30-product-ux-review.md`）。兼容要做到转录和对话框保真，不是去克隆 TUI 的 fleet 界面。

## Host 自有映射的笔记

> **正式目标（2026-08-22）**：[Extension Deck](./extension-deck.md) 是 Host
> 自有 Extension 表面和全局逐 Extension 展现设置的实施合同。更宽泛的
> [Deck](./deck.md) pane 工作台方案已经被取代，不得据此实现。下面的笔记
> 仅保留原始推理。

若 PiDeck 以后按「Pi 的方式」重画 Extension UI（Host 自有组件，不要扩展自带的 HTML / React）：

1. 先做 **动词 → 组件**，再做 **放置表**（行内卡、模态、状态条、widget 抽屉、自定义面板，再往后是窗内 overlay）。一个 TUI 动词可以落到不止一个 PiDeck 槽。
2. 保留 Presentation v1、行内 / 模态策略、调用来源，以及高风险 → 模态。
3. `custom()` 走双路径：可选地走一遍活的 `pi-tui` 树，认出已知组件（`SettingsList`、`SelectList` 等）；认不出就继续用 xterm。
4. 先做**窗内 overlay**，再考虑操作系统级额外窗口。Desktop 已经有原生子 webview 扛 HTML 类模态（`browser_surface`）。窗外浮层是桌面原生能力，不是 TUI 动词。
5. 不要给 `setWidget` 发明交互。仪表盘若需要按键：TUI 里是 `onTerminalInput` / 命令；PiDeck 里是 Host 控件（按钮、快捷键）——不是给 widget 焦点。

若动手，建议顺序：动词 → 组件 → 放置表 → `custom()` 双路径 → 窗内浮层 → 最后才是 OS 窗口。

## 当前非目标

- 为 `defaultTools` / `agent.getTools` / `agent.setActiveTools` 做 Composer **工具面板**。协议方法可以留着；面板不属于这张界面表。
- 在转录或 widget 抽屉里执行扩展的 HTML、CSS 或 React。
- 把 widget 工厂当成迷你可交互 TUI，或可拖的 TUI 窗口。
- 静态检测「这个包长得像 TUI」。
- 把 FleetView / fleet 检查器做成 PiDeck 一等公民外壳。

## 实现指针

| 层 | 路径 |
| --- | --- |
| SDK 类型 | `@earendil-works/pi-coding-agent` `ExtensionUIContext` |
| TUI widget / 焦点 | `interactive-mode.js` 的 `setExtensionWidget`、`renderWidgetContainer` |
| TUI 输入 | `pi-tui` 的 `tui.js`：先 listeners，再 `focusedComponent` |
| Host 桥 | `packages/pi-host/src/extension-ui-bridge.ts` |
| 路由策略 | `packages/pi-host/src/extension-ui-policy.ts` |
| Desktop widget | `apps/desktop/src/features/chat/ExtensionWidgets.tsx` |
| Desktop 模态 | `apps/desktop/src/features/chat/ExtensionUiModal.tsx` |
| 主管适配 | `apps/desktop/src/features/chat/transcript-model.ts` |
