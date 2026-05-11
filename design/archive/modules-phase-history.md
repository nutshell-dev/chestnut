## Phase 138 自检记录

Phase 138 在逐个撰写 L1/L2 模块契约时累积发现的 modules.md 与源码事实不一致的条目，本轮一次性清账。每条记录 before/after 字面 + 契约锚点。

- **D1 L113 AuditLog 导出**：before=`IAuditSink（最小接口，供 L2 消费者注入）` → after=`Audit（类型别名，供 L2 消费者注入；注：L2 模块原声明的 IAuditSink 接口当前源码不存在）`（契约锚点：`modules/l2_audit_log.md` § 7 B 类）
- **D2 L122 Messaging 依赖**：before=`通过 IAuditSink 接口注入 InboxReader` → after=`通过 Audit 类型注入 InboxReader`（契约锚点：`modules/l2_messaging.md` § 3）
- **D3 L143 Snapshot 依赖**：before=`AuditLog（可选，通过 IAuditSink 接口注入）` → after=`AuditLog（可选，通过 Audit 类型注入）`（契约锚点：`modules/l2_snapshot.md` § 3/§ 7 A.5）
- **D4 L90 SessionStore 资源**：before=`messages.json(由调用方指定路径)` → after=`current.json + archive/ + .corrupted(父目录由调用方指定，文件名由 SessionStore 固定)`（契约锚点：`modules/l2_session_store.md` § 1/§ 2）
- **D5 L92 SessionStore 耦合**：before=`无` → after=`AuditLog（可选注入 audit?: Audit，用于 load/save 失败事件）`（契约锚点：`modules/l2_session_store.md` § 3/§ 7 A.2）
- **D6 L83 FileWatcher 被谁调用**：before=`Runtime(监听 inbox 目录变化)、ContractSystem(监视契约状态变化)` → after=`Stream（StreamReader 通过 FileWatcher 监听 stream.jsonl 追加事件）`（契约锚点：`modules/l2_file_watcher.md` § 1；grep 确认唯一实际 importer 是 `foundation/stream/reader.ts`，原声明的 Runtime/ContractSystem 消费者均不直接 import `createWatcher`）
- **D7（取消，非 drift）**：Messaging `导出工具：send` 经 grep 验证 `src/core/tools/builtins/send.ts` 存在且语义归属 Messaging，无需修订。
- **D8 L98 Stream 段首描述**：before=`写入、实时流订阅、历史读取。` → after=`写入、实时流订阅（历史读取待补：StreamReader 当前只跟新，CLI 消费者绕过直读文件，见契约 A.1）。`（契约锚点：`modules/l2_stream.md` § 7 A.1）
- **D9（无变更）**：L100 Stream 归档路径 `logs/stream/` 经 grep 验证 `foundation/stream/writer.ts` `ARCHIVE_DIR = 'logs/stream'` 一致。
- **D10 L103 Stream 被谁调用**：before=`Gateway(订阅实时流推送给客户端)` → after=`Gateway(订阅实时流推送给客户端)、CLI(chat-viewport/daemon-loop/watchdog 等历史读取，绕过 StreamReader，见契约 A.1)`（契约锚点：`modules/l2_stream.md` § 7 A.1）
- **D11 L135 ProcessManager 被谁调用**：before=`Daemon（启动 agent 进程）、CLI（daemon 命令）、Watchdog（存活检查、重启）` → after=`Daemon（启动 agent 进程）、Watchdog（存活检查、重启）、CLI（status/stop/claw/motion/start 等运维子命令）`（契约锚点：`modules/l2_process_manager.md` § 1；Daemon/Watchdog 是 L6 独立模块，其实现文件位于 `cli/commands/` 是代码组织选择，不代表模块身份被 CLI 吞并）
- **D12 L144 Snapshot 耦合**：before=`无` → after=`Stream/AuditLog/Task 文件名（经 GITIGNORE_CONTENT 硬编码聚合，跨模块命名约定，见契约第 5 节）`（契约锚点：`modules/l2_snapshot.md` § 5）
- **D13 L145 Snapshot 被谁调用**：before=`Runtime、Daemon` → after=`Runtime、Daemon、CLI（motion 命令首次 init）`（契约锚点：`modules/l2_snapshot.md` § 1；补漏 `cli/commands/motion.ts` L176 调用）

统一政策（本轮及后续遵循）：
- modules.md「被谁调用」/「资源」/「耦合」字段反映源码事实（包括绕过式调用），契约的 A/B 类负责定性。
- 模块身份 ≠ 代码文件位置。L6 模块（Daemon/Watchdog/CLI）即使实现都放在 `cli/commands/`，模块身份仍独立。

---

## Phase 148 自检记录

背景：Phase 148 — 审计通路工程化。消灭 L2 层 console 静默吞没（`audit/writer.ts` 的 `[AUDIT CRITICAL]` 递归边界除外），统一 `audit?: Audit` → `audit: Audit` 必传，引入 `AUDIT_EVENTS` 常量文件，7 个 L2 模块全部接入结构化事件通道。本段记录由 Step 10 收口时同步到 modules.md 索引层。

- **D1 L93 SessionStore 耦合**：before=`AuditLog（可选注入 audit?: Audit，用于 load/save 失败事件）` → after=`AuditLog（必需注入 audit: Audit，Phase 148 已从可选升级；load/save/archive/recovery 全链路事件）`（契约锚点：`modules/l2_session_store.md` § 3 / § 7 A.2）
- **D2 L83 FileWatcher 耦合**：before=`无` → after=`AuditLog（必需；callback / onReady / onError 三处隔离后事件写入 WATCHER_CALLBACK_FAILED / WATCHER_READY_FAILED / WATCHER_FAILED）`（契约锚点：`modules/l2_file_watcher.md` § 3 / § 7 A.2）
- **D3 L103 Stream 耦合**：before=`无` → after=`AuditLog（必需；StreamWriter + createStreamReader 均接 audit: Audit 必传；writer/reader 10 处失败全部 audit 化）`（契约锚点：`modules/l2_stream.md` § 3 / § 7 A.2 / A.3）
- **D4 L115 AuditLog 导出**：before=`AuditWriter（实现类）、Audit（类型别名）` → after=追加 `createSystemAudit(fs, baseDir)`（Phase 148 新增装配助手：构造 `baseDir/audit.tsv` 指向的 AuditWriter）（契约锚点：`modules/l2_audit_log.md` § 3；源码 `foundation/audit/index.ts:28`）
- **D5 L116 AuditLog 被谁调用**：before=`Daemon(生命周期事件)、Runtime(执行事件)、ContractSystem(契约状态迁移)、SubagentSystem(子代理状态迁移)、Messaging(inbox 状态迁移)、Snapshot(退化事件)` → after=`Daemon / Runtime / ContractSystem / SubagentSystem / Messaging（inbox + outbox 全链路）/ Snapshot / FileWatcher / Stream / ProcessManager / SessionStore（Phase 148 起所有 L2 模块均必需注入）`（契约锚点：全 7 份 L2 契约）
- **D6 L124 Messaging 依赖 + L125 耦合**：before=`依赖=FileSystem, MessageCodec, AuditLog（通过 Audit 类型注入 InboxReader）; 耦合=无` → after=`依赖=FileSystem, MessageCodec, AuditLog（必需；InboxReader + OutboxWriter 均接 audit: Audit）; 耦合=AuditLog（必需；Phase 148 已从可选升级）`（契约锚点：`modules/l2_messaging.md` § 3 / § 7 A.4；事件重命名 `inbox_move_error` → `INBOX_MOVE_FAILED`）
- **D7 L135 ProcessManager 依赖 + L136 耦合**：before=`依赖=FileSystem; 耦合=无` → after=`依赖=FileSystem, AuditLog（Phase 148 起必需）; 耦合=AuditLog（必需；构造第 3 参 audit: Audit；CLI 无 runtime 上下文时通过 createSystemAudit(fs, baseDir) 装配）`（契约锚点：`modules/l2_process_manager.md` § 3 / § 7 A.1 / A.3）
- **D8 L145 Snapshot 依赖**：before=`ProcessExec, FileSystem, AuditLog（可选，通过 Audit 类型注入）` → after=`ProcessExec, FileSystem, AuditLog（必需，Phase 148 已从可选升级）`（契约锚点：`modules/l2_snapshot.md` § 3 / § 7 A.5；附注：motion per-agent audit 隔离先例已登记到 snapshot 契约 B 类）
- **D9（保留未修，Phase 149 / 150 scope）**：modules.md 不动，契约 A 类仍标 "保持未修"：
  - `l2_file_watcher.md` A.1（CLI fsNative.watch 绕过）→ Phase 149（资源归属）
  - `l2_stream.md` A.1（CLI 绕过 StreamReader 直读 stream.jsonl）→ Phase 149
  - `l2_process_manager.md` A.4（CLI 直操作 daemon.lock）→ Phase 149
  - `l2_messaging.md` A.1（`readInboxFileMeta` 返 null 吞没）→ Phase 150（失败语义原语）
  - `l2_messaging.md` A.2（`drainInbox` 返 [] 歧义）→ Phase 150
  - `l2_messaging.md` A.3（`markDone/markFailed` move 失败不抛）→ Phase 150
  - `l2_messaging.md` A.5（上层绕过直写 inbox/）→ Phase 149
  - `l2_messaging.md` A.6（三套 Inbox 写 API 命名分裂）→ Phase 150
  - `l2_snapshot.md` A.6（git exec 失败语义拆分：预期 Result / 不可预期 throw）→ Phase 150；A.5 "事件即唯一追溯"论证基础在 A.6 修复后需重校
  - `l2_process_manager.md` A.2（findProcesses 返 [] 歧义）→ Phase 150

政策延续 Phase 138：
- `modules.md` 耦合 / 依赖字段反映源码事实（本 Phase 统一把 L2 对 AuditLog 从"可选"归并为"必需"）
- 契约 A 类状态由"必修违规"改为"Phase 148 已修复 / 部分修复 / 保持未修（Phase 149/150 scope）"——尾部精准指向后续 Phase

---

## 2026-04-19 L1/L2 契约原则化审查记录

本轮针对 Phase 148 后剩余违规做修复方向收敛，不实施代码改动，仅落在契约文档层。按原则审查结果：

- **LLMService**：定义 `LLMEventSink` 协议（L1 不反向依赖 L2），构造期必传；装配层 fan-out 到 AuditLog + Stream。事件 9 种（provider_attempt_failed / retry_scheduled / provider_exhausted / fallback_switched / breaker_opened/half_open/closed / healthcheck_failed / stream_reset）。A.1 + A.3 统一修复方向已定
- **Transport**：预期失败走返回值（`broadcast → { failed }`）、预期事件扩参数（`onDisconnect(conn, reason?)`）、不可预期失败走 `onTransportError(evt)` 协议。A.1 / A.2 / A.3 修复方向已定
- **Snapshot A.6**：`commit → CommitResult`（预期 `no_changes` / `git_lock_held` → `{ok:false,reason}`；不可预期抛 `Error(cause)`）；`init` 不可预期失败改抛。修复方向已定
- **Snapshot A.7**：Stream / AuditLog / SubagentSystem / FileSystem 各导 `IGNORE_PATTERN`，装配层 `snapshot.addIgnorePattern(...)` 注入；修复方向已定
- **Messaging A.3**：`markDone` / `markFailed` move 失败改抛（候选 α），驳回候选 β（内存 set 违反"磁盘即权威"）
- **Messaging A.5**：修复方向收敛到"Phase 149 先查 bypass 原因再选 α / β"，登记调查步骤、选型条件
- **Stream A.2**：失败语义表对齐修复方向（audit 留痕 + 抛错）
- **FileSystem**：`cleanupOrphanedTemp` free function 显式登记；`IGNORE_PATTERN` 对外导出（`*.tmp.*`）
- **FileWatcher A.2**：外部已更新为 Phase 148 已修复（try/catch + audit 隔离）

索引层同步：
- L1 LLMService 新增协议定义字段、Transport 新增 `TransportErrorEvent` 协议字段
- FileSystem / Stream / AuditLog / SubagentSystem 新增 `IGNORE_PATTERN` 导出字段
- Snapshot 耦合字段更新（命名归属从 "Stream/AuditLog/TaskQueue" 扩到 "Stream / AuditLog / SubagentSystem / FileSystem"）

---

## L1 audit 政策（task #14）

L1 原语对"是否落 audit"须有显式归属，不得按实现者直觉随机决定。按原则"事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"，以及"L1 不反向依赖 L2"，每个 L1 模块的审计归属如下：

| L1 模块 | 审计通道 | 依据 |
|---|---|---|
| **LLMService** | 定义 `LLMEventSink` 协议，装配层 fan-out 到 AuditLog + Stream | provider 失败 / 退避 / failover / breaker 迁移是关键业务决策链路，必须事后可重建；L1 不反向依赖 AuditLog，故协议归 LLMService 定义 |
| **Transport** | 定义 `TransportErrorEvent` 回调协议，装配层注入 AuditLog 消费者 | callback_error / server_error 属不可预期失败，必须暴露；预期失败（disconnect / broadcast partial）走返回值 / 事件参数，不走 audit |
| **FileSystem** | 不走 audit，原样抛 Node fs 错误 | 纯原语，对调用方完全被动；错误归属是调用方（L2 各消费者有责任决定是否 audit）。静默失败风险登记在失败语义表中 |
| **ProcessExec** | 不走 audit，失败统一包 `ProcessExecError` 抛出 | 同上：纯原语，被动接口。调用方（ProcessManager / ContractSystem / Snapshot）各自决定 audit 归属 |
| **MessageCodec** | 不走 audit | 纯函数，无 I/O；`extraMeta` 承接非法/未识别字段使 decode 信息无损，审计责任归调用方 Messaging |

**归属原则**：
1. **L1 定义协议，L2 装配层注入实现**——凡需 audit 的 L1，必须通过协议表达（LLMEventSink / TransportErrorEvent），不得在 L1 直接 import AuditLog
2. **纯原语不 audit**——FileSystem / ProcessExec / MessageCodec 对调用方被动，audit 归属上移到消费者
3. **预期失败不走 audit**——走返回值 / discriminated union（CommitResult / broadcast `{failed}`）；audit 是观察通道，不是处理通道
4. **不可预期失败才进 audit**——breaker 状态迁移、provider 耗尽、回调抛错、server 崩溃

---

## 2026-04-19 Assembly 模块拆分记录

背景：原 Daemon 模块兼任「装配」+「进程生命周期」两组职责，装配代码物理散布在 `cli/commands/daemon.ts` / `motion.ts` / `core/runtime.ts` / `cli/commands/claw.ts` 多个文件。每次新增模块或改某模块构造器签名时，所有装配点同步修改，导致并行 phase 在这些装配文件持续合并冲突（Phase 152 × Phase 150 `writeInbox` 冲突即典型案例）。

### 原则推导

按「每种职责只归一个模块」（原则 1）「模块依赖结构稳定」（原则 6）「耦合界面稳定」（原则 7）逐条推导：

- **原则 1**：装配的变更源是「加/减模块、改依赖拓扑」，进程生命周期的变更源是「OS 信号策略、shutdown 顺序」——变更源不同，是两组独立可变的职责，违反「每种职责只归一个模块」
- **原则 2「模块为自己的业务语义负责」**：「怎么 new 出一个 Snapshot」是 Snapshot 的业务语义（默认值、pattern 合并、audit wrapping 都是内部知识），不该由 Daemon 知晓
- **原则 6**：Daemon 当前依赖所有被装配模块——每加一个模块依赖集就变，依赖结构不稳定
- **原则 7**：Daemon 对外表面虽稳定（start/stop），但内部跟着外部模块增减而膨胀，违反「界面不随内部实现或外部模块增减变化」的精神

### 结论：装配职责三分

| 模块 | 承担的独立职责 | 变更源 |
|---|---|---|
| **各模块自身 setup**（分布式） | 自己怎么 new 出来（默认值、内部依赖合并、audit wrapping） | 自己的构造逻辑变化 |
| **Assembly**（新，L6c） | 启什么模块、以什么拓扑装配、注入跨模块回调 | 加/减模块、改装配拓扑 |
| **Daemon**（瘦身，L6a） | main 入口、信号处理、shutdown 触发 | OS 信号策略、shutdown 顺序 |

### 索引层变更

- **L6c Assembly** 新增至层级表，共 25 个模块
- **Daemon（#23）** 依赖从「直接构造和连接的模块」改为「Assembly」；耦合从「耦合源头」改为「无」；职责从「装配 + 进程生命周期」瘦身为「进程生命周期」
- **Runtime（#19）** 耦合字段 StreamCallbacks 注入方从「Daemon」改为「Assembly」；依赖字段加注「instance 由 Assembly 装配后通过 Daemon 传入」
- 关键设计决策 #15 重写为「Assembly 是装配汇聚点，Daemon 只做进程生命周期」；#16 更新为「Daemon 调 Assembly.assemble 后调 Runtime.start」
- 新增决策 #23「装配职责三分」（本次拆分结论）+ #24「Motion 不是模块是 identity 配置分支」

### 后续工作

- **契约新增**：`design/modules/l6_assembly.md` 已补（2026-04-19）
- **代码落地 phase**：phase155+ 需基于此结构重新规划（原 phase155-157 基于旧 Daemon 定义写的总览已标记待重写）
- **Snapshot 的 `ignorePatterns` 构造参数路线已确认合规**（2026-04-19 二次讨论）。一度考虑的「运行时流目录分离」（workspace/runtime 两层）方案放弃，原因：(1) 扁平布局对 agent 自我导航友好，两层嵌套增加认知负担；(2) dialog/inbox/outbox/tasks 同一模块内兼有持久与瞬态子目录，机械按目录切破坏模块内聚；(3) Snapshot 通过 constructor 接收字符串是"不可消除的耦合显式表达"的标准形态，非耦合。phase153 按原 α 方案推进，仅装配点从 daemon/motion/runtime 改为 Assembly
