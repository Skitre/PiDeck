# Pi SDK 0.82.1 → 0.84.2 升级计划（执行稿）

> **状态：** 2026-08-20 外部 Review 结论为 **Accept with changes**。本文件是实施唯一权威稿。Cut 1 与 Cut 2 均已落地，且 Windows 权威门（`verify:quick` / build / rust / clippy / sidecar / staged smoke）已绿。SDK 钉 `0.84.2`；残留 patch 为 invocation ownership + Windows `shell.js`。产品版本 `0.2.2`。工作区尚未提交。
> 历史手顺（不要当本次 playbook）：[`pi-sdk-0.82.1-handoff.md`](./pi-sdk-0.82.1-handoff.md)、[`pi-sdk-0.82.1-api-notes.md`](./pi-sdk-0.82.1-api-notes.md)。
> 审计笔记：仓库根 `findings.md`。任务切片：仓库根 `task_plan.md`。

截至 2026-08-20：六个相关包 `dist-tags.latest` 均为 **0.84.2**；Git tag 与 npm `gitHead` 指向 **`914cf147`**。目标版本正确。Cut 2 开头必须再查一次 latest，不能只重 pack 硬编码版本。

---

## 0. Review 吸收了什么（相对上一份「独立 Review 稿」）

上一份稿不能直接执行。三个阻断项已核验属实：

| ID | 原主张 | 事实 | 本稿改法 |
|---|---|---|---|
| T8 / `model: null` | `sdk.{js,d.ts}` 只是类型/符号导出 | 补丁把 `model?: Model \| null` 做成「禁止自动选模型」。`createHostAgentSession` 在无合格模型时传 `null`（`agent-session-factory.ts`）。0.84.2 恢复 `model?: Model`，空值走 `findInitialModel()`，会复活被 PiDeck 禁用的 Provider | Host 统一 sentinel `PIDECK_NO_MODEL`，创建 Session 和 `clearSessionModel()` 共用。证伪才留 `sdk.js/.d.ts` 最小 null hunk |
| P8 范围 | 只改 `runner.js`；`wrapper.js` 碰了就回滚 | `bindExtensions({ invocationRunner })` 在 0.84.2 不被识别；reload 新建 Runner 也不会重绑。`sdk-invocation-runner.test.ts` 还锁住 Extension **tool** 路径；新 `wrapper.js` 直接 `execute()` | P8 = agent-session 绑定 + runner 事件包裹 + **按新结构重写** wrapper tool 包裹 + 类型/根导出。禁止套用旧 wrapper hunk，允许改新 wrapper |
| P1–P3 | 包装三个 spawn 方法即可 | `setOperationSignal` 必须进 `spawnProcess({ signal })`；`update` 原方法没有 scope 参数；`runCommand` / `runCommandCapture` 被重写成 `waitForChildProcess` + 管道排空，测试锁住后代占管和 stderr | Cut 1 对 P1–P3 做 timebox spike；复刻不了就保留最小 `package-manager.js` patch |

其它已采纳的调整：

- P4、P5 都留在 `shell.js`。
- 完成定义按**行为**计，不按 patch 文件数。
- 一个 PR、多个可独立绿的有序 commit。Cut 1 **必须**更新 `release-runtime.lock.json` 的 `sdkPatchSha256` 与 `pnpmLock.sha256`，否则 `verify:quick` → `verify:release-metadata` 会因 SHA 漂移失败。Cut 2 再写成最终 0.84.2 值。PR 只合一次，所以 `main` 仍只收到最终 evidence。
- 产品版本 **0.2.2**，Commit 8 有明确文件清单和一致性断言。
- `PI_SDK_PACKAGES` 扩到七个（含 `pi-telemetry`）。OAuth `refreshToken` 列为 Cut 2 必搜，含动态 Extension/fixture。

### 2026-08-20 第二轮 Review（仍 Accept with changes）

| ID | 问题 | 本稿改法 |
|---|---|---|
| P1 evidence | 「中间 commit 独立绿」与「只在 Cut 2 pin evidence」矛盾：`verify:quick` 含 `verify:release-metadata`，patch/lock SHA 任一漂移即失败 | Cut 1 改 patch 或 `pnpm-lock.yaml` 的 commit **当场**更新那两个 SHA；Cut 2 再更新为最终值 |
| P2 snapshot | `extensionRunner.emit("model_select")` 只通知 Extension，不更新 `graph.sessionSnapshot`，Provider RPC 也不带 Session | `reconcileIdleActiveSessionModel` 清模型后 `buildSessionSnapshot` → 赋给 `graph.sessionSnapshot` → `server.emit("session.snapshot")`；revision 不变 |
| P2 spawn | coding-agent export map 只有 `.` 和 `./rpc-entry`，不能合法调用 `spawnProcess` / `waitForChildProcess` | spike 成功 = Host 直依 `cross-spawn@7.0.6` + 抄 wait helper；不接受新依赖 = spike 失败留 PM patch。删除第三分支 |
| P2 0.2.2 | 只写了一句版本号 | Commit 8 列出全部落点文件，并加版本一致性断言（进 `verify:release-metadata`） |

---

## 1. 可核验的现状

产品：PiDeck，Tauri 桌面壳 + `@pideck/pi-host` 进程内嵌 Pi Coding Agent。当前 git：`main`，产品版本 **0.2.1**。

### 1.1 钉住的 SDK

| 位置 | 内容 |
|---|---|
| `packages/pi-host/package.json` | `"@earendil-works/pi-{ai,coding-agent,tui}": "0.82.1"` |
| 根 `package.json` `pnpm.patchedDependencies` | `"@earendil-works/pi-coding-agent@0.82.1"` → `patches/@earendil-works__pi-coding-agent@0.82.1.patch` |
| Host hello | `sdkVersion: SDK_VERSION`（来自 coding-agent 的 `VERSION`） |
| Node 下限 | 上游仍 `engines.node >= 22.19.0`；CI 是 Node 22 `verify:quick` + Node 24 `verify:p0` |

0.84.2 会再拉 **`@earendil-works/pi-client`**、**`@earendil-works/pi-protocol`**（与本仓库 `@pideck/protocol` 不是同一个包）和 **`@earendil-works/pi-telemetry`**。七个包必须同版本。

审计 tarball SHA（2026-08-20；Cut 2 在 freshness gate 通过后再 pack）：

```
0262785a76b0eb2eec596cd8a7ab2ee23eef89d2ef1bb1211c4f0a1944dacf41  earendil-works-pi-ai-0.84.2.tgz
95b899cd7b1a0c1f0174c7bf33ab427435e3553a7d1f4756661aa9c7f1a68ffa  earendil-works-pi-coding-agent-0.84.2.tgz
3abec26d852a9574fd341b8b4984277fc76dabb57a0360df4c19cc1fc0df993e  earendil-works-pi-tui-0.84.2.tgz
565b5d2c6f6c09ff69d915d28692a15d72dedc43a7dbe41fb422bb4bfad3bdcf  earendil-works-pi-agent-core-0.84.2.tgz
```

### 1.2 现有 dist 补丁（按真实行为，不是「文件名印象」）

`patches/@earendil-works__pi-coding-agent@0.82.1.patch`：

| dist 文件 | 实际行为 |
|---|---|
| `core/sdk.{js,d.ts}` | **`model: null` 禁止自动选模型**（`autoSelectModel = options.model !== null`，跳过 restore 与 `findInitialModel`）。不是单纯 re-export |
| `core/agent-session.{js,d.ts}` | `clearModel()` 写入 `NO_MODEL` sentinel + `setThinkingLevel("off")` + `_emitModelSelect`；`ExtensionBindings.invocationRunner` 保存到字段；`_applyExtensionBindings` 调 `runner.setInvocationRunner`；reload 时 `hasBindings` 计入 invocationRunner |
| `core/extensions/runner.{js,d.ts}` | 每个 event handler 经 `invokeExtension` / `invocationRunner`，带该扩展的 `sourceInfo` |
| `core/extensions/wrapper.js` | Extension **tool** `execute` 同样走 `runner.invokeExtension({ kind: "tool", ... })` |
| `core/extensions/{index,types}.d.ts`、`index.d.ts` | invocation 类型、`ExtensionUIDialogOptions.pideck`、根导出 |
| `core/package-manager.{js,d.ts}` | `env`；`setOperationSignal` 写入实例并传给 `spawnProcess({ signal })`；`update(source, { local })` 按 scope 过滤同名 source；`spawnCommand`/`spawnCaptureCommand` 改 stdio+env+signal；`runCommand`/`runCommandCapture` 改用 `waitForChildProcess` 并排空管道；`runCommandSync` 在 abort 后拒绝启动 |
| `core/resource-loader.{js,d.ts}` | 内部 `new DefaultPackageManager` 传入 `env` |
| `utils/shell.js` | bundled bash 回退；`killProcessTree` 绝对路径 `taskkill.exe` + `error` listener |

0.84.2 已重写 `wrapper.js`（tool wrapping only，直接 `execute()`）和 `package-manager.js`。旧 hunk 不能整段 apply。

### 1.3 Host 已经有、不必再发明的东西

| 能力 | 位置 | 备注 |
|---|---|---|
| 内部 PATH / 捆绑 Git·Node·bash | `internal-runtime.ts` | 进程级单例 `getInternalRuntime()`；测试可 `resetInternalRuntimeForTests()`，**今天没有 setter** |
| 构造 PM 时传入 `env` | `workspace-lifecycle.ts` ~778、`package-snapshot.ts` ~545 | 依赖补丁 `PackageManagerOptions.env` |
| 取消时 `pm.setOperationSignal?.(signal)` | `package-controller.ts` | 依赖补丁方法 |
| 项目作用域 update | Host 已传 `{ local: scope === "project" }` | `sdk-package-update-scope.test.ts` |
| 绝对路径 taskkill | `windows-process.ts` | 只覆盖 Host 自己的子进程 |
| 扩展调用 ALS | `createExtensionInvocationRunner` → `bindExtensions({ invocationRunner })` ~1113 | 依赖 agent-session + runner + wrapper 补丁 |
| 无合格模型时传 `null` | `agent-session-factory.ts` ~70 | 依赖 **sdk.js null 语义**，不是 clearModel |
| 运行中清模型 | `provider-controller.ts` ~514 `session.clearModel()` | 依赖 agent-session `clearModel` |
| 本地刷新 | `refreshModelsLocal()` → `runtime.refresh({ allowNetwork: false })` | 不要改回 `registry.refresh()` |
| 用户数据备份 ID | `migration-backup.ts` `pideck-sdk-0.80.7-to-0.82.1` | 本次默认不新开 |

锁住「运行时目录里还有模型、但全部被 PiDeck 禁用」的测试（T8 不得删）：

- `agent-session-factory.test.ts`：enabled 列表为空时 `session.model` 为 `{ provider: "unknown", id: "unknown" }`；`clearModel()` 同样落到该形状
- `provider-controller.test.ts`：无 Provider 时 `clearModel` / `state.model` 为 unknown

### 1.4 测试入口硬约束

`packages/pi-host/vitest.config.ts` **没有 `setupFiles`**。Host 测试不经过 `main.ts`。

若 Cut 1 安装任何 Host 适配器：必须做成幂等模块，并由 **vitest `setupFiles` + `main.ts` 顶层** 两边 import。适配器 **install 时不得读取** `getInternalRuntime()`，只在实际 spawn/覆盖路径上读——否则测试 `reset` / setter 之前就被缓存。

### 1.5 0.84.2 仍没有的公共钩子

已再核 0.84.2 tarball：

- `CreateAgentSessionOptions.model?: Model<any>`（无 `null`）；`sdk.js` 对空值 `findInitialModel()`
- `ExtensionBindings` 无 `invocationRunner`；`bindExtensions` 不保存该字段；`_applyExtensionBindings` 只 `setUIContext` / `bindCommandContext` / `onError`
- reload 新建 Runner 后只重绑已保存字段
- `wrapper.js` 的 `execute` 不进 invocation runner
- 无 `clearModel`、`setOperationSignal`、`update(..., { local })`、`PackageManagerOptions.env`

---

## 2. 目标、非目标、完成定义

### 2.1 目标

1. Host 跑在 `@earendil-works/pi-{ai,coding-agent,tui}@0.84.2`；lock 里 `pi-agent-core` / `pi-client` / `pi-protocol` 同为 `0.84.2`。
2. 把**能完整复刻**的补丁行为迁出 `dist/`。迁不出的留下最小 hunk。下一版升级按行为 rebase，不追求「只剩一个文件」。
3. 现有行为测试 + `verify:p0` + staged sidecar smoke 绿。
4. 产品版本 **0.2.2**（与 SDK bump 同一 PR 末尾改号）。不开放 `defaultTools` UI，不改用户可见协议。

### 2.2 非目标

- 命令面板、工具开关 UI、`agent.getTools` / `setActiveTools` 产品化、parked turn 原生完成通知。
- 新的 `MIGRATION_ID`（除非 `test-fixtures/pi-agent/0.80.7` 或真机 `models-store.json` / `auth.json` 打不开）。
- 重写 CredentialStore / ModelRuntime 所有权。
- 在 `0.83.0` 停一站。
- 升 pnpm / TypeScript / Vitest / Tauri / React。
- 给上游提 PR。
- 使用 0.84.2 新可选 API 做产品：`expandPromptTemplates`、`CreateModelRuntimeOptions.signal` / `refreshOnCreate`、`defaultTools`、`pi-coding-agent/client`。

### 2.3 完成定义（按行为）

**整次 bump 之后，patch 只允许包含下列行为，且每一项都有测试锁住：**

| 行为桶 | 默认去向 | 允许残留 |
|---|---|---|
| Invocation ownership（bind + reload 重绑 + event handler + Extension tool） | **必留 dist** | `agent-session` + `runner` + **新结构** `wrapper` + 类型/根导出 |
| Package manager：内部 env、取消、scoped update、waitForChildProcess/stderr | Cut 1 spike；失败则留 | 最小 `package-manager.js`（+ 若仍靠构造器 `env`：`resource-loader`） |
| Windows shell：绝对路径 taskkill + bundled bash | **留 `shell.js`** | 该文件的现有两段 |
| 无模型：禁止自动选中被禁用 Provider；运行中清模型 | Host sentinel（T8 + P6） | 仅当 sentinel 证伪：`sdk.js/.d.ts` 的 `model: null` |
| `ExtensionUIDialogOptions.pideck` | Host `declare module` | 无 |

禁止把完成定义写成「patch 只打 `runner.js`」。

**Cut 1 绿：** 上表「迁出」项已迁或 spike 失败并书面留下；T8/P6 测试绿（含 `session.snapshot` 发布）；invocation 测试绿；改过的 patch/`pnpm-lock.yaml` 已在**同一 commit** 写入 `release-runtime.lock.json` 的两个 SHA；该 commit 上 `pnpm verify:quick` 通过。不必单独合 `main`。

**Cut 2 绿：** freshness gate 通过；无混版；T1–T9 / OAuth 必搜完成；`verify:quick` + `verify:p0` + sidecar + staged smoke；七个 Pi 包 exact 0.84.2；`release-runtime.lock.json` 为最终 0.84.2 SHA；产品版本 0.2.2 且版本一致性断言通过。

---

## 3. 为什么不复制上次升级（仍成立）

上次 `0.80.7 → 0.82.1` 贵在公共 API 换代。这次贵在 dist 补丁 rebase。两刀方向仍成立，但是 **hybrid**：

```text
Cut 1（0.82.1，不改 SDK 版本）— 可独立验证
  T8 sentinel + P6 clearSessionModel
  P7 类型 augmentation
  P1–P3 timebox spike（完整语义，不是三个 spawn 包装）
  删掉已证伪迁出的 hunk
  P4+P5 不动 shell.js
  P8 不动（仍在 0.82.1 patch 里）

Cut 2（原子 0.82.1 → 0.84.2）
  freshness gate
  三个 direct 包一起 bump
  把 P8 按新 runner/wrapper/agent-session 重写移植
  rebase spike 失败留下的 PM hunk 与 shell.js
  TypeBox / headers / 夹具 / evidence / 0.2.2
```

一个 PR、多个有序 commit。**「独立绿」= 该 commit 上 `pnpm verify:quick` 能过**，因此凡是改了 patch 文件或 `pnpm-lock.yaml` 的 commit，必须同时改 `scripts/release-runtime.lock.json` 的：

- `hostProductionDeps.sdkPatchSha256`
- `pnpmLock.sha256`

Cut 1 钉的是 **仍为 0.82.1 SDK** 的中间值。Cut 2 再钉 **0.84.2** 最终值。PR 只合入一次，`main` 不会出现两次 pin；矛盾的是「Cut 1 改 patch 却不更新 lock JSON」。

不要把 Cut 1 单独合进 `main`。那会让 `main` 在 0.84.2 之前先吃一版 0.82.1 中间 evidence，和「合入一次」不是同一件事。

---

## 4. 补丁 hunk 处置总表

| ID | 行为 | 计划处置 | 失败时的最小残留 |
|---|---|---|---|
| T8 | `createAgentSession({ model: null })` 禁止自动选模型 | **迁出** Host `PIDECK_NO_MODEL` sentinel 代替 `null` | `sdk.js/.d.ts` 最小 null hunk |
| P6 | `clearModel()` | **迁出** `clearSessionModel()`，与 T8 共用 sentinel | `agent-session.js` 的 clearModel 实现（仍与 P8 同文件时，只留 clearModel 那段） |
| P7 | `ExtensionUIDialogOptions.pideck` | **迁出** `declare module` | 无 |
| P1–P3 | PM env / signal / scoped update / 管道等待 | **已迁出** Host adapter（`cross-spawn@7.0.6` + 抄入的 `waitForChildProcess`） | 已删 PM / resource-loader hunk |
| P4 | 裸 `taskkill` | **留 `shell.js`** | 已是最小 |
| P5 | bundled bash | **留 `shell.js`** | 已是最小；不复制官方探测顺序 |
| P8 | invocation ownership | **留 patch**，范围见 6.5 | 不可再缩到「只 runner」 |

---

## 5. Cut 1 详细设计（仍 0.82.1）

建议目录：`packages/pi-host/src/sdk-adapters/`。P6/T8 也可以放 `no-model.ts` 贴近 session 工厂。

### 5.1 T8：`PIDECK_NO_MODEL` sentinel（P0，先做）

0.84.2 `sdk.js`：`let model = options.model` 之后，`if (!model)` 会 restore / `findInitialModel()`。`null` 与 `undefined` 都会自动选。Host 今天靠补丁区分二者。

sentinel 是 **truthy `Model`**，因此跳过自动选择，且满足 0.84.2 的 `model?: Model` 类型。

形状必须与现有 patch 的 `NO_MODEL` 以及现有测试一致：

```ts
export const PIDECK_NO_MODEL = Object.freeze({
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
});
export function isPideckNoModel(model: { provider?: string; id?: string } | null | undefined): boolean {
  return model?.provider === "unknown" && model?.id === "unknown";
}
```

`createHostAgentSession`：无合格模型时传 `model: PIDECK_NO_MODEL`，**不再传 `null`**。注释改为说明 sentinel，而不是 null。

无 PiDeck 策略时仍 `return {}`，让 SDK 自己选（`agent-session-factory.test.ts` 已锁）。

创建路径注意：sentinel 为 truthy，**新** session 会 `appendModelChange("unknown", "unknown")`（今天传 `null` 不会写这条）。可接受，只要不调用 `setModel`（`setModel` 会 `checkAuth` 并写入 settings）。加测试：空 enabled 列表的新 session **不**把 `settings.json` 的 defaultProvider 写成 `unknown`。

已有 session 的 restore 测试（`pideckEnabledProviders: []` 且 JSONL 里有 disabled 模型）必须仍得到 `unknown/unknown`，而不是 disabled 或其它仍配置了 auth 的模型。

证伪信号：`Agent` 构造器拒绝该形状、或 `clampThinkingLevel` 抛错。那时恢复 `sdk.js` 的 `model !== null` 分支，Host 继续传 `null`（仅 0.82.1 Cut 1）；Cut 2 若仍无 `null` 类型，则必须 sentinel 或继续打 sdk hunk。

### 5.2 P6：`clearSessionModel` + Host snapshot 发布

`AgentSession.agent` 与 `Agent.state` 当前是公开 API。不要调用私有 `_emitModelSelect`。

分两层，不要把 graph 发布塞进纯 session helper（工厂测试没有 graph）：

**1. Session 状态（`clearSessionModel(session)`）**

```ts
export async function clearSessionModel(session: AgentSession): Promise<void> {
  const previous = session.model;
  session.agent.state.model = PIDECK_NO_MODEL;
  session.setThinkingLevel("off");
  if (!isPideckNoModel(previous)) {
    await session.extensionRunner.emit({
      type: "model_select",
      model: PIDECK_NO_MODEL,
      previousModel: previous,
      source: "set",
    });
  }
}
```

`extensionRunner.emit("model_select")` **只通知 Extension**。它不写 `graph.sessionSnapshot`，`provider.setEnabled` 的 RPC 返回值也没有 Session（`{ providerId, enabled }`）。桌面要靠 `session.snapshot` 事件。

**2. 在 `reconcileIdleActiveSessionModel` 清模型之后发布 Host snapshot**

`provider-controller.ts` 今日在 `allowNoModel` 时 `await session.clearModel(); return;`。改为：

```ts
if (!model) {
  if (options.allowNoModel) {
    await clearSessionModel(session);
    publishIdleActiveSessionSnapshot(factory);
    return;
  }
  throw new Error("Enable at least one Provider model before changing the current Provider");
}
```

`publishIdleActiveSessionSnapshot` 必须按这条路径，不要发明新事件：

1. `graph = factory.getGraph()`；没有 `agentSession` / `sessionManager` / `sessionSnapshot` 则 return（测试里无完整 graph 的路径）。
2. `server = factory.server`；没有 server 则 return。
3. **revision 用现有 `graph.sessionSnapshot.revision`，不要 +1。** `sessionId` 用现有 snapshot 的 sessionId。
4. `snapshot = buildSessionSnapshot({ session: graph.agentSession, sessionManager: graph.sessionManager, cwd: graph.canonicalCwd, sessionId: graph.sessionSnapshot.sessionId, revision: graph.sessionSnapshot.revision, workspaceId: graph.workspaceId, toolRevision: graph.toolRevision })`。
5. `graph.sessionSnapshot = snapshot`。
6. `server.emit("session.snapshot", snapshot)`。

不要 `emitForIdentity`，除非当时的 Provider 路径已经在用 identity 作用域。当前 `workspace-lifecycle.ts` ~960 对 active graph 用的是 `server.emit`。

调用点：

- `reconcileIdleActiveSessionModel`（所有 `allowNoModel` 清模型出口）
- `agent-session-factory.test.ts` 只调 `clearSessionModel`，不断言 graph

Cut 1 从 patch 删除 `clearModel` 时，**不要误删** 同文件的 P8 绑定字段。

断言（`provider-controller.test.ts` 清模型用例，不要只 `expect(clearModel).toHaveBeenCalled`）：

- session model 为 unknown/unknown，`thinkingLevel === "off"`
- `graph.sessionSnapshot.model` 同步为 unknown（或 Host 对 sentinel 的既有摘要形状），`thinkingLevel` 为 `"off"`
- `graph.sessionSnapshot.revision` **等于**清模型前的 revision
- `server.emit` 被以 `("session.snapshot", snapshot)` 调用，payload 就是赋给 `graph.sessionSnapshot` 的同一个对象

无 graph 的 `agent-session-factory.test.ts` 仍只断言 `session.model`。

本 PR 只给 **清模型** 补这条发布路径。`setModel` 成功后是否刷新 snapshot 是既有行为，不在这次 SDK bump 里扩 scope。

### 5.3 P1–P3：timebox spike，禁止「包装三个 spawn」当实施说明

当前补丁的完整语义（必须全部保住，测试已锁）：

1. **env：** `childEnv()` = `this.env ?? getEnv()`，用于 spawn / capture / sync。ResourceLoader 私有 PM 今天靠构造器传入 `env`。
2. **signal：** `setOperationSignal` 存实例字段；`spawnCommand` / `spawnCaptureCommand` 传给 `spawnProcess({ signal })`。只塞 WeakMap、原 spawn 仍 `getEnv()` 且无 signal = 假迁移。
3. **stdio：** `spawnCommand` 从 inherit/stdout-takeover 改为 `["ignore","pipe","pipe"]`，否则 `waitForChildProcess` 与取消不可测。
4. **`runCommand` / `runCommandCapture`：** 不用 `child.once("exit")`/`"close"`。改用 SDK `waitForChildProcess`，避免后代占着管道导致 Promise 永不 settle。`runCommand` 还要排空并截断 stdout/stderr，失败信息带 stderr。见 `sdk-package-cancellation.test.ts` ~158（inherited stdio 的 capture）与 ~294（失败带 npm stderr）。
5. **`runCommandSync`：** abort 后 `throwIfAborted()`，拒绝新的 sync 子进程。
6. **`update(source, options)`：** 原方法只有 `source`。必须 **重写过滤循环**（`requestedScope` 跳过另一 scope 的同名 identity），不能 `Function.prototype` 包一层当它吃 `{ local }`。

**Spike 成功标准（同时满足才删 PM hunk）：**

- 在 prototype 上替换上述全部路径（至少：`setOperationSignal`、`spawnCommand`、`spawnCaptureCommand`、`runCommand`、`runCommandCapture`、`runCommandSync`、`update`）。
- spawn 真正把 WeakMap/字段里的 signal 传给 Host 自己的 spawn，且 Windows 取消测试仍绿。
- **没有第三条路。** `@earendil-works/pi-coding-agent` 的 export map 只有 `.` 与 `./rpc-entry`。`spawnProcess` / `waitForChildProcess` 不是公共导出，deep-import `dist/utils/child-process.js` 禁止。
- **成功：** Host `package.json` 增加直接依赖 **`cross-spawn@7.0.6`**（与 SDK 同版本），并把 `waitForChildProcess`（及补丁依赖的管道等待语义）**抄进** `packages/pi-host/src/`。`@types/cross-spawn` 放 Host devDependencies。knip 必须看见这两者被引用。
- **失败：** 不接受新增 `cross-spawn` 依赖，或 timebox 内测试未绿 → **判定 spike 失败**，保留最小 `package-manager.js` patch。不要写「继续走 SDK `spawnProcess`」。
- 安装挂钩时做 SDK 版本/方法存在断言（缺方法 fail closed）。
- 下列测试全绿，且 ResourceLoader 内部 PM 的 env 测试仍绿：
  - `sdk-package-internal-env.test.ts`
  - `sdk-package-cancellation.test.ts`（含 capture settle、sync refuse、stderr）
  - `sdk-package-update-scope.test.ts`

**Timebox：** 一个实施 session。到期未绿 → **停止迁出**，保留最小 `package-manager.js`（及仍需要的 `resource-loader` env）。不要提交半套原型包装。

进程级 `getInternalRuntime()` 可接受：生产没有 per-instance 不同 env 的调用面。测试用 `setInternalRuntimeForTests`。若 spike 保留构造器 `env` 补丁，setter 不是必须的。

### 5.4 P4 + P5：留在 `shell.js`

P4：没有可靠的 ESM named-import 拦截。Host `windows-process.ts` 覆盖不到 SDK `killProcessTree`。

P5：该文件因 P4 已经存在。把 bundled bash 迁到 `applyOverrides` 要复制官方探测顺序，并覆盖所有 `SettingsManager.create` 路径，不能减少 patch 文件数。Cut 2 rebase `shell.js` 两段即可。

### 5.5 P7 类型

`ExtensionUIDialogOptions.pideck` 改为 Host `declare module`。从 patch 删除仅为此存在的 types hunk。P8 的 invocation 类型仍走 patch 导出。

### 5.6 P8：Cut 1 不要移植，但范围必须写对

Cut 1 保持 0.82.1 的 invocation 补丁不动（含 agent-session / runner / wrapper / 类型）。Cut 2 才按 0.84.2 新文件重写。

Cut 2 的 **P8 最小范围**（缺一不可）：

1. **`agent-session.js/.d.ts`**
   - `ExtensionBindings.invocationRunner?`
   - `bindExtensions` 保存到实例字段
   - `_applyExtensionBindings(runner)` 调用 `runner.setInvocationRunner(...)`
   - reload / `_buildRuntime` 后 `hasBindings` 计入该字段，否则新 Runner 丢 ALS
2. **`runner.js/.d.ts`**
   - `setInvocationRunner` / `invokeExtension`
   - 各 `emit*` 包的是 **单个 handler**，带该扩展 `sourceInfo`（11 条事件，`sdk-invocation-runner.test.ts`）
3. **`wrapper.js`（按 0.84.2 新结构重写，禁止 git apply 旧 hunk）**
   - `wrapRegisteredTool` 的 `execute` 走 `runner.invokeExtension({ kind: "tool", sourceInfo, toolName, toolCallId, signal }, ...)`
   - 保留 0.84.2 已有的 `addedToolNames` / `wrapToolDefinition` 行为
4. **类型与根导出**
   - `ExtensionInvocationMetadata` / `ExtensionInvocationRunner` 从 `types` → `index` → 包根，供 Host import

公开 `emit*` 太粗；ESM 不能改写具名导出。0.84.2 无公共 hook。

### 5.7 Cut 1 步骤

1. T8 + P6 + 工厂/controller 调用点 + snapshot 断言。
2. P7 module augmentation。
3. 从 0.82.1 patch 删除 sdk null hunk（T8 绿之后）和 clearModel hunk。
4. P1–P3 spike：成功则删 PM/resource-loader hunk 并加 setupFiles；失败则 patch 保持 PM+shell+invocation，只留下 T8/P6/P7 的 Host 改动。
5. 跑：

```text
pnpm --filter @pideck/pi-host test -- src/agent-session-factory.test.ts
pnpm --filter @pideck/pi-host test -- src/provider-controller.test.ts
pnpm --filter @pideck/pi-host test -- src/sdk-package-internal-env.test.ts
pnpm --filter @pideck/pi-host test -- src/sdk-package-cancellation.test.ts
pnpm --filter @pideck/pi-host test -- src/sdk-package-update-scope.test.ts
pnpm --filter @pideck/pi-host test -- src/agent-bash-env.test.ts
pnpm --filter @pideck/pi-host test -- src/windows-process.test.ts
pnpm --filter @pideck/pi-host test -- src/sdk-invocation-runner.test.ts
pnpm --filter @pideck/pi-host typecheck
```

6. 凡是改了 `patches/@earendil-works__pi-coding-agent@0.82.1.patch` 或 `pnpm-lock.yaml` 的 Cut 1 commit，**同一 commit** 更新 `scripts/release-runtime.lock.json` 的 `sdkPatchSha256` 与 `pnpmLock.sha256`。然后跑 `pnpm verify:release-metadata`（含在 `verify:quick` 里）。不更新这两字段，中间 commit 不能叫独立绿。
7. 不改三个 Pi 包版本、不改桌面 `sdkVersion: "0.82.1"` 夹具、不新开 `MIGRATION_ID`、不跑 sidecar packing、不把产品版本改成 0.2.2（那是 Cut 2 Commit 8）。

---

## 6. Cut 2 详细设计（0.84.2）

### 6.1 Freshness gate（开头，硬停）

在改 `package.json` 之前：

```text
npm view @earendil-works/pi-ai dist-tags.latest
npm view @earendil-works/pi-coding-agent dist-tags.latest
npm view @earendil-works/pi-tui dist-tags.latest
npm view @earendil-works/pi-agent-core dist-tags.latest
npm view @earendil-works/pi-client dist-tags.latest
npm view @earendil-works/pi-protocol dist-tags.latest
npm view @earendil-works/pi-telemetry dist-tags.latest
```

任一个 **不是** `0.84.2`：停止，重新审计 changelog 与 Host 调用面，不要 pack 硬编码 0.84.2。

通过后再 `npm pack` 核 SHA（可与附录对照；npm 可能 republish）。可选核 `gitHead === 914cf147`（仅当 latest 仍是 0.84.2）。

### 6.2 依赖与 lock

1. `packages/pi-host/package.json`：三个 direct 包 → `0.84.2`。
2. 根 `patchedDependencies` 键改为 `@earendil-works/pi-coding-agent@0.84.2`。
3. `pnpm install` 生成 lock → 立刻 `--frozen-lockfile`。
4. `pnpm list`：禁止 `0.82.x` 与 `0.84.x` 的 `@earendil-works/pi-*` 并存。
5. 禁止 root `pnpm.overrides` 掩盖分叉。

### 6.3 移植残留 patch（不要 git apply 整份旧补丁）

```text
pnpm patch @earendil-works/pi-coding-agent@0.84.2
# 1) P8：agent-session 绑定、runner 事件、按新 wrapper 重写 tool 包裹、类型导出
# 2) P1–P3 若 spike 失败：rebase 最小 package-manager（+ resource-loader env）
# 3) P4+P5：shell.js 两段
pnpm patch-commit <dir>
```

`wrapper.js`：对照 0.84.2 的 `wrapToolDefinition` + `addedToolNames` 逻辑插入 `invokeExtension`。碰了旧结构就回滚该文件重来，不是「文件不能改」。

### 6.4 Host 编译点

#### T1 TypeBox

`attachment-tool.ts`：`@sinclair/typebox` → `typebox@1.3.7`。Host `package.json` 删除 `@sinclair/typebox`。`@pideck/protocol` 不动。

#### T2 `ProviderHeaders`

| 路径 | 做法 |
|---|---|
| 转发给 `completeSimple` / SDK 流 | **原样传递 null** |
| Host 自拼 HTTP header（`headersForAuthMode`） | 丢 null 或 `providerHeadersToRecord()` |

#### T3 `ModelRegistry.refresh`

继续 `refreshModelsLocal()`。只改过时注释。

#### T4 事件

进程内 `message_update` 仍有 `partial`。`event-normalize.ts` 先不动，用真实流式 fixture 确认。`StopReason` 的 `pending` / `deferred` 按 string 放行，不扩协议。

#### T5 `sdkVersion` 字面量

夹具改为 `0.84.2`。保留 `test-fixtures/pi-agent/0.80.7` 与 `pi-sdk-compatibility.test.ts`。`host.integration.test.ts` 已用 `SDK_VERSION`。

#### T6 证据脚本

`scripts/release-sdk-evidence.mjs` 的 `PI_SDK_PACKAGES` 扩为七个：`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`pi-client`、`pi-protocol`、`pi-telemetry`。client/protocol 是运行时协议边界，telemetry 由 `pi-ai` / `pi-agent-core` 带入生产树；staged 锁 exact version。Cut 2 把 `scripts/release-runtime.lock.json` 的 `sdkPatchSha256` / `pnpmLock.sha256` 更新为 **0.84.2 最终值**（覆盖 Cut 1 钉过的 0.82.1 中间值）。

#### T7 不做新 migration

现有 `pideck-sdk-0.80.7-to-0.82.1` 继续有效。

#### T8（Cut 2 再确认）

0.84.2 无 `model: null`。sentinel 必须已在 Cut 1 落地。回归 `agent-session-factory.test.ts`。

#### T9 OAuth 必搜（不能只等主工程编译）

搜 Host、fixture、测试扩展里的 `refreshToken`。0.84.2 要求 `refreshToken(credentials, signal)`。当前 Host 无自有实现，但动态 Extension 仍可能注册。Cut 2 加运行时兼容测试：回调若不接 signal 不得默默丢 abort。主工程编译绿不等于扩展面绿。

### 6.5 文档与产品版本 0.2.2

README / `docs/architecture/overview.md` / `docs/operations/development.md`：SDK 版本 0.84.2；补丁说明改为「invocation ownership + Windows shell（+ 若仍在：PM env/cancel/scope）」。不改写 0.82.1 handoff 正文。

**Commit 8 必须同时改到 0.2.2 的文件：**

| 文件 | 字段 |
|---|---|
| `package.json` | `"version"` |
| `packages/pi-host/package.json` | `"version"` |
| `packages/protocol/package.json` | `"version"` |
| `apps/desktop/package.json` | `"version"` |
| `apps/desktop/src-tauri/tauri.conf.json` | `"version"` |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` |
| `apps/desktop/src-tauri/Cargo.lock` | `[[package]] name = "pideck"` 的 `version`（Cargo 生成，改 toml 后 `cargo generate-lockfile` 或手工对齐这一条） |

不要改 test-fixtures 里无关 package 的版本。

**版本一致性断言：** 在 `scripts/release-sdk-evidence.mjs`（由 `verify:release-metadata` → `verify:quick` → `verify:p0` 调用）增加检查：上表所有产品版本字符串必须相等，且等于根 `package.json` 的 `version`。这样桌面 0.2.2、staged Host/protocol 仍 0.2.1 会在 `verify:quick` 失败，不必等 sidecar。断言放进 `scripts/release-sdk-evidence.test.mjs` 的一个单元，用临时目录或对当前仓库实读。

### 6.6 Cut 2 门禁

```bash
pnpm install --frozen-lockfile
pnpm verify:quick
pnpm verify:p0
```

Windows 权威门（现 CI，不是新发明）：

```text
Node 22: pnpm verify:quick
Node 24: pnpm verify:p0
pnpm package:sidecar:with-node
pnpm validate:resources
pnpm smoke:staged-host
```

staged evidence：七个 Pi 包均为 `0.84.2`、最终 patch SHA、最终 lock SHA、`bashProbe` ok、`gitStatus: ready`、Host 干净退出。

---

## 7. 建议提交切分（一个 PR）

1. `fix(host): represent no enabled Provider with a sentinel model`
2. `fix(host): clear session model and publish session.snapshot`
3. `chore(patch): drop sdk null and clearModel hunks from the 0.82.1 patch`（**同时**更新 `release-runtime.lock.json` 两个 SHA）
4. （可选，spike 成功才有）`feat(host): add cross-spawn package-manager adapters` + `chore(patch): drop migrated PM hunks`（**同时**更新两个 SHA）
5. `chore(deps): bump Pi SDK to 0.84.2`
6. `fix(host): TypeBox 1.3.7 and ProviderHeaders nulls`
7. `chore(patch): port invocation ownership onto 0.84.2 session/runner/wrapper`
8. `chore(release): pin 0.84.2 sidecar evidence, bump PiDeck to 0.2.2, assert version equality`

Commit 3/4/5/7/8 凡触及 patch 或 `pnpm-lock.yaml` 的，都必须在**同一 commit** 里更新 `sdkPatchSha256` 与 `pnpmLock.sha256`，否则该 commit 上 `verify:quick` 红。Commit 8 是最终 0.84.2 pin + 产品版本清单。

每条在自己的树上都要能 `pnpm verify:quick`（Cut 1 不必跑 sidecar / `verify:p0` 的 rust 段，但 release-metadata 必须过）。推送/合入只发生在 8 之后。

不要做：第二份 api-notes；`main` 半升；为未发布安装包打 `pre-pi-sdk-0.84.2-*` 标签。回滚锚点仍是 git `v0.2.1`。

---

## 8. 风险登记册

| ID | 风险 | 检测 | 处理 |
|---|---|---|---|
| R-T8 | sentinel 被 `findInitialModel` 或 restore 覆盖 | `agent-session-factory` 空 enabled 列表 | 先确认传入的是对象不是 null；失败则 sdk null hunk |
| R-T8b | 新 session 把 unknown 写入 settings | 读 `settings.json` | 禁止对 sentinel 调 `setModel` |
| R-P6 | 只改 agent state / 只 emit model_select，UI 仍显示旧模型 | `provider-controller` 断言 `graph.sessionSnapshot` + `session.snapshot` 事件；revision 不变 | `publishIdleActiveSessionSnapshot` |
| R-P6b | 误把 revision +1 | 同上 | 使用清模型前的 revision |
| R-PM | 三方法包装假绿；或试图 deep-import SDK spawnProcess | cancellation 测试；export map | 要么 `cross-spawn@7.0.6` + 抄 helper，要么留 patch |
| R-ev | Cut 1 改 patch 不更新 `release-runtime.lock.json` | `verify:release-metadata` | 同 commit 更新两个 SHA |
| R-ver | 只改根 package.json 或只改 tauri.conf | 新的产品版本一致性断言 | Commit 8 七处一起改 |
| R-P8 | 只改 runner，bind/reload/tool 丢 ALS | `sdk-invocation-runner` tool 用例 | session + runner + 新 wrapper + 类型 |
| R-P8w | apply 旧 wrapper hunk | 0.84.2 文件对不上 | 按新 `execute` 重写 |
| R-ESM | 劫持 `child_process.spawn` | — | 不做；P4 留 shell.js |
| R-fresh | latest 已不是 0.84.2 | 6.1 | 停，重新审计 |
| R-oauth | 扩展 refreshToken 无 signal | T9 搜索+测试 | 运行时兼容，不只编译 |
| R-mix | 混版 lock | `pnpm list` | 禁止分步推 `main` |

回退：PR 未合 = 丢分支。已合未发布 = revert 到 `v0.2.1`。已安装目录不要单换 npm 包。

---

## 9. 升完再做（不进本 PR）

- `defaultTools` / 工具开关 UI（那才是 0.3.0 候选）
- 命令面板
- 上游 PR：invocationRunner、PackageManager env/signal、killProcessTree 绝对路径、`model: null`

---

## 10. 第 11 节逐条结论（Review 已答，作为约束）

1. **两刀值得，改成 hybrid。** Cut 1 可独立验证；P1–P3 先 timebox；复刻不了就留最小 PM patch。
2. **进程级 runtime 可接受。** 生产无 per-instance env。测试 setter 做隔离。install 时不预读 runtime。
3. **P4 留 `shell.js`。** 无可靠 ESM 拦截。
4. **P5 留 `shell.js`。** 文件已因 P4 存在；官方探测顺序更可靠。
5. **P6 可迁出。** 公开 `agent` / `state`；统一 sentinel；公开 `setThinkingLevel` + `extensionRunner.emit`；不断私有 `_emitModelSelect`。清模型后必须 `buildSessionSnapshot` → `graph.sessionSnapshot` → `server.emit("session.snapshot")`，revision 不变。
6. **0.84.2 无公共 invocation hook。** P8 必留，范围含 AgentSession 与 wrapper。
7. **`PI_SDK_PACKAGES` 七个。** client/protocol/telemetry 锁 exact staged version。
8. **一个 PR、多个有序且可独立绿的 commit。** 「独立绿」包含 `verify:release-metadata`。Cut 1 改 patch/lock 时立刻更新两个 SHA；Cut 2 再写成最终 0.84.2。`main` 只因 PR 合入一次而只看到最终 pin，不是「Cut 1 不碰 lock JSON」。
9. **OAuth 注册点必搜。** 含动态 Extension/fixture，不能只等主工程编译失败。
10. **产品版本 0.2.2。** Commit 8 七处文件 + 一致性断言。内部 SDK/兼容性。同时开放新工具配置或改用户可见协议才 0.3.0。

---

## 11. 若实施中证伪：逃生

- T8 失败 → 保留 `sdk.js/.d.ts` null hunk，Cut 2 继续打到 0.84.2（类型上把 `model?: Model \| null` 补回去）。
- P1–P3 spike 失败 → 这是 **默认预期之一**，不是事故。Cut 2 rebase `package-manager.js`。
- P8 tool 路径打不进新 wrapper → 停 Cut 2，不要用「先合 runner、后补 wrapper」的半套 patch。
- latest ≠ 0.84.2 → 新开审计，本文件作废目标版本号。

备选 A（整包 rebase 8 文件、跳过 Cut 1）仅在 Cut 1 T8/P6 也失败时考虑。备选 B（Proxy 整个 ExtensionRunner 消灭 P8）无公共 API 支撑，不做。

---

## 附录 A. 关键路径

| 用途 | 路径 |
|---|---|
| 现有 patch | `patches/@earendil-works__pi-coding-agent@0.82.1.patch` |
| `model: null` 产品语义 | patch `sdk.js`；`packages/pi-host/src/agent-session-factory.ts` |
| 清模型 | `provider-controller.ts`；patch `agent-session.js` `clearModel` |
| invocation 注入 | `extension-ui-bridge.ts` ~1113 |
| invocation 契约 | `sdk-invocation-runner.test.ts`（事件 + tool） |
| PM 取消/stderr | `sdk-package-cancellation.test.ts` |
| TypeBox | `attachment-tool.ts` |
| evidence | `scripts/release-sdk-evidence.mjs`、`scripts/release-runtime.lock.json` |
| 0.84.2 离线包 | `%TEMP%\pideck-sdk-0842\` |

## 附录 B. 已撤回、禁止再当实施说明的主张

1. Host 包装 `node:child_process.spawn` 覆盖 SDK taskkill。
2. 只挂钩 `spawnCommand` / `spawnCaptureCommand` / `runCommandSync` 三方法。
3. 包装原 `update()` 就能做 scoped update。
4. `setOperationSignal` 存 WeakMap 即可，spawn 会自动消费。
5. P8 只改 `runner.js`；`wrapper.js` 碰了就回滚（文件不能改）。
6. `sdk.{js,d.ts}` 只是类型/符号导出。
7. P5 用 `applyOverrides` 迁出 bundled bash。
8. 完成定义 = patch 只剩 runner.js。
9. Cut 1 单独合 `main` 再做 Cut 2。
10. 只在 `main.ts` 安装挂钩；install 时预读 `getInternalRuntime()`。
11. Cut 1 改 patch 却把 `release-runtime.lock.json` 留到 Cut 2 才更新（`verify:quick` 必红）。
12. PM spike 在无法 import `cross-spawn` 时「继续走 SDK `spawnProcess`」。
13. `extensionRunner.emit("model_select")` 就等于更新了 Host session snapshot。
