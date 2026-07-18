# Pi Desktop Manager 全项目复审报告（第二轮）

> **日期**：2026-07-18（晚于 [第一轮 full review](./2026-07-18-full-review.md) 与其 [整改 TODO](./2026-07-18-remediation-todo.md)）
> **范围**：packages/protocol · packages/pi-host · apps/desktop（React 前端）· apps/desktop/src-tauri（Rust）· scripts/发布链/文档/仓库卫生
> **方法**：4 个方向并行独立深审（未参照第一轮报告，可作为交叉验证）
> **结论**：第一轮 TODO 中标记完成的 P0/P1 代码项与本轮观察一致；Release gates 全部确认仍未关闭；另有一批**本轮新增发现**（含 2 项高危）。

---

## 一、与第一轮整改 TODO 的交叉验证

**本轮独立复审未再发现下列已勾选项对应的问题**（与"已修复"一致）：

- 同消息多 toolCall part 覆盖丢失（原 B1）——本轮前端深审未复现该缺陷；
- `steer`/`followUp`/`abort` 跨 await 会话竞态（原 B2）——本轮未再flag这三个 handler（但发现同族残留，见新发现 N2）；
- Windows Job Object——**确认已落地**（`KILL_ON_JOB_CLOSE`），并有 `child_generation` 退役旧监视器、stdout/stderr 字节上限等配套；仅剩一个小窗口竞态（见 N12）；
- JSONL 行长上限、包变更超时——已观察到对应机制（包超时的残余锐边见 N8）。

**Release gates 项全部确认仍然打开**（本轮独立复核到相同证据）：

| TODO 项 | 本轮复核 |
|---|---|
| 恢复/替换 `spec/` 三个合同 | `spec/` 仍不存在；`verify-doc-links.mjs:55-66` 显式要求这三个文件 → `verify:docs` 必红，`verify:p0` 第一道门必败 |
| 重新生成 runtime lock/staging 元数据 | `pnpm-lock.yaml` 实际哈希（`e5e6fc9b…`）与 `scripts/release-runtime.lock.json:33`（`ac083eb3…`）、根 `runtime-manifest.json:39`（`6f04a394…`）三方互不一致；lock 于 7/18 重新生成，pin 停在 7/17 → `smoke-release.mjs:351/357` 永远失配 |
| `desktop_open_path` 收敛 + 移除 `shell:allow-open` | `commands.rs:26-71` 仍将前端字符串未经校验交给 `explorer.exe`；`capabilities/default.json:9` 的 `shell:allow-open` 仍在且未被代码使用 |
| 生产 CSP | `tauri.conf.json:25` 仍为 `"csp": null` |

---

## 二、本轮新增发现

### 高危

**N1. pi-host 在 stdin 关闭后不退出 → Windows 孤儿进程**
`packages/pi-host/src/server.ts:160`、`main.ts`。line reader 只订阅 stdin `"data"`，无 `"end"/"close"` 处理，也无 `SIGTERM`/`uncaughtException` 兜底。UI 崩溃或被强杀（未走 `system.shutdown`）时 sidecar 永久存活并持有 SDK 与子进程。正常路径有 Rust 侧 Job Object 兜底，但 host 应在 stdin EOF 时自行退出——`pnpm dev:host` 等脱离 Tauri 的场景没有任何兜底。

**N2. `agent.compact` 与 `agent.prompt` 锁不互斥，可并发执行**
`packages/pi-host/src/agent-controller.ts:64-65`（prompt 取 per-session 锁）vs `:313`（compact 取全局 `agentOperationLock`，且**无 `isIdle` 检查**）。两把不同的锁互不阻塞：prompt 流式进行中派发 compact，会对同一会话并发调用 `agentSession.compact()`。属第一轮 B2 的同族残留——并发模型仍缺一条"每会话操作互斥"的统一不变量。

### 中危

**N3. `.gitignore` 缺口比第一轮 A4 记录的更具体、更致命**
未忽略：`resources/git/`（约 408MB 便携 Git）、`resources/node/node_modules/`、`resources/pi-host/node_modules.zip`（约 201MB）；且 `artifacts/` 规则匹配不到 `.artifacts/`。当前尚未 `git init`——**这是修复的最后窗口**，一旦提交即永久进入历史。

**N4. Rust 层 host 互斥锁跨整个 180 秒启动持有**
`apps/desktop/src-tauri/src/lib.rs:33-34` 持 `state.host` 锁跨 `host.start().await`（内部等 `ready_rx`，超时 180s，`pi_host.rs:791`）。sidecar 挂起时，所有 `pi_host_send/status/restart` 阻塞至多 180s；`RunEvent::Exit` 的 `block_on`（`lib.rs:112-119`）抢同一把锁 → 关窗假死最长 3 分钟。启动等待应移到锁外。

**N5. 前端 Tauri 原生监听器泄漏**
`apps/desktop/src/lib/bridge/tauri-transport.ts:14,18`。`listen("pi-host-stdout"/"pi-host-stderr")` 返回的 unlisten 句柄被丢弃；`onMessage` 的 disposer 只清本地 handler 集合。StrictMode 双挂载 / HMR / transport 重建时原生 IPC 订阅只增不减，`hostClient.detach()` 无法真正拆除。

**N6. 流式期间 transcript 模型每帧全量重建**
`apps/desktop/src/features/chat/Transcript.tsx:51` 的 `buildTranscriptRows(messages)` 以 `messages` 为 memo 键，而 reducer 每个事件都新建数组（`transcript-reducer.ts:70`）→ 流式 ~60fps 下全量 O(n) 重算 + 全行 reconcile。与 TODO 中"虚拟化"是两件事：即使不虚拟化，也应先做稳定前缀 + 活动尾部切分。

**N7. 协议校验 switch 不穷尽，新增 method/event 时静默失效**
`packages/protocol/src/validate.ts:172,405`、`dto-validate.ts:677,901` 无 `default`/`assertNever`。漏加 case 时出站校验返回 `undefined` 被当作"通过"；入站侧 `parseHostRequest` 在 `server.ts:185` 的 try/catch **之外**读 `undefined.ok` → 未处理拒绝（叠加 N1 无兜底，直接崩进程）。加 `assertNever` 即可低成本封死。

**N8. 包变更超时后 `serviceGraphLock` 仍被失控操作占用**
`packages/pi-host/src/package-controller.ts:295-320`。10 分钟超时使 `waitForPackageMutation` 先行返回，但 `mutatePackageUnderLock` 继续运行、锁在其自身 `finally` 才释放——期间所有图操作被阻塞。已有 `HOST_RESTART_REQUIRED` 提示，属"有意为之的锐边"，记录在案。

**N9. verify-p0 的 m0/e2e 证据互相别名**
`scripts/verify-p0.mjs:44,93-94` 两道门读同一个 `artifacts/p0/e2e-latest/e2e-results.json`，`candidateBound`（`:124-129`）仅因执行顺序上后写覆盖前读才可满足。fail-closed（安全），但记录下来的 m0 证据有误导性。

### 低危

- **stdout 无背压**：`server.ts:144` 忽略 `write()` 返回值，重度流式 + 慢消费者时 Node 端无界缓冲（与前端 rAF 合并缓解，但 host 侧无保护）。
- **单个非 UTF-8 字节拆毁 stdout 流**：`pi_host.rs:24-42` 用 `read_line`（仅 UTF-8），一个坏字节 → `InvalidData` → 整条流断开、误触 fatal/重启。
- **Job Object 在 spawn 后才 assign**：`pi_host.rs:605-617`，进程未挂起创建，窗口期内孙进程可逃逸 `KILL_ON_JOB_CLOSE`。
- **损坏的 settings 静默重置**：`desktop_settings.rs:57` `unwrap_or_default()` 丢弃全部用户设置而不上报（第一轮低危已记，确认仍在）。
- **`extensionUi.respond` 未用身份守卫**：`extension-ui-bridge.ts:485` 支持 `expectedIdentity` 但调用方不传，`checkIdentity` 只到 workspace 级（实际由"会话切换取消 pending"缓解）。
- **文档完成度门可绕过**：`verify-doc-links.mjs:70-92` 只要任意 `artifacts/p0/*/verify-p0.json` 有 `p0Complete:true` 即解锁文档"完成"措辞，而 artifacts/ 不入库、可手写（真正的发布门仍有 git SHA 保护）。
- **Node 版本三方偏差**：engines `>=22.19`、`@types/node` 22.x、实际打包运行时 Node 24.18——按 22 做类型检查、跑在 24 上。
- **杂物**：`mcps/`（Grok/Augment 工具 JSON）与产品无关、零引用，应移出；根 `runtime-manifest.json` 是过期证据快照（`git.portable: null`，旧哈希）与 `release-runtime.lock.json` 矛盾；`errors.ts` 中 `EXTENSION_UI_TIMEOUT`、`AUTH_REQUIRED`、`PACKAGE_ALREADY_INSTALLED`、`PACKAGE_RESOLVE_FAILED`、`TRUST_REQUIRED` 定义未用（extension-UI 超时路径 resolve `undefined` 而不用错误码）。
- **`workspace-graph-factory.ts`（2000+ 行）**：`createSession`/`openSession`/`promoteBackgroundRuntime` 三分支各复制约 150 行候选提交/回滚簿记，分支漂移风险高（与 TODO"拆分"项互补：先抽公共事务骨架收益最大）。

### 正面确认（本轮专项核查，无发现）

- **渲染面无 XSS sink**：全仓无 `dangerouslySetInnerHTML`/`innerHTML`；markdown 经 Streamdown `skipHtml` + `urlTransform`（拒非 http(s) 与一切 `src`）+ `safeLink` 方案确认；工具输出/扩展 widget/模态均纯文本节点渲染。
- **前端 epoch/世代模型严密**：hostInstanceId + 单调序列 + 逐事件身份校验 + gap 触发去抖 rehydrate，本轮构造不出"切换会话后旧响应污染"或"rehydrate 双应用"场景；rAF 事件合并在任何非 `message_update` 事件前正确 flush，保序。
- **Rust 进程生命周期**（除 N4/N12 外）：generation 退役、字节上限、release 模式二进制解析不走 `PATH`、tokio Mutex 无 poison/unwrap——质量高于典型 Tauri 项目。

---

## 三、建议动作顺序（叠加在现有 TODO 之上）

1. **`git init` 之前**：补 `.gitignore`（`resources/git/`、`resources/node/node_modules/`、`resources/pi-host/node_modules.zip`、`.artifacts/`）——过期不候（N3）；
2. N1：host 监听 stdin `"end"/"close"` 即退出 + `unhandledRejection` 兜底（与 N7 的崩溃路径同一张网）；
3. N2：统一 agent 操作并发模型（compact 并入 per-session 锁 + `isIdle` 检查）;
4. 与现有 Release gates 一并处理：spec/ 三选一落地、重 pin lock 哈希、CSP、`desktop_open_path` 白名单（本轮全部复核确认仍开放）；
5. N4/N5/N6：Rust 启动锁外等待、transport unlisten 修复、transcript 稳定前缀切分；
6. 其余低危按顺手清理。

---

**一句话总结**：第一轮 P0/P1 整改基本落地且质量良好；当前风险重心已从"代码级并发 bug"转移到**发布链元数据腐化（spec/lock/manifest 三缺）+ 安全姿态（CSP/open_path）+ 两个新高危（stdin 孤儿、compact 锁）**；且 `.gitignore` 必须在 `git init` 之前修，这是唯一有时间窗口的项。
