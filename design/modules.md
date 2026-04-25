# Clawforum 模块清单

## 模块分层

| 层 | 模块 |
|---|---|
| L1 原语 | FileSystem, ProcessExec, LLMService, MessageCodec, Transport |
| L2 基础设施 | **纯通用**: FileWatcher, ProcessManager, AuditLog；**agent 语义**: SkillSystem, SessionStore, Stream, Messaging, Snapshot |
| L3 执行与连接 | StepExecutor, AgentExecutor, SubAgent, Tools, Gateway |
| L4 任务与业务 | TaskSystem, ContractSystem |
| L5 外壳与能力 | Runtime, Cron, MemorySystem |
| L6a 进程入口 | Daemon, Watchdog |
| L6b 交互入口 | CLI |
| L6c 装配 | Assembly |

共 27 个模块。

---

## 系统拓扑

```
        用户
         ↕（TUI / IM bot 通过 Transport + Gateway）
       motion                   （特殊 claw：对外数据面 + 对内整合者）
      ↕ CLI / Messaging / 跨 claw 资源读（motion 单向访问权）
  claw₁  claw₂  ...            （执行 agent；无用户直连）

独立进程：Watchdog（观察 motion + claw 健康状态）
```

**装配归属维度**：每模块条目的「装配归属」字段精确指明该模块实例化在哪类进程里。可能值：

| 值 | 含义 |
|---|---|
| `两者` | motion daemon 和 claw daemon 都装配 |
| `motion` | 仅 motion daemon 装配 |
| `claw` | 仅 claw daemon 装配 |
| `独立进程` | 自成进程，不装进 motion / claw daemon |
| `按配置` | 某 identity 下由 config 决定装不装（如 `Transport`：motion 可按配置启 TUI 或 offline） |

**原则**：
- 装配决策查此维度 + 拓扑图，不凭直觉
- 模块边界与拓扑不一致 → 按原则 #11「边界和实际依赖对不上停下来讨论」启动重构
- 用户交互模型：**用户 ↔ motion ↔ claw**，claw 的用户交互需求（ask_user / stream 观察 / interrupt 响应）**全部经 motion 中介**，不给 claw 开直连通道（见关键决策 #26）

**工厂登记约定**：各模块按需导出 `createX` 工厂函数供 Assembly 装配期消费。工厂名以 `create` + 模块主 class 名形式暴露（如 `createSnapshot` / `createStreamWriter` / `createContractManager`）；modules.md 条目的「导出」字段不重复列工厂函数，具体签名见各模块对外接口契约 §2。仅非约定形态的导出（如 `createSystemAudit` 指向独立路径、`createWatcher` 而非模块名对应）才在 modules.md 显式登记。

---

## L1 原语

### 1. FileSystem

clawforum 进程内代码的所有文件 I/O 的唯一入口。原子写、路径守护、权限域配置。

- **装配归属**：两者（所有 identity 都依赖 FS）
- **资源**：无自有资源,提供文件操作能力
- **依赖**：无
- **耦合**：无
- **导出**：`IGNORE_PATTERN`（`*.tmp.*`）、`cleanupOrphanedTemp(baseDir)` free function（启动期清理原子写残片）
- **导出工具**：read, write, search, ls
- **被谁调用**：几乎所有模块
- **对外接口契约**：[modules/l1_filesystem.md](modules/l1_filesystem.md)

### 2. ProcessExec

外部进程调用的唯一入口。封装 spawn,超时控制,输出大小限制。

- **装配归属**：两者（两类 daemon 都要 exec 外部工具；ContractSystem 验收脚本也依赖）
- **资源**：无
- **依赖**：无
- **耦合**：无
- **导出工具**：exec
- **被谁调用**：agent 工具层(exec 工具)、ContractSystem(验收脚本)
- **对外接口契约**：[modules/l1_process_exec.md](modules/l1_process_exec.md)

### 3. LLMService

LLM 调用的统一服务。provider 管理、请求组装、KV cache 标记、重试与超时。

- **装配归属**：两者（motion 和 claw 都跑 agent 需要调 LLM）
- **资源**：无
- **依赖**：无（定义 `LLMEventSink` 协议，由装配层注入实现，不反向依赖 L2）
- **耦合**：`LLMEventSink`（构造期必传；装配层 fan-out 到 AuditLog + Stream）
- **定义的协议**：`LLMEventSink`（provider 失败 / 退避 / breaker 状态迁移 / failover / healthcheck / stream_reset 事件发布协议）
- **唯一消费者**：StepExecutor
- **对外接口契约**：[modules/l1_llm_service.md](modules/l1_llm_service.md)

### 4. MessageCodec

inbox/outbox 消息的唯一编解码点。纯函数,不碰磁盘。

- **装配归属**：两者（Messaging 的依赖，随 Messaging 装配）
- **资源**：无
- **依赖**：无
- **耦合**：无
- **唯一消费者**：Messaging
- **对外接口契约**：[modules/l1_message_codec.md](modules/l1_message_codec.md)

### 5. Transport

实时双向通信原语。管理与外部客户端(TUI、IM bot)的连接,提供推送和接收能力。协议(socket/pipe/WebSocket)是内部实现细节。

- **装配归属**：`motion` 独占（数据面对外通信；按配置决定是否启动监听——无 TUI 需求则不装；claw 不装，claw 的用户交互经 motion 中介）
- **资源**：无自有磁盘资源；**派生运行时状态** connections Map / 每连接接收 buf，listen 期间实现持有、close 后释放，重启从 socket 握手重建
- **依赖**：无（不反向依赖 L2；通过 `onTransportError` 回调把不可预期失败暴露给 Gateway）
- **耦合**：`TransportErrorEvent` 回调协议（Gateway 注入实现，fan-out 到 AuditLog / Stream）
- **被谁调用**：Gateway
- **对外接口契约**：[modules/l1_transport.md](modules/l1_transport.md)

---

## L2 基础设施

### 6. FileWatcher

文件系统变化通知。polling 补漏、多平台差异抹平。不懂业务目录语义,不读文件内容。

- **装配归属**：两者（StreamReader / ContractSystem watcher 消费者，两类 daemon 都需要）
- **资源**：无(订阅集合是运行期状态,重启重建)
- **依赖**：FileSystem, AuditLog
- **耦合**：AuditLog（必需；callback / onReady / onError 三处隔离后事件写入 `WATCHER_*` 命名空间）
- **被谁调用**：Stream（`StreamReader` 通过 FileWatcher 监听 `stream.jsonl` 追加事件）；Contract 等其他 watcher 消费者
- **对外接口契约**：[modules/l2_file_watcher.md](modules/l2_file_watcher.md)

### 7. SessionStore

messages 数组的持久化读写。服务于"中断可恢复"。

- **装配归属**：两者（每类 daemon 各自持有自己的对话 session；dialogDir 按 claw/motion 隔离）
- **资源**：current.json + archive/ + .corrupted(父目录由调用方指定，文件名由 SessionStore 固定)
- **依赖**：FileSystem, AuditLog
- **耦合**：AuditLog（必需；load/save/archive/recovery 全链路事件）
- **被谁调用**：AgentExecutor(每次 LLM 调用后落盘,启动时恢复)
- **对外接口契约**：[modules/l2_session_store.md](modules/l2_session_store.md)

### 8. Stream

执行过程的实时观察窗口。服务于"用户可以观察运行过程中的所有状态"。写入、实时流订阅。

- **装配归属**：两者（写侧 StreamWriter 各自装自己的 stream.jsonl；读侧 StreamReader 按场景装——motion 装用于 Gateway 订阅 + 跨 claw 读，claw 自身一般不装读侧）
- **资源**：stream.jsonl(当前会话事件流)、logs/stream/(归档)
- **依赖**：FileSystem, AuditLog, FileWatcher（L2 同层，读侧 StreamReader 监听 stream.jsonl 追加）
- **耦合**：AuditLog（必需）
- **导出**：`IGNORE_PATTERN`（`stream.jsonl` + `logs/stream/`）
- **定义的协议**：`StreamCallbacks`（执行过程事件的发布协议，上游 StepExecutor/AgentExecutor/Runtime 通过此接口发布事件）
- **被谁调用**：Gateway(订阅实时流推送给客户端)、CLI(chat-viewport/daemon-loop/watchdog 等历史读取)
- **对外接口契约**：[modules/l2_stream.md](modules/l2_stream.md)

### 9. AuditLog

状态迁移审计记录。服务于"运行中产生的所有信息全量记录以供审计"。纯追加写。

- **装配归属**：两者（每类 daemon 各自持有自己的 audit.tsv；motion + 各 claw 分别独立审计文件）
- **资源**：audit.tsv
- **依赖**：FileSystem
- **耦合**：无
- **导出**：`AuditWriter`（实现类）、`Audit`（类型别名）、`createSystemAudit(fs, baseDir)`（CLI 无 runtime 上下文时的装配助手）、`IGNORE_PATTERN`（`audit.tsv`）
- **被谁调用**：Daemon / Runtime / ContractSystem / TaskSystem / SubAgent / Messaging / Snapshot / FileWatcher / Stream / ProcessManager / SessionStore（所有 L2 模块均必需注入）
- **对外接口契约**：[modules/l2_audit_log.md](modules/l2_audit_log.md)

### 10. Messaging

inbox/outbox 的目录管理、消息投递与拉取。所有跨 agent 消息通信的必经之路。

- **装配归属**：两者（每个 agent 各自的 inbox/outbox 独立；跨 agent 通信的媒介层）
- **资源**：inbox/(pending/done/failed)、outbox/(pending)
- **依赖**：FileSystem, MessageCodec, AuditLog
- **耦合**：AuditLog（必需）
- **导出工具**：send
- **被谁调用**：Runtime(拉取 inbox 消息)、TaskSystem(投递子代理任务结果)、ContractSystem(投递验收结果/通知)、MemorySystem(投递记忆整合结果)、CLI(投递系统通知)
- **对外接口契约**：[modules/l2_messaging.md](modules/l2_messaging.md)

### 11. ProcessManager

进程生命周期管理。spawn、stop、存活检查、PID 文件管理。

- **装配归属**：两者（Daemon 启动时 registerSelf；Watchdog 独立进程装自己的 PM；CLI 运维子命令实例化）
- **资源**：所有进程的 PID 文件（含他人 spawn 写入与自启动 self-register 写入）、lockfile
- **依赖**：FileSystem, AuditLog
- **耦合**：AuditLog（必需）
- **被谁调用**：Daemon（启动 agent 进程、自启动 registerSelf）、Watchdog（存活检查、重启、自启动 registerSelf）、CLI（status/stop/claw/motion/start 等运维子命令）
- **对外接口契约**：[modules/l2_process_manager.md](modules/l2_process_manager.md)

### 12. Snapshot

agent 目录的版本化快照。对 agent 目录执行 git commit，记录历史状态，支持回滚到任意历史点。

- **装配归属**：两者（每个 agent（motion 自己 + 每个 claw）各自的 git 快照独立）
- **资源**：agent 目录内的 .git
- **依赖**：ProcessExec, FileSystem, AuditLog
- **耦合**：`ignorePatterns: string[]`（构造注入）。gitignore 条目的命名归属属各源模块（Stream / AuditLog / TaskSystem 等），Snapshot 通过构造参数接收，由 Assembly 装配时聚合注入（详见契约 §5）
- **被谁调用**：Runtime（一轮 agent 执行结束后触发）、Daemon（启动时 recovery-snapshot + daemon-start commit）、CLI（motion 命令首次 init）
- **对外接口契约**：[modules/l2_snapshot.md](modules/l2_snapshot.md)

### 13. SkillSystem

技能元信息注册表。扫描 skillsDir 目录加载技能元信息（frontmatter），渐进式披露：启动仅元信息，调 skill 工具时才加载完整 SKILL.md。

- **装配归属**：两者（主 claw 用 skills/ / motion 用 clawspace/dispatch-skills/；由 `createSkillRegistry(fs, skillsDir)` 工厂按身份注入 skillsDir）
- **资源**：`skillsDir` 参数指向的目录（默认 `'skills'`）；磁盘即权威，内存 `metaMap` 派生态
- **依赖**：FileSystem（L1）、MessageCodec（L1，parseFrontmatter）、AuditLog（L2）
- **耦合**：`formatForContext` 作耦合窄化点收敛上下文注入格式。详见 `modules/l2_skill_system.md` §5
- **导出工具**：skill（dispatch 工具消费 `formatForContext`，但 dispatch 本身归 TaskSystem(L4) 导出）
- **被谁调用**：Assembly（主装配）/ Runtime / ContextInjector / TaskSystem / SubAgent / ContractSystem（review_request）/ dispatch + skill 工具
- **对外接口契约**：[modules/l2_skill_system.md](modules/l2_skill_system.md)

---

## L3 执行与连接

### 14. StepExecutor

单步执行器。调一次 LLM,如果返回 tool_use 则执行对应 handler,返回更新后的 messages + 停止信号。

- **装配归属**：两者（AgentExecutor 的依赖，随上层装配）
- **资源**：无
- **依赖**：LLMService
- **耦合**：
  - 工具 handler 签名(装配期由 Daemon 注入工具 map)
  - StreamCallbacks(由调用方透传,写入执行事件到 Stream)
- **定义的协议**：`ToolHandler`（工具调用协议 `ToolUseBlock → ToolResultBlock`，各模块导出的工具是协议实现者）
- **唯一消费者**：AgentExecutor
- **对外接口契约**：[modules/l3_step_executor.md](modules/l3_step_executor.md)

### 15. AgentExecutor

驱动一次完整的 agent 执行。反复调 StepExecutor 跑单步,每次 LLM 调用后通过 SessionStore 落盘,直到收到停止信号。

- **装配归属**：两者（motion Runtime 和 claw Runtime 都驱动 agent 执行；SubAgent 一次性子代理执行也用）
- **资源**：无
- **依赖**：StepExecutor, SessionStore
- **耦合**：
  - StreamCallbacks(由调用方透传)
  - abort 回调(由 Daemon 注入,用于外部中断)
- **定义的协议**：`AbortSignal`（中断协议——执行器如何接收并响应外部中断；Gateway 等触发源通过此接口通知）
- **被谁调用**：Runtime(常驻 agent 执行)、SubAgent(一次性子代理内部 `run()` 调 `runReact` 驱动)
- **对外接口契约**：[modules/l3_agent_executor.md](modules/l3_agent_executor.md)

### 16. SubAgent

一次性 agent 执行原语 —— 跑一次完整的 react loop 生命周期。不管外部排队、并发、崩溃恢复（那些是 L4 TaskSystem 的事）。和 StepExecutor / AgentExecutor 是同层"agent 执行相关的 L3 原语"；与 TaskSystem（任务生命周期管理）是独立可变职责（meta-principle「执行原语 vs 生命周期管理」）。

- **装配归属**：两者（SubAgent class 无 identity 分支；实例化由调用方 new）
- **资源**：无自有资源；执行期写入调用方指定的 `tasks/results/{agentId}/stream.jsonl` + `audit.tsv` + `messages.json`（路径资源归 TaskSystem）
- **依赖**：LLMService (L1), SkillSystem (L2), ToolRegistry / ToolExecutor / ExecContextImpl（L3 内部同层）
- **耦合**：StreamCallbacks（由调用方透传，同 StepExecutor / AgentExecutor 同构）
- **定义的协议**：无（承接 AgentExecutor 的 StreamCallbacks / AbortSignal）
- **被谁调用**：L4 TaskSystem(`executeTask` 主路径)、L4 ContractManager(`runLLMAcceptance` LLM 验收路径)
- **对外接口契约**：[modules/l3_subagent.md](modules/l3_subagent.md)

### 17. Tools

工具框架 —— 提供 agent 调用工具的机制层：`Tool` interface / `ToolRegistry` / `ToolExecutor` / `ExecContext` / `CallerType` / `TOOL_PROFILES` 权限系统；含 `ReportResultTool`（contract verifier 子代理专用结构化返回工具）。

**定位 α.1（声明式归属）**：本模块只定义工具框架，不拥有具体业务工具的业务语义。12 个 builtins 物理上位于 `src/core/tools/builtins/`（代码组织选择），业务语义归属各自业务模块（详见"不导出业务工具"字段）。α.2 物理搬迁为远期优化，近期不做。

- **装配归属**：两者（agent 执行必需）
- **资源**：无（ToolRegistry 是运行期派生态，不落盘）
- **依赖**：Message / LLMService / FileSystem / AuditWriter 类型（来自 L1-L2）；业务模块定义的 Tool 对象作为注册源（装配期由 Assembly 注册）
- **耦合**：无 capability 协议（关键决策 #29 已移除）
- **导出**：
  - 框架：`ToolRegistry` / `ToolRegistryImpl` / `ToolExecutor` / `ToolExecutorImpl` / `ExecContext` / `ExecContextImpl` / `CallerType` / `callerTypeToProfile`
  - 权限：`TOOL_PROFILES`（full / readonly / subagent / miner / dream / verifier 白名单）
  - 工具：`ReportResultTool`（verifier 子代理专用，属 tools 自身机制）
- **不导出业务工具**（12 个 builtins 业务语义归各自模块）：
  - read / write / ls / search → FileSystem（L1）
  - exec → ProcessExec（L1）
  - send → Messaging（L2）
  - skill → SkillSystem（L2）
  - done → ContractSystem（L4）
  - spawn / dispatch → TaskSystem（L4）
  - ask_motion → TaskSystem（L4，dispatch 内部实现细节，不对外暴露）
  - memory_search → MemorySystem（L5）
  - status → CLI（L6b）
  - ask_user → Gateway（L3）
- **被谁调用**：StepExecutor（`IToolExecutor.execute`）、AgentExecutor（透传 ctx.signal）、SubAgent（构造 ToolExecutor + Registry）、TaskSystem（构造 effectiveRegistry 传 SubAgent）、Runtime（注册运行期专用工具）、Assembly（初始工具注册）
- **对外接口契约**：[modules/l3_tools.md](modules/l3_tools.md)

### 18. Gateway

管理外部客户端与系统之间的实时交互（数据面）。订阅 Stream 推送事件给客户端、接收客户端信号路由到系统内部、提供 `ask_user` 工具让 agent 阻塞等待用户回复。与 CLI（控制面，daemon 生命周期管理）并列，共同构成系统对外边界。

- **装配归属**：`motion` 独占（motion 是用户唯一对外 agent；claw 的用户交互需求经 motion 中介——见关键决策 #26）
- **资源**：无（派生运行时状态 connections / pending，重启从事件流重建）
- **依赖**：Stream（通过 `streamFactory` 注入）、Transport（可选，L1；无则进入 offline mode）
- **耦合**：interrupt 回调（由 Daemon 注入，反向控制流）、Stream 只读订阅、Transport 生命周期绑定、连接视图派生——4 条
- **导出工具**：ask_user（向用户提问等待回复）
- **被谁调用**：Daemon（启动时创建）
- **对外接口契约**：[modules/l3_gateway.md](modules/l3_gateway.md)

---

## L4 任务与业务

### 19. TaskSystem

subagent / tool 任务的异步调度 + 崩溃恢复 + 结果持久化回传。外部调用方经 `writePendingSubagentTaskFile` 直写 `tasks/pending/`；TaskSystem 内 FileWatcher 订阅 pending/ 拾起 → 状态机流转 → new L3 SubAgent 执行 → OutboxWriter 回传父 claw。Runtime 协调生命周期（initialize / startDispatch / shutdown），业务语义归 TaskSystem 自身实现。

- **装配归属**：两者（motion + claw 都装配 TaskSystem；Runtime 独占持有，Instances 接口不含 taskSystem 字段）
- **资源**：`tasks/(pending/running/done/failed/results/)` 五子目录
- **依赖**：FileSystem, LLMService, AuditLog, Stream, FileWatcher, SkillSystem (L2), OutboxWriter (L2 Messaging), L3 SubAgent class（全部 L1-L2 下向 + L3 同/下向）
- **耦合**：AuditLog；parentStreamLog（可选输出 sink，Runtime 运行期注入，#6 显式豁免）
- **导出工具**：spawn, dispatch（spawn 和 dispatch 的编排涉及 L1-L2 多模块工具注册与 SubAgent 构造，是 L4 TaskSystem 的职责；ask_motion 为 dispatch 内部实现细节，不在 TOOL_PROFILES 白名单，不列为导出工具）
- **导出**：`IGNORE_PATTERN`（`tasks/results/`）
- **被谁调用**：Runtime（构造 + 生命周期协调）、Assembly（`createTaskSystem` 工厂）、cron / daemon（经 `writePendingSubagentTaskFile` 直写 `tasks/pending/`）
- **对外接口契约**：[modules/l4_task_system.md](modules/l4_task_system.md)

### 20. ContractSystem

契约的完整生命周期管理。创建、状态追踪、验收判定(脚本/LLM)、重试/升级、暂停/恢复/取消、归档、review_request 整合（contract 完成后的 retro 触发，motion 独有）。

- **装配归属**：主路径 Assembly（`createContractManager` 工厂，motion 与 claw 两身份均走此路径）
- **资源**：`contract/active/` + `contract/paused/` + `contract/archive/`（每契约子目录含 `progress.json` + `progress.lock`）+ `by-contract/` 索引
- **依赖**：FileSystem, LLMService, AuditWriter, ToolRegistryImpl(verifier), InboxWriter, execFile/ProcessExec, SkillSystem (L2), TaskSystem (L4 同层)
- **耦合**：onNotify 回调装配期注入、progress.lock 文件锁
- **导出工具**：done（pause/resume/cancel 走 CLI）
- **被谁调用**：Runtime（经 Assembly 注入）、agent 工具层(done)、CLI(`contract create/pause/resume/cancel/log`)、motion 启动特权
- **对外接口契约**：[modules/l4_contract_system.md](modules/l4_contract_system.md)

---

## L5 外壳与能力

### 21. Runtime

常驻 agent 的事件驱动循环。等待事件 → 启动一轮 AgentExecutor 执行 → 执行完成后回到等待。Runtime 不做装配（已独立为 Assembly，L6c），只接收装配好的 instances 跑循环。Motion 和 Claw 的差异由 Assembly 按 identity 配置分支决定，Runtime 内部无身份分支。

- **装配归属**：两者（motion Runtime / claw Runtime 均经 `createRuntime({ identity })` 工厂实例化；identity 分支消化在工厂入口，Runtime 内部无身份分支）
- **资源**：无
- **依赖**：`dependencies: RuntimeDependencies`（Assembly 预制后注入，完整字段见 `modules/l5_runtime.md` §4）
- **耦合**：StreamCallbacks / DaemonStreamCallbacks(publisher-subscriber 形态 B，由 Assembly 注入透传)，详见 `modules/l5_runtime.md` §5
- **内部组件**：`ContextInjector`（构建 system prompt 的组装器，Runtime 模块内部组件，不独立成模块；物理位置 `core/dialog/` 属代码组织选择）
- **被谁调用**：Daemon(启动常驻 agent)
- **对外接口契约**：[modules/l5_runtime.md](modules/l5_runtime.md)

### 22. Cron

纯调度引擎。按 schedule（daily / hourly / interval）定时触发 handler，含去重键（同时窗内仅触发一次）+ 并发保护（同 job 不重叠）+ 异常隔离（handler 异常不扩散）。

- **装配归属**：`motion` 独占（按 `config.cron.enabled` 装配 `Instances.cronRunner`；由 `createCronRunner(jobs)` 工厂构造，class 内部无 identity 感知）
- **资源**：无磁盘资源；内存句柄 `timer` / `lastRunKey` Map / `running` Set（重启丢失容忍）
- **依赖**：零产品模块依赖；仅 Node 内置 `setInterval` / `Date` / `Map` / `Set`
- **耦合**：`CronJob` 接口作 handler 注入协议（publisher-subscriber 形态 B：Cron 定义协议 / Assembly 提供 jobs 实现）
- **定义的协议**：`CronJob`（含 name / enabled / schedule / handler 4 字段；handler 异常由 Cron 隔离）
- **导出**：`createCronRunner` 工厂 / `parseSchedule` fn / `CronRunner` class / `CronJob` + `CronSchedule` type
- **被谁调用**：Assembly（主装配 + bind 配置参数 + `cronRunner.start(tickMs)` 启动；jobs 业务逻辑在 `core/cron/jobs/*.ts` 各文件内，α.1 声明式归属 MemorySystem/LLMService/ContractSystem 等，见契约 §7 B.p173-1）
- **对外接口契约**：[modules/l5_cron.md](modules/l5_cron.md)

### 23. MemorySystem

智能体的记忆整合。dream、经验提炼、知识沉淀。

- **装配归属**：`motion` 独占（Philosophy "motion 主动整合多个智能体的持久化记忆充分提取信息"）
- **资源**：`.deep-dream-state.json`（per claw）/ `.random-dream-state.json`（clawforumDir 根）
- **依赖**：LLMService（注入接口消费），TaskSystem（random-dream 子代理调度），Messaging（InboxWriter 投递），FileSystem
- **耦合**：无
- **导出**：`createMemorySystem` 工厂 / `MemorySystem` class / `runDeepDream` + `runRandomDream`（内部导出，供直接调用）
- **导出工具**：memory_search（物理保留在 `tools/builtins/`，工具注册为 tools 域职责）
- **被谁调用**：Assembly（构造 MemorySystem）→ Cron `dream-trigger` handler（调用 `runDeepDream` / `runRandomDream`）
- **对外接口契约**：[modules/l5_memory_system.md](modules/l5_memory_system.md)

---

## L6 入口

L6 分三类：
- **L6a 进程入口**（Daemon、Watchdog）：由 OS / shell / systemd 直启的 main 进程
- **L6b 交互入口**（CLI）：Philosophy 规定的"claw 和 motion 的唯一对外入口"，所有进程外使用者（用户、智能体、Watchdog）通过此接口与系统交互
- **L6c 装配**（Assembly）：模块装配根。由 L6a 进程入口调用，按 identity 配置分支决定启哪些模块 + 拓扑 + 注入跨模块回调。装配职责独立于进程生命周期

### 24. Daemon

进程生命周期管理。main 入口、信号处理、按 Assembly 返回的 Instances 触发 shutdown。装配职责已独立为 Assembly 模块（L6c），Daemon 不知道被启的模块内部细节，只对 Instances 调 `disassemble`。

- 启动期：调 `Assembly.assemble(config)` 取得 Instances，调 `Runtime.start(instances)` 启动业务
- 运行期：管理进程信号(SIGTERM/SIGINT)；事件循环由 `startDaemonLoop(options)` 驱动 Runtime
- 关停期：调 `Assembly.disassemble(instances)` 让各模块按拓扑反向清理
- **装配归属**：两者（每个 daemon 进程——motion daemon + 每个 claw daemon——都由 Daemon 模块实例化）
- **资源**：process signal handler（SIGTERM/SIGINT/uncaughtException/unhandledRejection）
- **依赖**：Assembly（通过 Instances 接收装配好的模块）；Runtime 公共 API 消费仅 3 方法（processBatch / retryLastTurn / abort，耦合界面最小）
- **耦合**：无（driver/state 分离是 publisher-subscriber 形态 B，见 `modules/l6_daemon.md` §5）
- **被谁调用**：进程入口（daemon-entry.ts → daemonCommand）
- **对外接口契约**：[modules/l6_daemon.md](modules/l6_daemon.md)

### 25. CLI

系统的标准操作接口。用户和智能体通过同一个接口管理系统。Motion 作为用户的代理,通过 exec 执行 CLI 命令管理 clawforum,与用户使用同一套接口。CLI 的耦合界面稳定性直接影响智能体行为。

- 每个命令独立构造所需模块实例,执行一次操作后退出
- **装配归属**：独立命令进程（不装配在 motion / claw daemon 内部；CLI 是短生命周期命令进程，每次 invoke 独立）。同时提供 status 工具给 agent 进程内调用（motion / claw 的 agent 用 status 工具时走进程内分派，不 fork 子进程）
- **资源**：无
- **依赖**：L1-L5 各模块（每命令独立实例化所需模块子集；依赖方向满足 L6b→L1-L5 下向约束，不反向依赖 L6a Daemon/Watchdog）
- **耦合**：无
- **导出工具**：status（进程内调用 CLI 命令处理函数,不 spawn 子进程）
- **被谁调用**：用户终端、智能体(通过 exec 工具)

### 26. Watchdog

进程级健康监控。独立进程，观察 + 干预系统健康状态。非智能体（无 LLM / 无 prompt），是监督基础设施。

- Motion 存活监控与自动重启（`pm.spawn` + 指数回避 backoff，上限 5 min）
- Claw 崩溃检测（was alive → now dead 且持合约）→ drop `crash_notification` 文件到 motion inbox（motion 中介）
- Claw 不活跃检测（有活跃契约但 LLM 事件 timeout）→ drop 提醒到 motion inbox

- **装配归属**：独立进程（不装进 motion / claw daemon；由 CLI `watchdog start` 派生独立运行）
- **资源**：
  - `watchdog.pid`：watchdog 自维护，不通过 ProcessManager 自注册
  - `watchdog-state.json`：跨进程持久化的通知去重状态
  - `logs/watchdog.log`：文本日志
  - `audit.tsv`：复用全局（watchdog 为自己事件的归属源）
- **依赖**：ProcessManager, AuditLog, FileSystem, CLI config
- **耦合**：motion 作为 claw crash 通知中介（watchdog 无直接用户通道）
- **被谁调用**：CLI `watchdog start/stop/status` 命令
- **对外接口契约**：[modules/l6_watchdog.md](modules/l6_watchdog.md)

### 27. Assembly

模块装配根。按 identity 配置分支决定启哪些模块 + 调各模块 `createX` setup 函数 + 注入跨模块回调 + 返回 Instances 句柄集。Assembly 会随模块数量增加而变大，但对外耦合界面恒定为 `assemble(config) / disassemble(instances)`，外部模块增减不影响调用方。

- 依赖拓扑：读 config，按 L1 → L5 顺序调 `createFileSystem` / `createProcessExec` / `createAuditLog` / `createSnapshot` / ... / `createRuntime`
- 跨模块回调注入：StreamCallbacks、interrupt、Cron handler、LLMEventSink fan-out、TransportErrorEvent fan-out 全部在此接入
- **装配归属**：两者（identity 分支逻辑在 Assembly 内部；motion / claw daemon 都 import Assembly 并调用）
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
5. ~~**SubagentSystem 合并 TaskRunner**~~ **【2026-04-21 废止】**：违反 meta-principle「执行原语 vs 生命周期管理 = 独立可变职责」。修正：SubAgent class 下移 L3（与 StepExecutor / AgentExecutor 同层），L4 保留 TaskSystem + ContractSystem。契约迁移详情 `modules/l3_subagent.md`；教训 `feedback_primitive_vs_lifecycle_split.md` + `feedback_default_split_not_merge.md`
6. **dispatch 和 spawn 独立工具**：dispatch 发起 mining mode,spawn 创建通用子代理。两者归属 TaskSystem(L4) 导出（关键决策 #29）
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
25. **Runtime 不自建 L1-L2 实例**：构造器接收 `dependencies: RuntimeDependencies`，由 Assembly 预制所有依赖后注入；跨模块共享实例（如 Snapshot）由 Assembly 构造一次同时出现在 `Instances` 和 `RuntimeDependencies` 中
26. **用户 ↔ motion ↔ claw 中介模型（Gateway / Transport motion 独占）**：用户通过 TUI / IM bot 直连 motion（Transport + Gateway 数据面）；claw 与用户**无直连**。claw 的用户交互需求（观察 stream / ask_user / interrupt 响应）全部经 motion 中介：
    - **观察 stream**：motion 读 claw 的 `stream.jsonl`（motion 对 claw 有单向访问权），经 motion 的 Gateway 转发给 TUI
    - **ask_user**：claw 的 ask_user 需求不走 `Gateway.askUser`（claw 无 Gateway 实例）；应通过 Messaging 发给 motion → motion 的 Gateway 问用户 → 回复经 Messaging 返 claw
    - **interrupt**：用户在 TUI 触发 → motion Gateway 收到 → motion 通过 CLI / Messaging 把 interrupt 路由到 target claw
    - **装配结果**：Gateway / Transport 装配归属 = `motion` 独占；claw identity 不装。Assembly identity 分支依此执行
    - 此决策消解了"Philosophy 说 CLI 是唯一对外入口 vs Gateway 对外"的表面冲突：CLI 是控制面入口（命令、生命周期），Gateway 是数据面入口（运行时交互），两者并列；数据面**仅在 motion 层开放**，不扩散到 claw
27. **Tools α.1 声明式归属**：Tools 模块只定义工具框架，不拥有业务工具的业务语义。业务工具归各自业务模块（详见 #17 Tools "不导出业务工具"）；builtins 物理位置 `src/core/tools/builtins/` 是代码组织选择，不改变业务归属。α.2 物理搬迁作为远期优化不做
28. **SkillSystem 归 L2 基础设施**（2026-04-21 phase173）：SkillSystem 依赖只用 L1-L2（FileSystem + MessageCodec），被 L3-L6 广泛消费，实际依赖结构表明它是基础设施能力不是 L5"外壳"。**根本原则依据 M5**「依赖单向，底层不预设上层」——挪 L2 后消除 L4 TaskSystem / ContractSystem 原 L4→L5 反向依赖；附带消解 M2 违规（原"L3 tools 定义 `SkillLookup` 切断循环"让工具框架代 SkillSystem 定义对外语义，违反「模块为自己的业务语义负责」）
29. **移除 capability 协议机制**（2026-04-23）：Tools 模块定义的 3 个 capability 协议（`TaskScheduler` / `ContractQuery` / `OutboxSink`）全部不必要，予以移除。原因分析：
    1. **TaskScheduler 不需要**：spawn/dispatch 工具的编排涉及 L1-L2 多模块工具注册，是 L4 TaskSystem 的职责而非 L3 SubAgent 的职责。spawn 工具应归 TaskSystem(L4) 导出，工具内部直接调 `writePendingSubagentTaskFile`，无 L3→L4 跨层依赖问题
    2. **ContractQuery 不需要**：verifier 子代理可通过 `read` 工具自读 `contract/active/{id}/progress.json`，或由 ContractSystem 创建时将验收信息写入 context/prompt
    3. **OutboxSink 不需要**：SubAgent 执行结果由 TaskSystem 拾起后写入 outbox，SubAgent 作为纯执行原语不涉及回传
    4. **原则依据**：M1（spawn 编排是 TaskSystem 的职责不应散落在 L3）、M2（L3 不应为 L4 定义业务接口）、M5（L3 不应预设 L4 语义）；与"目录驱动化"演进方向一致——工具 + 磁盘目录已天然解耦，协议中间层是过度抽象
30. **ContractSystem LLM 验收经 TaskSystem 调度**（2026-04-23）：ContractSystem 不直接 `new SubAgent` 跑 LLM 验收，改为经 TaskSystem 调度 verifier 子代理。理由：
    - **D1/D4 合规**：验收子代理崩溃后可被 TaskSystem 恢复，不丢失
    - **M1 合规**：子代理调度是 TaskSystem 的职责，不应散落在 ContractSystem
    - **M8 合规**：消除 ContractSystem 对 SubAgent 构造接口的知识（TaskSystem 单点管理 SubAgent 构造）
    - 附带消除 TaskSystem 对 ContractManager 的不必要依赖（原透传给 SubAgent options，done 工具由 ContractSystem 导出、内部持有引用，不需 TaskSystem 透传）

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
