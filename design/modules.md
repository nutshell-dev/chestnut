# Clawforum 模块清单

## 模块分层

| 层 | 模块 |
|---|---|
| L1 原语 | FileSystem, ProcessExec, LLMService, MessageCodec, Transport |
| L2 基础设施 | FileWatcher, SessionStore, Stream, AuditLog, Messaging, ProcessManager, Snapshot |
| L3 执行与连接 | StepExecutor, AgentExecutor, Gateway |
| L4 任务与业务 | SubagentSystem, ContractSystem |
| L5 外壳与能力 | Runtime, SkillSystem, Cron, MemorySystem |
| L6a 进程入口 | Daemon, Watchdog |
| L6b 交互入口 | CLI |
| L6c 装配 | Assembly |

共 25 个模块。

---

## L1 原语

### 1. FileSystem

clawforum 进程内代码的所有文件 I/O 的唯一入口。原子写、路径守护、权限域配置。

- **资源**：无自有资源,提供文件操作能力
- **依赖**：无
- **耦合**：无
- **导出**：`IGNORE_PATTERN`（`*.tmp.*`，配合 Snapshot A.7 修复）、`cleanupOrphanedTemp(baseDir)` free function（启动期清理原子写残片）
- **导出工具**：read, write, search, ls
- **被谁调用**：几乎所有模块
- **对外接口契约**：[modules/l1_filesystem.md](modules/l1_filesystem.md)

### 2. ProcessExec

外部进程调用的唯一入口。封装 spawn,超时控制,输出大小限制。

- **资源**：无
- **依赖**：无
- **耦合**：无
- **导出工具**：exec
- **被谁调用**：agent 工具层(exec 工具)、ContractSystem(验收脚本)
- **对外接口契约**：[modules/l1_process_exec.md](modules/l1_process_exec.md)

### 3. LLMService

LLM 调用的统一服务。provider 管理、请求组装、KV cache 标记、重试与超时。

- **资源**：无
- **依赖**：无（定义 `LLMEventSink` 协议，由装配层注入实现，不反向依赖 L2）
- **耦合**：`LLMEventSink`（构造期必传；装配层 fan-out 到 AuditLog + Stream，解决 A.1 / A.3）
- **定义的协议**：`LLMEventSink`（provider 失败 / 退避 / breaker 状态迁移 / failover / healthcheck / stream_reset 事件发布协议）
- **唯一消费者**：StepExecutor
- **对外接口契约**：[modules/l1_llm_service.md](modules/l1_llm_service.md)

### 4. MessageCodec

inbox/outbox 消息的唯一编解码点。纯函数,不碰磁盘。

- **资源**：无
- **依赖**：无
- **耦合**：无
- **唯一消费者**：Messaging
- **对外接口契约**：[modules/l1_message_codec.md](modules/l1_message_codec.md)

### 5. Transport

实时双向通信原语。管理与外部客户端(TUI、IM bot)的连接,提供推送和接收能力。协议(socket/pipe/WebSocket)是内部实现细节。

- **资源**：无
- **依赖**：无（不反向依赖 L2；通过 `onTransportError` 回调把不可预期失败暴露给 Gateway）
- **耦合**：`TransportErrorEvent` 回调协议（Gateway 注入实现，fan-out 到 AuditLog / Stream）
- **被谁调用**：Gateway
- **对外接口契约**：[modules/l1_transport.md](modules/l1_transport.md)

---

## L2 基础设施

### 6. FileWatcher

文件系统变化通知。polling 补漏、多平台差异抹平。不懂业务目录语义,不读文件内容。

- **资源**：无(订阅集合是运行期状态,重启重建)
- **依赖**：FileSystem, AuditLog（Phase 148 起必需，第 4 位置参数 `audit: Audit`）
- **耦合**：AuditLog（必需；callback / onReady / onError 三处隔离后事件写入 `WATCHER_CALLBACK_FAILED` / `WATCHER_READY_FAILED` / `WATCHER_FAILED`）
- **被谁调用**：Stream（`StreamReader` 通过 FileWatcher 监听 `stream.jsonl` 追加事件）；Contract 等其他 watcher 消费者（均需传入 audit）
- **对外接口契约**：[modules/l2_file_watcher.md](modules/l2_file_watcher.md)

### 7. SessionStore

messages 数组的持久化读写。服务于"中断可恢复"。

- **资源**：current.json + archive/ + .corrupted(父目录由调用方指定，文件名由 SessionStore 固定)
- **依赖**：FileSystem, AuditLog
- **耦合**：AuditLog（必需注入 `audit: Audit`，Phase 148 已从可选升级；load/save/archive/recovery 全链路事件）
- **被谁调用**：AgentExecutor(每次 LLM 调用后落盘,启动时恢复)
- **对外接口契约**：[modules/l2_session_store.md](modules/l2_session_store.md)

### 8. Stream

执行过程的实时观察窗口。服务于"用户可以观察运行过程中的所有状态"。写入、实时流订阅（历史读取待补：`StreamReader` 当前只跟新，CLI 消费者绕过直读文件，见契约 A.1）。

- **资源**：stream.jsonl(当前会话事件流)、logs/stream/(归档)
- **依赖**：FileSystem, AuditLog（Phase 148 起必需）
- **耦合**：AuditLog（必需；`StreamWriter` + `createStreamReader` 均接 `audit: Audit` 必传；writer/reader 10 处失败全部 audit 化）
- **导出**：`IGNORE_PATTERN`（`stream.jsonl` + `logs/stream/`，配合 Snapshot A.7 修复）
- **定义的协议**：`StreamCallbacks`（执行过程事件的发布协议，上游 StepExecutor/AgentExecutor/Runtime 通过此接口发布事件）
- **被谁调用**：Gateway(订阅实时流推送给客户端)、CLI(chat-viewport/daemon-loop/watchdog 等历史读取，绕过 StreamReader，见契约 A.1)
- **对外接口契约**：[modules/l2_stream.md](modules/l2_stream.md)

### 9. AuditLog

状态迁移审计记录。服务于"运行中产生的所有信息全量记录以供审计"。纯追加写。

- **资源**：audit.tsv
- **依赖**：FileSystem
- **耦合**：无
- **导出**：`AuditWriter`（实现类）、`Audit`（类型别名）、`createSystemAudit(fs, baseDir)`（Phase 148 新增装配助手：构造 `baseDir/audit.tsv` 指向的 AuditWriter；用于 CLI 无 runtime 上下文的 ProcessManager 装配）、`IGNORE_PATTERN`（`audit.tsv`，配合 Snapshot A.7 修复）；注：L2 模块原声明的 `IAuditSink` 接口当前源码不存在
- **被谁调用**：Daemon / Runtime / ContractSystem / SubagentSystem / Messaging（inbox + outbox 全链路）/ Snapshot / FileWatcher / Stream / ProcessManager / SessionStore（Phase 148 起所有 L2 模块均必需注入）
- **对外接口契约**：[modules/l2_audit_log.md](modules/l2_audit_log.md)

### 10. Messaging

inbox/outbox 的目录管理、消息投递与拉取。所有跨 agent 消息通信的必经之路。

- **资源**：inbox/(pending/done/failed)、outbox/(pending)
- **依赖**：FileSystem, MessageCodec, AuditLog（必需；InboxReader + OutboxWriter 均接 `audit: Audit`）
- **耦合**：AuditLog（必需；Phase 148 已从可选升级）
- **导出工具**：send
- **被谁调用**：Runtime(拉取 inbox 消息)、SubagentSystem(交付子代理结果)、ContractSystem(投递验收结果/通知)、MemorySystem(投递记忆整合结果)、CLI(投递系统通知)
- **对外接口契约**：[modules/l2_messaging.md](modules/l2_messaging.md)

### 11. ProcessManager

进程生命周期管理。spawn、stop、存活检查、PID 文件管理。

- **资源**：所有进程的 PID 文件（含他人 spawn 写入与自启动 self-register 写入）、lockfile
- **依赖**：FileSystem, AuditLog（Phase 148 起必需）
- **耦合**：AuditLog（必需；构造第 3 参 `audit: Audit`；CLI 无 runtime 上下文时通过 `createSystemAudit(fs, baseDir)` 装配）
- **被谁调用**：Daemon（启动 agent 进程、自启动 registerSelf）、Watchdog（存活检查、重启、自启动 registerSelf）、CLI（status/stop/claw/motion/start 等运维子命令）
- **对外接口契约**：[modules/l2_process_manager.md](modules/l2_process_manager.md)

### 12. Snapshot

agent 目录的版本化快照。对 agent 目录执行 git commit，记录历史状态，支持回滚到任意历史点。

- **资源**：agent 目录内的 .git
- **依赖**：ProcessExec, FileSystem, AuditLog（必需，Phase 148 已从可选升级）
- **耦合**：`ignorePatterns: string[]`（构造注入）。gitignore 条目的**命名归属**属各源模块（Stream `STREAM_FILE` / AuditLog `AUDIT_FILE` / TaskSystem `TASKS_RESULTS_DIR` 等），Snapshot 通过构造参数接收，由 Assembly 装配时聚合注入；Snapshot 自身不出现别模块资源名字面量——属"不可消除的耦合显式表达 + 编译器可检"的合规形态。契约 A.7 修复方向已收敛（phase153 待实施）
- **被谁调用**：Runtime（一轮 agent 执行结束后触发）、Daemon（启动时 recovery-snapshot + daemon-start commit）、CLI（motion 命令首次 init）
- **对外接口契约**：[modules/l2_snapshot.md](modules/l2_snapshot.md)

---

## L3 执行与连接

### 13. StepExecutor

单步执行器。调一次 LLM,如果返回 tool_use 则执行对应 handler,返回更新后的 messages + 停止信号。

- **资源**：无
- **依赖**：LLMService
- **耦合**：
  - 工具 handler 签名(装配期由 Daemon 注入工具 map)
  - StreamCallbacks(由调用方透传,写入执行事件到 Stream)
- **定义的协议**：`ToolHandler`（工具调用协议 `ToolUseBlock → ToolResultBlock`，各模块导出的工具是协议实现者）
- **唯一消费者**：AgentExecutor
- **对外接口契约**：[modules/l3_step_executor.md](modules/l3_step_executor.md)

### 14. AgentExecutor

驱动一次完整的 agent 执行。反复调 StepExecutor 跑单步,每次 LLM 调用后通过 SessionStore 落盘,直到收到停止信号。

- **资源**：无
- **依赖**：StepExecutor, SessionStore
- **耦合**：
  - StreamCallbacks(由调用方透传)
  - abort 回调(由 Daemon 注入,用于外部中断)
- **定义的协议**：`AbortSignal`（中断协议——执行器如何接收并响应外部中断；Gateway 等触发源通过此接口通知）
- **被谁调用**：Runtime(常驻 agent 执行)、SubagentSystem(一次性子代理执行)
- **对外接口契约**：[modules/l3_agent_executor.md](modules/l3_agent_executor.md)

### 15. Gateway

管理外部客户端与系统之间的实时交互。订阅 Stream 推送事件给客户端,接收客户端信号路由到系统内部。

- **资源**：无
- **依赖**：Stream, Transport(可选;无则进入 offline mode)
- **耦合**：interrupt 回调(由 Daemon 注入,收到中断信号时调用)
- **导出工具**：ask_user(向用户提问,等待回复;offline mode 下立即失败)
- **被谁调用**：Daemon(启动时创建)
- **对外接口契约**：[modules/l3_gateway.md](modules/l3_gateway.md)

---

## L4 任务与业务

### 16. SubagentSystem

一次性子代理的唯一工厂 + 生命周期管理。配置 → 创建任务目录 → 调 AgentExecutor 执行 → 状态追踪 → 结果通过 Messaging 交付。

- **资源**：tasks/ 目录
- **依赖**：AgentExecutor, Messaging, FileSystem, AuditLog
- **耦合**：无
- **导出**：`IGNORE_PATTERN`（`tasks/results/`，配合 Snapshot A.7 修复；契约待补 L4）
- **导出工具**：spawn, dispatch, ask（子代理向父代理请教,继承父代理上下文快照）
- **被谁调用**：agent 工具层(spawn/dispatch)、ContractSystem(创建 verifier/复盘子代理)、MemorySystem(创建 dream 子代理)

### 17. ContractSystem

契约的完整生命周期管理。创建、状态追踪、验收判定(脚本/LLM)、重试/升级、暂停/恢复/取消、归档。

- **资源**：contract/ 目录
- **依赖**：FileSystem, FileWatcher, ProcessExec, SubagentSystem, Messaging, AuditLog
- **耦合**：无
- **导出工具**：done
- pause/resume/cancel 走 CLI
- **被谁调用**：agent 工具层(done)、CLI(contract create/pause/resume/cancel/log)

---

## L5 外壳与能力

### 18. Runtime

常驻 agent 的事件驱动循环。等待事件 → 启动一轮 AgentExecutor 执行 → 执行完成后回到等待。Runtime 不做装配（已独立为 Assembly，L6c），只接收装配好的 instances 跑循环。Motion 和 Claw 的差异由 Assembly 按 identity 配置分支决定，Runtime 内部无身份分支。

- **资源**：无
- **依赖**：`dependencies: RuntimeDependencies`（必传，由 Assembly 预制后注入）。Runtime 不直接创建任何 L1-L2 模块实例，也不 `new NodeFileSystem`——这些由 Assembly 预制后注入。Runtime.initialize() 仅执行业务动作（session repair、inbox init、L3-L5 组装——后者 phase155C 搬走）。完整字段列表见 `coding plan/phase155/接口冻结.md` §3 / `src/core/runtime.ts`
- **耦合**：StreamCallbacks(由 Assembly 注入,透传给 AgentExecutor)
- **被谁调用**：Daemon(启动常驻 agent)

### 19. SkillSystem

技能注册表。扫描 skills/ 目录加载技能元信息,渐进式披露。

- **资源**：skills/ 目录
- **依赖**：FileSystem
- **耦合**：无
- **导出工具**：skill
- **被谁调用**：agent 工具层(skill 工具)、Daemon(装配时初始化)

### 20. Cron

纯调度引擎。按 schedule 定时触发 handler。

- **资源**：无
- **依赖**：无
- **耦合**：handler 签名(装配期由 Daemon 注入,Cron 不知道 handler 做什么)
- **定义的协议**：`CronHandler`（定时调度协议——handler 必须能被 Cron 按 schedule 触发）
- **被谁调用**：Daemon(装配 jobs 并启动调度器)

### 21. MemorySystem

智能体的记忆整合。dream、经验提炼、知识沉淀。

- **资源**：记忆文件
- **依赖**：SubagentSystem, Messaging, FileSystem
- **耦合**：无
- **导出工具**：memory_search
- **被谁调用**：Cron(定时触发)

---

## L6 入口

L6 分三类：
- **L6a 进程入口**（Daemon、Watchdog）：由 OS / shell / systemd 直启的 main 进程
- **L6b 交互入口**（CLI）：Philosophy 规定的"claw 和 motion 的唯一对外入口"，所有进程外使用者（用户、智能体、Watchdog）通过此接口与系统交互
- **L6c 装配**（Assembly）：模块装配根。由 L6a 进程入口调用，按 identity 配置分支决定启哪些模块 + 拓扑 + 注入跨模块回调。装配职责独立于进程生命周期

### 22. Daemon

进程生命周期管理。main 入口、信号处理、按 Assembly 返回的 Instances 触发 shutdown。装配职责已独立为 Assembly 模块（L6c），Daemon 不知道被启的模块内部细节，只对 Instances 调 `disassemble`。

- 启动期：调 `Assembly.assemble(config)` 取得 Instances，调 `Runtime.start(instances)` 启动业务
- 运行期：管理进程信号(SIGTERM/SIGINT)
- 关停期：调 `Assembly.disassemble(instances)` 让各模块按拓扑反向清理
- **资源**：status/(lockfile)
- **依赖**：Assembly（通过 Instances 接收装配好的模块）
- **耦合**：无
- **被谁调用**：进程入口（motion.ts / daemon.ts）

### 23. CLI

系统的标准操作接口。用户和智能体通过同一个接口管理系统。Motion 作为用户的代理,通过 exec 执行 CLI 命令管理 clawforum,与用户使用同一套接口。CLI 的耦合界面稳定性直接影响智能体行为。

- 每个命令独立构造所需模块实例,执行一次操作后退出
- **资源**：无
- **依赖**：按命令不同依赖不同模块
- **耦合**：无
- **导出工具**：status（进程内调用 CLI 命令处理函数,不 spawn 子进程）
- **被谁调用**：用户终端、智能体(通过 exec 工具)

### 24. Watchdog

进程级健康监控。独立进程，监控系统健康状态并干预。

- Motion 存活监控与自动重启
- Claw 崩溃检测,通知 Motion
- Claw 不活跃检测（有活跃契约但长时间无进展）,通知 Motion

- **资源**：watchdog-state.json、logs/watchdog.log（Watchdog 自身 PID 通过 ProcessManager.registerSelf 写入，归 ProcessManager 管）
- **依赖**：ProcessManager, AuditLog, CLI
- **耦合**：无
- **被谁调用**：进程入口

### 25. Assembly

模块装配根。按 identity 配置分支决定启哪些模块 + 调各模块 `createX` setup 函数 + 注入跨模块回调 + 返回 Instances 句柄集。Assembly 会随模块数量增加而变大，但对外耦合界面恒定为 `assemble(config) / disassemble(instances)`，外部模块增减不影响调用方。

- 依赖拓扑：读 config，按 L1 → L5 顺序调 `createFileSystem` / `createProcessExec` / `createAuditLog` / `createSnapshot` / ... / `createRuntime`
- 跨模块回调注入：StreamCallbacks、interrupt、Cron handler、LLMEventSink fan-out、TransportErrorEvent fan-out 全部在此接入
- **资源**：无
- **依赖**：L1-L5 各模块的 `createX` setup 函数（装配汇聚点是其本职，原则 1 / 7 允许）
- **耦合**：无（它是编排的源头）
- **导出**：`assemble(config: AssembleConfig): Instances`、`disassemble(instances: Instances): Promise<void>`
- **被谁调用**：Daemon（进程入口 motion.ts / daemon.ts 通过 Daemon.run 间接调用）
- **对外接口契约**：[modules/l6_assembly.md](modules/l6_assembly.md)

---

## 关键设计决策

1. **工具 handler 装配期注入 StepExecutor**：各模块导出工具定义 → Daemon 注入
2. **FileSystem 权限域**：agentFs + trustedFs,白名单由 Daemon 注入
3. **SessionStore 不绑目录**：base path 由调用方决定
4. **StepExecutor 只跑一步**：循环归 AgentExecutor,每步之间落盘
5. **SubagentSystem 合并 TaskRunner**：一次性子代理完整生命周期在一个模块内
6. **dispatch 和 spawn 独立工具**：dispatch 发起 mining mode,spawn 创建通用子代理
7. **智能体通过 CLI 操作系统**：Motion 作为用户的代理,通过 exec 执行 CLI 命令管理 clawforum(创建契约、管理 claw 等),与用户使用同一套接口。这不是模块间耦合,是智能体与系统边界的交互
8. **ContractSystem 低频操作走 CLI**：pause/resume/cancel 不占工具位,智能体需要时通过 exec 调 CLI
9. **配置是数据不是模块**：统一 config 文件,Daemon 装配时切片分发
10. **Stream + AuditLog 拆分**：Stream(实时观察)服务于"状态可观察",AuditLog(事后审计)服务于"全量审计",独立可变
11. **Transport 独立原语**：实时双向通信与文件 I/O、进程调用并列为第三种 I/O 原语
12. **Gateway 桥接 Stream 与 Transport**：订阅 Stream 变更 + 推送给客户端,接收客户端信号 + 路由到系统
13. **回调注入是显式耦合**：装配期注入的回调签名是模块耦合界面的一部分,在模块描述中显式列出
14. **中断信号走 Gateway → 回调**：Gateway 收到客户端中断信号后通过 Daemon 注入的回调触发 abort,不走磁盘文件
15. **Assembly 是装配汇聚点，Daemon 只做进程生命周期**：装配职责独立为 Assembly 模块（L6c），Daemon 不参与任何模块装配。任何模块的构造接口变更只触及 Assembly 和该模块自身的 `createX` setup，不扩散到 Daemon 或入口脚本（motion.ts / daemon.ts）
16. **事件驱动循环归 Runtime**：daemon-loop 的逻辑归 Runtime；Daemon 调 `Assembly.assemble(config)` 拿到 Instances 后调 `Runtime.start(instances)`
17. **ProcessManager 独立于 Daemon**：进程生命周期管理（spawn/stop/isAlive/PID）是基础设施能力,Daemon、CLI、Watchdog 三方共用,不归任何一方内部
18. **Watchdog 是 L6 入口**：进程级健康监控是系统行为,需要审计,不是外部设施。通过 CLI 查询系统状态,不直接读其他模块的资源
19. **Snapshot 轮级快照**：agent 目录的 git 快照在一轮执行结束后触发,不在每步触发,平衡历史可回滚与性能开销
20. **工具实现可走进程内 CLI 调用**：跨模块聚合信息的工具（如 status）背后调用 CLI 命令处理函数,不 spawn 子进程,不直接依赖多个业务模块
21. **CLI 是所有进程外使用者的统一入口**：用户、智能体（通过 exec）、Watchdog 通过同一个 CLI 界面与系统交互
22. **ProcessManager 是库代码，PID 策略唯一归属此模块**：各进程按需实例化 ProcessManager；PID 文件（他人 spawn 写入 + 自启动 registerSelf 写入）与 lockfile 均归 ProcessManager，自启动进程通过 registerSelf 接入，不直接操作 PID 文件字面量
23. **装配职责三分**：「怎么装出一个模块」归各模块的 `createX` setup 函数；「启什么模块、以什么拓扑装配」归 Assembly 模块；「进程生命周期」归 Daemon。三者是独立可变的职责（变更源不同），按原则 1「每种职责只归一个模块」必须拆
24. **Motion 不是模块，是 identity 配置分支**：motion.ts 和 daemon.ts 是两种进程入口文件，都经 `Assembly.assemble(config)` 装配 + `Daemon.run(instances)` 跑循环；差异由 Assembly 按 `identity: 'motion' | 'claw'` 分支决定，不构成独立模块
25. **phase155B — Runtime L1-L2 装配剥离到 Assembly**：Runtime 不再自建任何 L1-L2 模块（NodeFileSystem / AuditWriter / Snapshot / SessionManager / InboxReader / OutboxWriter），构造器接收 `dependencies: RuntimeDependencies`（16 字段，L1-L2 必传 + L3-L5 optional→phase155C 必传）。Snapshot 单实例：Assembly 构造唯一对象，同时出现在 `Instances.snapshot` 和 `RuntimeDependencies.snapshot`。`RuntimeDependencies` 定义冻结于 `coding plan/phase155/接口冻结.md` §3，代码权威在 `src/core/runtime.ts`

---

## 未来演进方向

### 目录驱动化

当前工具直接调用业务模块 API。未来可能演进为"工具只写目录、业务模块轮询响应"。为保留这个可能性,V1 实现遵守以下自律：

1. **工具调业务模块只做"下单"动作,不消费返回值** — spawn 立即返回 taskId,不等任务结果；done 只做"标记"动作。工具不持有 handle、不订阅后续事件
2. **业务模块把磁盘当权威状态,不在内存里缓存"真相"** — TaskRunner 的待跑任务从目录读,ContractSystem 的活跃契约从 contract/active/ 读。内存可有运行期状态,但"下一步该做什么"的判定必须回到磁盘
3. **所有写操作用原子写** — 临时文件 + rename,未来工具直接写目录时格式完全一致
4. **文件格式严格定义** — 跨模块数据结构集中定义,业务模块写出的文件 = 未来工具要写出的文件,同一份 schema 共用

### 分布式部署

当前所有模块在单机运行。未来跨主机部署时：

- CLI 命令通过 SSH 执行目标主机的 CLI,调用点不变
- Transport 内部换成跨网络协议,对外接口不变
- Watchdog 的健康检查通过 CLI 远程执行,不直接读目标主机文件

---

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

未在本轮动：（task #13 / #14 均已补齐，见下两节）

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
- **Daemon（#22）** 依赖从「直接构造和连接的模块」改为「Assembly」；耦合从「耦合源头」改为「无」；职责从「装配 + 进程生命周期」瘦身为「进程生命周期」
- **Runtime（#18）** 耦合字段 StreamCallbacks 注入方从「Daemon」改为「Assembly」；依赖字段加注「instance 由 Assembly 装配后通过 Daemon 传入」
- 关键设计决策 #15 重写为「Assembly 是装配汇聚点，Daemon 只做进程生命周期」；#16 更新为「Daemon 调 Assembly.assemble 后调 Runtime.start」
- 新增决策 #23「装配职责三分」（本次拆分结论）+ #24「Motion 不是模块是 identity 配置分支」

### 后续工作

- **契约新增**：`design/modules/l6_assembly.md` 已补（2026-04-19）
- **代码落地 phase**：phase155+ 需基于此结构重新规划（原 phase155-157 基于旧 Daemon 定义写的总览已标记待重写）
- **Snapshot 的 `ignorePatterns` 构造参数路线已确认合规**（2026-04-19 二次讨论）。一度考虑的「运行时流目录分离」（workspace/runtime 两层）方案放弃，原因：(1) 扁平布局对 agent 自我导航友好，两层嵌套增加认知负担；(2) dialog/inbox/outbox/tasks 同一模块内兼有持久与瞬态子目录，机械按目录切破坏模块内聚；(3) Snapshot 通过 constructor 接收字符串是"不可消除的耦合显式表达"的标准形态，非耦合。phase153 按原 α 方案推进，仅装配点从 daemon/motion/runtime 改为 Assembly

