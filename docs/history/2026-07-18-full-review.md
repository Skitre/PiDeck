# Pi Desktop Manager 全项目 Review 报告

> **日期**：2026-07-18
> **范围**：protocol / pi-host / React 前端 / Rust-Tauri / 脚本-发布-文档（约 2 万行源码 + 全部测试与发布脚本）
> **方法**：5 个方向并行深审 + 高危发现逐条人工复核 + 客观门槛实跑验证
> **发现统计**：**12 项高危 · 27 项中危 · 26 项低危**（高危均已复核确认）

**客观门槛实测**（本报告撰写时真实运行结果）：

| 门槛 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ protocol / pi-host / desktop 三包全过 |
| `pnpm test` — apps/desktop | ✅ 21 个测试文件 / 104 用例全过 |
| `pnpm test` — packages/pi-host | ✅ 18 个测试文件 / 81 用例全过（含 trust+package 集成、extension UI 真实加载链路、host 集成） |
| `pnpm verify:docs` | ❌ 16 处失效链接（主要指向缺失的 `spec/`） |
| `pnpm verify:p0` | ❌ 当前状态不可能通过（见 A1–A3） |

---

## 一、总体评价

这是一个**工程素养明显高于平均水平的早期项目**：三进程拓扑边界清晰且被文档化执行、`hostInstanceId + 多级 revision + STALE_REVISION` 的身份/版本体系设计严谨、协议层有运行时校验（多数同类项目完全没有）、发布链按 fail-closed 思路设计、trust-before-load 边界经代码验证**严格合规**、前端无 `dangerouslySetInnerHTML`。

但存在三个层面的问题，按紧迫度排序：

1. **发布链当前自我锁死**——无 git 仓库、`pnpm-lock.yaml` 哈希与三处锁定元数据全部对不上、`spec/` 合同目录整体缺失，`verify:p0` 从根基上不可能退出 0；
2. **3 个真实的代码级高危 bug**——前端 transcript 数据丢失、pi-host 两处并发竞态，都会在生产中实际触发；
3. **2026-07-17 安装器安全事件后的加固缺口**——CSP 显式关闭、任意路径打开无校验、安装器无签名验证、供应链记录失真。

---

## 二、高危发现（12 项，已抽查复核）

### A. 发布链死锁（流程/环境）

| # | 发现 | 证据 | 影响 |
|---|------|------|------|
| A1 | **无 git 仓库**，`verify:p0` 的 commit/`dirty:false` 门槛永远失败 | `scripts/verify-p0.mjs:104-116` | P0 关闭的第一前提不满足（remediation report blocker #4 已自知，此处确认） |
| A2 | **`pnpm-lock.yaml` 实际哈希与全部锁定元数据不符** ✓复核 | 实际 `e5e6fc9b…`；`scripts/release-runtime.lock.json` 记 `ac083eb3…`；`runtime-manifest.json`、`resources/pi-host/STAGING.json` 又是别的值；且 `STAGING.json` 虚假标注 `"pnpmLockVerified": true` | `scripts/package-release-sidecar.mjs:64-68` 会 fail-closed 拒绝发布；**"已验证"元数据是假声明，供应链追溯失效** |
| A3 | **`spec/` 目录整体缺失** | `README.md:6`、`docs/README.md:20-24`、`docs/operations/remediation-report.md:9-11` 全部引用 `spec/PROJECT_SPEC.md` 等三个"合同"；目录不存在 | C0–C8 门槛失去定义来源；`verify:docs` 当前红（16 errors） |
| A4 | **产物/运行时/用户数据混入源码树** | `apps/desktop/src-tauri/resources/node/`（整个 Node 发行版）、`resources/git/`、`resources/pi-host/*.js(.map)+node_modules.zip`、`packages/*/dist`、`tsconfig.tsbuildinfo`、`artifacts/desktop-settings.json`（含本地路径+会话 id）、根目录过期 `runtime-manifest.json`；`.gitignore` 未覆盖 resources 产物与 zip | clean checkout 不可复现；仓库体积爆炸；`runtime-manifest.json` 的旧 Git 策略（`portable-optional`）与现行 lock（`pinned-portable-required`）矛盾，误导审计 |

### B. 代码级高危 bug

#### B1. 前端：同一条 tool 消息含多个 toolCall part 时，更新其一即静默丢弃其余 ✓复核

`apps/desktop/src/lib/chat/transcript-reducer.ts:263-266`

```ts
if (message.content.some((item) => item.type === "toolCall" && item.id === toolCallId)) {
  next[index] = { ...message, content: [part] };  // ← 整个 content 数组被替换成单 part
```

并行工具调用（pi agent 常见）场景下，后到的工具结果会**抹掉先到的工具卡片**。现有测试只覆盖了"两条独立 tool 消息"，没覆盖同消息多 part。

**修复方向**：改为 `content: message.content.map(item => item.id === toolCallId ? part : item)`，并补同消息多 part 并发更新测试。

#### B2. pi-host：多个非持锁 handler 跨 await 使用旧 graph 引用，操作可落到错误会话 ✓复核

涉及位置：`packages/pi-host/src/agent-controller.ts:159-226`（`steer`/`followUp`/`abort`/`clearQueue`）、`:322-377`（`setAutoCompaction`/`setAutoRetry`）、`:593-622`（`setThinkingLevel`）

这些 handler 只在入口 `checkIdentity` 一次，随后 `const g = factory.getGraph()` 取出引用后跨多个 await 使用。而 `createSession`（`workspace-graph-factory.ts:1507+`）是**持 `serviceGraphLock` 原地修改** `g.agentSession` 的——并发时旧请求恢复执行后操作的是新会话，且响应会用新身份标记返回（`server.ts:333-363` 只在显式携带 identity 时才做替换检查）。`steer/followUp` 还可与包变更后的 `agentSession.reload()`（`package-controller.ts:494-520`）交错，产生不一致队列状态。

**修复方向**：这些 handler 纳入 `withStableGraphRead` 或锁内二次 `checkIdentity`，响应统一携带捕获的 identity。

#### B3. pi-host：`system.shutdown` 不持锁直接 dispose 整个图 ✓复核

`packages/pi-host/src/main.ts:100-107`：`onShutdown` 直接 `disposeGraph(g)`，未经 `serviceGraphLock`。若此时 `package.install` 持锁进行中，会并发关闭 `packageManager`/`AgentSession`，包写入到一半、状态不一致。

#### B4. pi-host：无 `unhandledRejection`/`uncaughtException` 兜底，且 prompt 尾部有裸 await ✓复核

`packages/pi-host/src/main.ts:120-147` 只有启动 catch；`packages/pi-host/src/agent-controller.ts:146-153` 的 `refineActiveSessionName` 位于 IIFE 的 `try…finally` **之外**，一旦内部漏捕异常 → unhandledRejection → 宿主进程崩溃（单点）。

### C. 安全面高危

| # | 发现 | 证据 | 说明 |
|---|------|------|------|
| C1 | **CSP 显式置 null** ✓复核 | `apps/desktop/src-tauri/tauri.conf.json:24-26` | 结合 devUrl + 前端渲染远程模型输出，XSS 失去关键防线；至少应为生产构建配置收紧的 CSP |
| C2 | **`desktop_open_path` 任意路径无校验** ✓复核 | `apps/desktop/src-tauri/src/commands.rs:27-29` 直接把 `path` 喂给 `explorer.exe` | 前端（或被污染的前端）可打开任意路径/UNC/特殊文件夹；且 `capabilities/default.json` 还同时授予了无 scope 的 `shell:allow-open`，两条通道并存。应限定工作区/用户目录并二选一 |
| C3 | **安装器无代码签名，完整性脚本可被绕过** | `tauri.conf.json:37` `certificateThumbprint: null`；`scripts/windows-installer-integrity.mjs` 只扫前 2MB、固定 IOC 字符串、ProductName 启发式 | 7-17 事件证明 PE 篡改是真实威胁；攻击者抹掉 IOC 字符串+后移 NSIS marker 即可通过。需 Authenticode 签名+验签哈希绑定 |
| C4 | **协议嵌套 DTO 校验宽松 → "校验通过但类型撒谎"**（3 处同根因） | `packages/protocol/src/dto-validate.ts:770-777`（`agent.compact` 的 `result` 只要求是 JSON 对象，不校验 `tokensBefore?: number` 等字段，✓复核）；`:931-939`（`agent.compactionChanged` 事件同病）；`:322-328`（`{type:"text", text:123}` 可通过） | Host 或 SDK 返回畸形数据时前端按 TS 类型使用会崩；且 `protocol-coverage.test.ts` 声称事件有非法用例实际没有（211 用例全是"合法+缺字段"），防不住这类漂移 |

---

## 三、中危发现（27 项，按模块）

### pi-host（4）

- 包变更无服务端 10 分钟超时（文档只约束客户端），SDK 挂起则 `serviceGraphLock` 永久占死 — `packages/pi-host/src/package-controller.ts:263-596`
- `capturePackageDiskFingerprint` 用 `readdirSync/lstatSync` 同步递归遍历，大目录阻塞事件循环 — `packages/pi-host/src/package-controller.ts:55-79`
- `workspace-graph-factory.ts` **2054 行上帝文件**：workspace 切换、trust、会话生命周期、包快照、扩展绑定、事件路由约 140 个函数全在一处，必须拆分
- `extension-ui-bridge` 全局无界 `pending` Map；`emit` 抛错会泄漏 120s timer — `packages/pi-host/src/extension-ui-bridge.ts:33,166-208`

### Rust/Tauri（5）

- **Windows 进程树泄漏**：只杀 node.exe 未用 Job Object，Node 再 spawn 的 git/扩展进程在关窗/崩溃/panic 时残留 — `apps/desktop/src-tauri/src/pi_host.rs:461-526,787-793`（接近高危，发布前必修）
- stderr 洪泛无节流，异常 Host 可打爆事件通道 — `pi_host.rs:536-561`
- `agent_dir` 无路径校验，可穿越到任意目录创建/写入 — `src/desktop_settings.rs:81-89`
- JSONL 单行无长度上限，畸形 Host 可 OOM — `pi_host.rs:578-603`
- stdout/stderr IO 错误 `Err(_) => break` 静默吞掉，误判为正常退出 — `pi_host.rs:558-559,602-603`

### 前端（6）

- `extensionUi.request` 只校验到 workspace 级，后台会话的模态请求会弹到前台会话 — `apps/desktop/src/app/App.tsx:257-275`
- `ChatHeader` 的 `setModel/setThinking` 后未 `mergeHostIdentity`，与其他会话操作不一致 — `apps/desktop/src/features/chat/ChatHeader.tsx:125-165`
- rehydrating/desync 期间仍放行 `host.statusChanged`，可能干扰恢复中的 epoch — `apps/desktop/src/app/App.tsx:109-118`
- `completeRehydrate` 无条件清 desync 标志，gap 未真修复时提前"康复" — `apps/desktop/src/lib/stores/app-store.ts:474-480`
- `Transcript`/`SessionList` 大列表无虚拟化、无 memo，长会话必卡 — `apps/desktop/src/features/chat/Transcript.tsx:126-136`、`apps/desktop/src/features/sessions/SessionList.tsx:581-746`
- `model.changed` 处理器自身不做 session 二次校验（当前靠上游规则兜底，属纵深防御缺口）— `apps/desktop/src/app/App.tsx:89-99`

### protocol（4）

- UUID 正则只收 v1-8 + variant `10xx`，拒绝 nil UUID 等合法值 — `packages/protocol/src/dto-validate.ts:19-24`
- `dist/` + `tsbuildinfo` 留在工作区（与 A4 同因）
- 声明了未使用的 `typebox` 依赖 — `packages/protocol/package.json:21`
- 覆盖测试名不副实（见 C4）

### 脚本/发布/文档（8）

- `THIRD_PARTY_NOTICES.md` 未覆盖实际分发的 Node.js/npm/Portable Git/Tauri — 许可证合规缺口
- `node_modules.zip` 用 `tar.exe` 打包无排序/固定 mtime，不可复现，release manifest 哈希失去证据力 — `scripts/compact-pi-host-resources.mjs:42-50`
- `prepare-release-runtime.mjs` 对 `npm.cmd` 缺失仅 warn 不 fail — `scripts/prepare-release-runtime.mjs:191-194`
- `smoke-release-host.mjs` 失败路径遗留 Host 进程（`die()` 直接 exit）— `scripts/smoke-release-host.mjs:23-26`
- `verify-p0.mjs` 的 gate 列表无 C0–C8 显式映射，叠加 spec 缺失，"full C0–C8 aggregate" 无法审计
- `run-e2e.mjs` 不像 `smoke-release.mjs` 那样清洗 PATH，可能掩盖 release 资源缺失、回退全局 Node — `scripts/run-e2e.mjs:477-494`
- `dev-fast.mjs` 硬编码 1420 端口且归属判断仅靠 title 字符串 — `scripts/dev-fast.mjs:9,140-148`
- `p0-evidence.mjs baseline` 把 `test:e2e`/`package:release` 标为 `expected_fail_closed` 且 exit 0，易误导 — `scripts/p0-evidence.mjs:199-205`

---

## 四、低危（26 项，按主题归并）

- **健壮性**：`desktop-settings.json` 反序列化失败静默回退默认（`apps/desktop/src-tauri/src/desktop_settings.rs:55-59`）；`patch` 无字段白名单；JSONL transport 按 chunk 解码 UTF-8，多字节字符跨 chunk 会碎（`packages/pi-host/src/transport.ts:12-18`）；`withSessionFileMutation` 锁内无二次 identity 校验（`packages/pi-host/src/workspace-graph-factory.ts:1273-1302`）
- **校验不一致**：`isProviderSnapshot` 不像 draft 校验 `baseUrl` 非空；`provider.save` 运行时拒绝空 `apiKey` 但类型允许；`agent.setActiveTools` 的 names 不查空串/重复；`hasExactKeys` 用 `in` 可吃原型链字段（`packages/protocol/src/dto-validate.ts:10-17`）
- **前端细节**：`apps/desktop/src/features/chat/Transcript.tsx:58-61` render 阶段写 ref 副作用；XSS 单点依赖 Streamdown 的 `skipHtml`；4 个依赖用 `^` 未 pin（`apps/desktop/package.json:19-30`）；StatusBar 通知无 dismiss；vitest 用 node 环境测不了 DOM 交互
- **死代码/杂物**：`packages/pi-host/src/package-snapshot.ts:168-184` 空循环残留；`mcps/` 目录（augment-context-engine、Grok tasks 的工具定义）与产品无关应移出；`docs/reference/source-map.md:45` 引用不存在的 `atomic-mutation.test.ts`；roadmap 的"P0.x 已实现"与 remediation report 的"P0 Not Complete"表述未对齐；`package-release.mjs` 重复调 compact 可能复用旧 zip
- **测试缺口**：Rust 侧无真实进程生命周期测试；protocol 无 result/event payload 负例；前端无 host-client 超时/断连、rehydrate 集成测试；pi-host 无并发交错负面测试（详见下节）

---

## 五、测试体系评价

**现状**：185 用例全绿，纯函数与集成主干覆盖良好——trust pending→trustOnce、`notRequired` 拒绝项目安装、包并发 busy 竞争、extension UI 真实 loader 链路、事件身份不串号、stable-graph-read STALE 等都有测试。

**系统性盲区**（与高危发现一一对应，说明测试策略缺一个维度）：

1. **并发交错负面测试为零**——没有 `session.create` × `steer`、`shutdown` × `package.install` 这类交错用例，B2/B3 因此漏网；
2. **payload 形状对抗用例缺失**——事件/结果只有"合法+缺字段"，没有类型撒谎用例，C4 因此漏网；
3. **同消息多 part 场景未覆盖**，B1 因此漏网；
4. 进程级负面（unhandledRejection、孤儿进程审计只在外部 smoke 脚本里）。

建议补一个"混沌/交错"测试档：对每个非持锁 handler × 每个图变更操作做排列组合的并发断言。

---

## 六、建议修复顺序

### 立即（本周，阻塞级 + 真实 bug）

1. `git init` 并提交基线（remediation blocker #4，也是一切证据链的前提）
2. 修 B1（transcript-reducer 一行修复 + 补多 part 测试）
3. 重新生成 `release-runtime.lock.json`/`STAGING.json` 使哈希与实际 `pnpm-lock.yaml` 一致，并让 CI 校验 `pnpmLockVerified` 不得手写
4. 恢复 `spec/` 三个合同文件，或从所有文档中移除引用——二选一，不能悬空
5. B4 加 `unhandledRejection` 兜底（5 行）+ 把标题精炼挪进 try 内

### 发布前（安全与正确性）

6. B2 非持锁 handler 纳入稳定读/锁内复验；B3 shutdown 走 `serviceGraphLock`
7. Rust：Job Object（`KILL_ON_JOB_CLOSE`）、`desktop_open_path` 路径白名单、`agent_dir` 校验、生产 CSP
8. C4 补齐 DTO 嵌套校验 + 事件/结果 payload 对抗测试
9. 包变更服务端 10min `AbortSignal.timeout`；fingerprint 改异步
10. 安装器签名 + 完整性脚本全文件扫描；`THIRD_PARTY_NOTICES` 补齐 Node/Git/Tauri

### 中期（可维护性）

11. 拆 `workspace-graph-factory.ts`（按 trust/会话/包/扩展四个方向切）
12. 清理入库产物，补 `.gitignore`（resources 产物、zip、`runtime-manifest.json`），移出 `mcps/` 与 `artifacts/desktop-settings.json`
13. Transcript/SessionList 虚拟化；依赖全量 pin
14. E2E 清洗 PATH 与 smoke 对齐；`verify-p0` 增加 C0–C8 显式映射表

---

**一句话总结**：架构与身份体系的设计质量足以支撑正式产品，trust 边界和 fail-closed 思路都正确；当前的核心矛盾是**发布证据链自我锁死**（git/lock 哈希/spec 三连缺失）叠加 **3 个必修的并发/数据 bug** 和**事件后安全加固未闭环**——先修 B1–B4 与 A2，再谈 P0 关门。
