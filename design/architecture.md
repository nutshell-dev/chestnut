# Clawforum 架构

> 应然描述层。原则见 `principles.md`，跨模块代码层级接口契约见 `interfaces.md`和`interfaces/*.md`，单模块内部 spec 与 drift 登记见 `modules/*.md`，治理实践见 `practices.md`。

**本质**：clawforum = agent 即目录（P1）+ 上下文工程（P2）。架构分层 derive 自此双本质 + P3 分多个智能体加分子任务 + P4 系统为智能体服务。

## 模块层定位

每层为更高层提供其需要但不该自己 own 的能力（M#1 derive）。下层模块不依赖上层模块（M#5 derive）。模块越层 own 不属本层的能力即违反层定位。

| 层 | 功能本质 | 根本问题 |
|---|---|---|
| L1 | 原语（primitive）| 与外部世界（OS、网络、外部 SDK）的中性接口。把异构吸收成可调用 primitive。 |
| L2a 通用 | 基础设施（infrastructure）| 在 L1 原语之上的通用基础服务（audit、快照、进程编排），多模块共用的能力抽到这一层。 |
| L2b LLM 语义 | LLM 协议层基础设施 | LLM 协议层概念抽象（**LLM call snapshot 持久化**（phase 709 reframe）、event stream、LLM 调用容错编排、工具协议）。 |
| L2c agent 语义 | agent 业务概念基础设施 | agent 业务概念 wrapper（messaging、skill、工具机制、file 工具、command 工具）。 |
| L3 | agent 原语（agent primitive）| agent 执行的最小单元：单步 LLM 调用、agent loop、子代理。 |
| L4 | agent 基础设施（agent infrastructure）| 在 L3 agent 原语之上的可重用业务流程框架，调用 agent 完成业务流程（任务调度、契约管理、记忆、契约复盘等）。 |
| L5 | 服务（service）| 逻辑层服务抽象 — 装进主 daemon 进程内长期运行（事件驱动循环、定时调度、客户端交互桥接等）。 |
| L6 | 进程边界（process boundary）| 物理层进程实现 — 把抽象栈装成进程（主 daemon、独立监控进程、命令进程、装配根）。 |

新模块或新能力归属时先查表，找归属方，不写到错的层。

## 系统拓扑

```
        用户
         ↕（经 Transport + Gateway）
       motion                   （特殊 claw：对外数据面 + 对内整合者）
      ↕ CLI / Messaging / 跨 claw 资源读（motion 单向访问权）
  claw₁  claw₂  ...            （执行 agent；无用户直连）

独立进程：Watchdog（观察 motion + claw 健康状态）
```

**装配归属维度**：每模块条目的「装配归属」字段精确指明该模块的可装配性约束。可能值：

| 值 | 含义 |
|---|---|
| `按需` | 任何 daemon 装配方按 use case 决定是否装，装多少实例 |
| `motion-only` | 仅 motion daemon 装（架构强制），当前 0 模块硬性 motion-only |
| `motion+claw` | motion daemon + claw daemon 都装（架构强制），当前 0 模块硬性 motion+claw |
| `独立进程` | 自成进程，架构强制（如 Watchdog 跨 daemon health monitor，不能装入被监控对象内） |
| `命令进程` | 短生命周期命令进程（如 CLI，不装入 daemon 是因为命令式入口 vs long-running service 的不同） |

**原则**：
- 装配决策查此维度 + 拓扑图，不凭直觉
- 模块边界与拓扑不一致 → 按 M#11「边界和实际依赖对不上停下来讨论」启动重构

---

## L1 原语

### 1. FileSystem

**本质**：文件 I/O 能力的原语

**层归属**：L1 原语。判据「不依赖任何业务语义就能存在」。

### 2. ProcessExec

**本质**：进程能力的原语

**层归属**：L1 原语。判据「不依赖任何业务语义就能存在」。

### 3. LLMProvider

**本质**：单一 LLM provider 调用能力的原语

**层归属**：L1 原语。判据「不依赖任何业务语义就能存在」。

### 4. Transport

**本质**：持久双向通道能力的原语

**层归属**：L1 原语。判据「不依赖任何业务语义就能存在」。

### 5. FileWatcher

**本质**：文件变化通知能力的原语

**层归属**：L1 原语。判据「不依赖任何业务语义就能存在」。

---

## L2 基础设施

L2 三子层划分（layer table 体现 / 表 1「层」列用 L2a/L2b/L2c）：

- **L2a 通用**：AuditLog (6) / Snapshot (7) / ProcessManager (8)
- **L2b LLM 语义**：DialogStore (9) / Stream (10) / LLMOrchestrator (11) / ToolProtocol (12)
- **L2c agent 语义**：Messaging (13) / SkillSystem (14) / Tools (15) / FileTool (16) / CommandTool (17)

### 6. AuditLog

**本质**：状态迁移审计记录的追加写服务

**层归属**：L2a 通用基础设施 / 不知任何业务语义。

### 7. Snapshot

**本质**：目标目录的版本化快照服务

**层归属**：L2a 通用基础设施 / 不知任何业务语义（具体回滚策略归调用方）。

### 8. ProcessManager

**本质**：进程生命周期编排服务

**层归属**：L2a 通用基础设施 / 不知 agent / LLM 业务（OS 信号映射归 L1）。

### 9. DialogStore

**本质**：dialog（广义 = LLM call snapshot）持久化服务（phase 709 sharpen 术语 / dialog 广义化：systemPrompt + messages + toolsForLLM 3 件同源 LLM API call snapshot / messages 仅是 dialog 的狭义部分 / 推翻 phase 466 把 dialog 等同 messages 的狭义定义）

**层归属**：L2b LLM 语义基础设施 / 知 LLM API call 3 参（systemPrompt + messages + toolsForLLM）协议 / 不绑 agent 概念。

**说明**：per-turn 持久化完整 LLM API call 上下文 snapshot / 3 件同源（不是「messages 主 / systemPrompt 附属」的不对等关系）/ 派生用例：(1) 中断恢复（重启时从磁盘 LLM call snapshot 重建对话上下文）/ (2) ask_motion（subagent reader 全然一致性 reuse Motion runtime 实然 LLM call snapshot）/ (3) ask_caller（r53+ spawn cluster marker prefix 恢复）/ (4) dialog replay / time-travel debugging。

### 10. Stream

**本质**：执行过程事件流服务

**层归属**：L2b LLM 语义基础设施 / 知 LLM 协议层 event types / 不绑 agent identity。

### 11. LLMOrchestrator

**本质**：LLM 调用的协议层封装。把 LLM 协议层细节从 caller 隔离，让 caller 透明看到调用结果。

**层归属**：L2b LLM 语义基础设施 / 知 LLM 调用语义（容错编排）/ 不知 agent 业务。

### 12. ToolProtocol

**本质**：LLM 工具调用协议的 schema 抽象

**层归属**：L2b LLM 语义基础设施 / type-only schema / 不知 clawforum 业务。

### 13. Messaging

**本质**：跨 agent 消息通信服务

**层归属**：L2c agent 语义基础设施 / 知 agent 概念（claw 间通信）。

### 14. SkillSystem

**本质**：技能资源加载注册表服务

**层归属**：L2c agent 语义基础设施 / 知 agent 概念（skills 是 agent 能力）/ 渐进式披露 derive 自 P2 上下文工程。

### 15. Tools

**本质**：工具注册加派发机制框架

**层归属**：L2c agent 语义基础设施 / 工具机制框架 / 不预设 caller 类型 + 权限矩阵（归 L6 Assembly 装配期注入）。

### 16. FileTool

**本质**：agent 文件工具服务

**层归属**：L2c agent 语义基础设施 / 知 agent 概念（自由输入路径需 sandbox）/ 截断+分页 derive 自 P2 上下文工程。

### 17. CommandTool

**本质**：agent 命令工具服务

**层归属**：L2c agent 语义基础设施 / 知 agent 概念（自由命令需 sandbox）/ 截断 derive 自 P2 上下文工程。

---

## L3 agent 原语

### 18. StepExecutor

**本质**：agent 单步执行的原语

**层归属**：L3 agent 原语 ——「单步 LLM 调用」。

### 19. AgentExecutor

**本质**：跑 agent 循环的算法原语 / 不持业务语义

**层归属**：L3 agent 原语 ——「agent 循环」。

### 20. SubAgent

**本质**：sub-agent 实例化加生命周期管理的原语 / 持「sub-agent」业务语义

**层归属**：L3 agent 原语 ——「子代理」。

---

## L4 agent 基础设施

### 21. AsyncTaskSystem

**本质**：基于目录队列的通用**异步**任务调度服务（同步路径不归本模块 / sync caller 直 createSubAgent / per phase 502 invariant-3 async/sync path 分流判据）

**层归属**：L4 agent 基础设施 ——「异步任务调度」。

> 改名历史：原名 `TaskSystem` / phase 508 rename → `AsyncTaskSystem`（用户判据「现在只管异步任务」）。

### 22. ContractSystem

**本质**：契约生命周期管理服务

**层归属**：L4 agent 基础设施 ——「契约管理」。

### 23. MemorySystem

【设计中，先不实现】**本质**：智能体持久化记忆服务（dream 经验提炼 + 记忆查询）

**层归属**：L4 agent 基础设施 ——「记忆」。

### 24. EvolutionSystem

**本质**：能力进化服务

**层归属**：L4 agent 基础设施 ——「契约复盘」。

---

## L5 服务

### 25. Runtime

**本质**：常驻 agent 的事件驱动循环服务

**层归属**：L5 服务 ——「事件驱动循环」（layer table「装进主 daemon 进程内长期运行」子服务之一）。

### 26. Cron

**本质**：定时调度服务

**层归属**：L5 服务 ——「定时调度」（layer table「装进主 daemon 进程内长期运行」子服务之一）。

### 27. Gateway

【设计中，先不实现】**本质**：外部客户端 ↔ 内部系统实时交互门面（数据面）

**层归属**：L5 服务 ——「客户端交互桥接」（layer table「装进主 daemon 进程内长期运行」子服务之一）。

### 28. StatusService

**本质**：agent 自我状态聚合 introspection 服务

**层归属**：L5 服务 ——「daemon 内部 state 聚合 introspection」（layer table「装进主 daemon 进程内长期运行」子服务之一）。聚合多业务模块（ContractSystem / AsyncTaskSystem 等）+ FileSystem 视图，对 agent 暴露单一 status 工具；read-only / 0 自有资源 / 0 持久化。

---

## L6 进程边界

### 29. Daemon

**本质**：进程生命周期管理服务

**层归属**：L6 进程边界 ——「主 daemon」。

### 30. CLI

**本质**：系统的标准操作接口

**层归属**：L6 进程边界 ——「命令进程」。

### 31. Watchdog

**本质**：进程级健康监控服务

**层归属**：L6 进程边界 ——「独立监控进程」。

### 32. Assembly

**本质**：模块装配根

**层归属**：L6 进程边界 ——「装配根」。

---

## 全模块架构 fact 一览

每模块在系统里的作用分两种：对其他模块的承诺（API 与协议）和对智能体的承诺（agent-facing tool）。后者是 clawforum 系统的特殊维度，derive 自 Philosophy「系统为智能体服务」与 Design Principle「智能体是决策主体，系统在智能体需要决策时交付相关信息」。下列三张表分别给出模块在系统中的位置、对其他模块的承诺、对智能体的承诺。

> 三表均为应然描述。实然 drift 见 modules/*.md §7。

> **M#3 资源唯一归属说明**：表 1「资源」列述模块 own 的**业务资源**（功能性概念）/ 非物理路径独占。物理路径约定（如 `tasks/`）可包含多模块共享子目录（如 `tasks/sync/` scratch space 由装配方 own lifecycle / 不归任一业务模块）/ 此类 scratch 资源不在表 1 列。

### 表 1 模块在系统中的位置

| 模块 | 层 | 装配归属 | 资源 | 依赖 | 耦合 | 被谁调用 |
|---|---|---|---|---|---|---|
| FileSystem | L1 | 按需 | 无 | 无 | 无 | 几乎所有模块 |
| ProcessExec | L1 | 按需 | 无 | 无 | 无 | ProcessManager、Snapshot、CommandTool、ContractSystem |
| LLMProvider | L1 | 按需（每 provider 一个 instance）| 无 | 无 | 无 | LLMOrchestrator |
| Transport | L1 | 按需 | 连接表加接收缓冲（派生态，重启从 socket 握手重建）| 无 | 定义不可预期失败通道协议，caller 自治处理 | Gateway |
| FileWatcher | L1 | 按需 | 订阅集合（运行期，重启重建）| 无 | 无 | 所有需要订阅文件变化的模块 |
| AuditLog | L2a | 按需 | audit 持久化（含 active 加 archive） | FileSystem | 无 | 所有需要审计的模块 |
| Snapshot | L2a | 按需 | 目标目录内的版本化历史状态 | ProcessExec、FileSystem、AuditLog | gitignore patterns 通过参数注入（Assembly 装配期 own 与组装）| Runtime、Daemon、CLI |
| ProcessManager | L2a | 按需 | 进程注册表 | ProcessExec、FileSystem、AuditLog | 无 | Daemon、Watchdog、CLI |
| DialogStore | L2b | 按需 | LLM call snapshot 持久化（每 turn 完整 `{systemPrompt, messages, toolsForLLM}` 3 件 atomic write / 含 active 加 archive 加 corrupted / phase 709 reframe） | FileSystem、AuditLog | 无 | AgentExecutor + AskMotionTool（subagent reuse motion snapshot / phase 710+） |
| Stream | L2b | 按需（写侧由产生事件的 daemon 装，读侧由消费方装）| 事件流持久化（含 active 加 archive） | FileSystem、AuditLog | 无 | 所有需要发布、订阅或回放执行过程事件的模块 |
| LLMOrchestrator | L2b | 按需 | 无 | LLMProvider、AuditLog | 无 | StepExecutor |
| ToolProtocol | L2b | 按需 | 无（type-only） | 无 | 无 | Tools、所有实现 Tool 协议的业务模块 |
| Messaging | L2c | 按需 | inbox 加 outbox 持久化 | FileSystem、AuditLog | 无 | Runtime、AsyncTaskSystem、ContractSystem、MemorySystem、CLI |
| SkillSystem | L2c | 按需 | skillsDir（per-agent skills/ 目录 / 必填 / 装配期注入）内的 skill 资源加内存元信息表（运行期派生态 / 重启 loadAll 重建）| FileSystem、AuditLog | 无 | Assembly、Runtime（含内部 ContextInjector 组件）、AsyncTaskSystem、SubAgent、skill 工具、EvolutionSystem |
| Tools | L2c | 按需 | 无（注册表是运行期派生态）| ToolProtocol、AuditLog | 无 | StepExecutor、AgentExecutor、SubAgent、AsyncTaskSystem、ContractSystem、Runtime、Assembly |
| FileTool | L2c | 按需 | 无 | FileSystem、ToolProtocol | 无 | Assembly |
| CommandTool | L2c | 按需 | 无 | ProcessExec、ToolProtocol | caller 自负 shell mode 跨 OS 风险 | Assembly |
| StepExecutor | L3 | 按需 | 无 | LLMOrchestrator、Tools | 工具 handler 协议（装配方注入工具 map）、执行过程事件回调（调用方透传）| AgentExecutor |
| AgentExecutor | L3 | 按需 | 无 | StepExecutor | stepCallback hook（调用方在 callback 内决定每步副作用）、abort 回调（Daemon 注入）| Runtime、SubAgent |
| SubAgent | L3 | 按需（由调用方实例化）| 无（执行期消费调用方提供的 input 加 output channel）| FileSystem、AgentExecutor、DialogStore、AuditLog、Tools、Stream（StreamLog）| 执行过程事件回调（调用方透传）| AsyncTaskSystem、ContractSystem（验收路径）|
| AsyncTaskSystem | L4 | 按需 | 目录队列 | FileSystem、AuditLog、FileWatcher、Stream、SkillSystem、Messaging、SubAgent、ToolProtocol、LLMOrchestrator、ContractSystem | 可选父级流式输出 sink（运行期注入）| Runtime、Assembly、Cron、Daemon、ContractSystem、EvolutionSystem、MemorySystem、AsyncTaskSystem own 的 spawn/dispatch 工具（工具归属 L4 自身 / 非反向依赖 L2 Tools 框架）|
| ContractSystem | L4 | 按需 | 契约目录树（含 active、paused、archive 状态子目录加 progress 文件加并发锁）| FileSystem、AuditLog、Messaging、ProcessExec、SubAgent（verifier 子代理）、Tools（verifier 用工具）、ToolProtocol | 定义通知回调协议供装配方注入、progress 文件锁 / emit contract_completed 事件供订阅方自治触发 | Runtime、agent 工具层（done）、CLI、Assembly（装配期 inject 完成事件 callback）/ 事件订阅方：EvolutionSystem（订阅 contract_completed / 单向 / 不是 caller）|
| MemorySystem | L4 | 按需 | dream 状态持久化（per claw 加跨 claw motion-scope 两类）| LLMOrchestrator、AsyncTaskSystem、Messaging、FileSystem、AuditLog、ToolProtocol | 无 | Assembly、Cron 的 dream-trigger 任务、agent 工具层（memory_search）|
| EvolutionSystem | L4 | 按需 | 已 retro 过的 contract 索引（去重用）| FileSystem、AuditLog、AsyncTaskSystem、SkillSystem | 订阅 ContractSystem 发布的 contract_completed 事件协议（Assembly wire 订阅 / 不直接依赖 ContractSystem 业务）| Assembly（装配期 wire 订阅链）/ 事件触发源：ContractSystem（emit contract_completed 事件）|
| Runtime | L5 | 按需 | 无 | FileSystem、LLMOrchestrator、AuditLog、Snapshot、DialogStore、Messaging、Tools（Registry+Executor）、SkillSystem、ContractSystem、AsyncTaskSystem | stepCallback hook（Assembly 注入透传）+ parentStreamLog 可选 sink + contractNotifyCallback 可选回调 | Daemon |
| Cron | L5 | 按需 | 无 | AuditLog（cron 触发加 handler 异常事件审计）；其他业务依赖由 caller 注入 jobs handler 自持 | 定义任务注入协议，由装配方聚合任务清单后提供 | Assembly |
| Gateway | L5 | 按需 | 派生运行时状态：连接表、pending 询问、中断防抖时戳 | Transport（可选，无则进入 offline mode）、Stream（工厂注入）、AuditLog、Tools（ask_user 工具注册）| 定义中断回调协议、只读订阅 Stream、Transport 生命周期绑定、连接视图派生 | Daemon |
| StatusService | L5 | 按需（per-claw / 装进 daemon）| 无（read-only 聚合 / 0 自有资源 / 0 持久化）| ContractSystem、AsyncTaskSystem、FileSystem、ToolProtocol（实现 Tool 协议）| 无 | Assembly（装配期注册 status 工具到 Tools 框架）、CLI（综合 status 命令 dep collect / 避免重新实现聚合视图）|
| Daemon | L6 | 按需 | `<dir>/status/pid` lockfile 加 process signal handler（SIGTERM、SIGINT、uncaughtException、unhandledRejection）| Assembly、Runtime 公共 API、ProcessManager（lockfile 操作）、Snapshot（启动期 commit）、AuditLog | 无 | 进程入口（daemon-entry 脚本）|
| CLI | L6 | 命令进程（短生命周期，每次 invoke 独立）| 无 | L1-L5 各模块（每命令独立实例化所需子集），AuditLog（CLI 操作 audit）| 无 | 用户终端、智能体（exec 工具）|
| Watchdog | L6 | 独立进程（不装进 motion 或 claw daemon）| watchdog 监控状态持久化 | ProcessManager、AuditLog、FileSystem、Messaging（inbox 写入）、ContractSystem（contract 事件读取）、Stream（LLM 事件类型）、clawforum.yaml（fs 共享读取 / 不直 dep CLI module / 同层 L6→L6 仅 CLI dep Watchdog 公共 export 单向）| motion 作为 claw crash 通知中介 | CLI watchdog start/stop 命令 + CLI 综合 status 命令 dep Watchdog 公共 export（getPid / isAlive / getEntryPath） |
| Assembly | L6 | 按需 | 无 | L1-L5 各模块的 setup 函数、AuditLog（装配期事件 audit）| 无 | Daemon |

### 表 2 对其他模块的承诺

| 模块 | 层 | 对外能力 |
|---|---|---|
| FileSystem | L1 | 基本文件读写、原子写、独占创建 |
| ProcessExec | L1 | exec 短任务、detached spawn、进程停止信号、存活检查、pattern 查找。内部按 OS 分支，不暴露 shell mode（caller 自负 shell 跨 OS 风险）|
| LLMProvider | L1 | 单次调用、流式调用、abort、KV cache 标记 |
| Transport | L1 | 监听启停、定向发送、广播（best-effort）、连接生命周期回调订阅、消息接收回调订阅、不可预期失败通道订阅 |
| FileWatcher | L1 | 路径变化订阅、事件类型映射、初始扫描完成信号、原始错误 callback（caller 自己 audit）、稳定性窗口可选、句柄 close idempotent |
| AuditLog | L2a | audit 追加写（结构化事件加时间戳）、按大小切割归档（历史保留）、写失败不阻塞业务 |
| Snapshot | L2a | 幂等 init、单次 commit（无变更跳过）、连续失败累计降级告警 |
| ProcessManager | L2a | daemon spawn 编排、进程注册管理、存活监控、优雅停止、孤儿清理、排他锁 |
| DialogStore | L2b | 当前 dialog 读写、归档、冷启动 archive 恢复、损坏文件隔离、悬空 tool_use 修复 |
| Stream | L2b | 事件追加写、启动期归档、归档裁剪、历史一次性读、同进程 in-process pub/sub callback、事件 schema 解析（bytes 到 events[]）|
| LLMOrchestrator | L2b | 一次性调用、流式调用、健康探测、provider 状态查询、primary 加 fallbacks 重试、circuit breaker、abort、失败 audit |
| ToolProtocol | L2b | Tool 接口 schema、ToolResult 形状（type-only） |
| Messaging | L2c | outbox 写入、inbox 写入（同步加异步）、inbox 排空加优先级排序、已处理归档、失败归档、frontmatter meta 轻量读取 |
| SkillSystem | L2c | 技能元信息扫描加载（skillsDir 装配期注入 / 必填 / 单 dir per-agent）、单名查加列全（按 frontmatter filter）、渐进式完整内容加载、上下文摘要生成（formatForContext 给 ContextInjector + retro-scheduler + dispatch 消费）、`register(skillDir)` 增量注册（应然 / 当前 0 caller 真调用 / 实然 dispatch + retro 走 per-execution lazy load 临时 create instance 模式）|
| Tools | L2c | 工具注册、卸载、查询、按 caller_type 加注入的 permission map 过滤、工具调用（同步加 async 路由加 generic audit、timeout、abort）、并行优化（readonly 工具批量并发）|
| FileTool | L2c | read、write、search、ls 工具定义对象（实现 Tool 协议）、路径权限域配置、越界守护 |
| CommandTool | L2c | exec 工具定义对象（实现 Tool 协议）|
| StepExecutor | L3 | 单次 LLM 调用、tool_use 分组并行执行、messages 追加、max_tokens 截断修复、停止信号 |
| AgentExecutor | L3 | 完整 agent 执行循环、跨步计数加熔断、stepCallback hook、maxSteps 守卫、caller 注入熔断阈值、runReact React-style 公共入口（11 平铺回调 / wrap runAgent internal core / phase 522 ν / agent-executor module 公共 API single entry） |
| SubAgent | L3 | sub-agent 实例化加生命周期管理、独立 dialog 构造、生命周期 events 审计、总超时加 idle 超时 |
| AsyncTaskSystem | L4 | 异步任务调度（磁盘目录队列驱动，含子代理任务、异步工具任务等任务类型）、崩溃恢复、大结果持久化加已发送 marker 幂等、取消、优雅关停 |
| ContractSystem | L4 | 契约 CRUD、subtask 状态迁移、脚本验收、LLM 验收（调度 verifier 子代理 / 下行 L3 单向）、重试（system 自治，配置定义次数）、escalation 通知（达阈值后投 inbox 通知 agent，决策权归 agent）、文件锁并发保护、完结归档、验收结果 inbox 反写 |
| MemorySystem | L4 | deep dream 触发（per claw 经验提炼）、random dream 触发（跨 claw 整合，motion scope）、记忆查询能力供工具层消费 |
| EvolutionSystem | L4 | retro 触发（事件驱动）、retro prompt 构造（含 dispatch-skills 摘要经 SkillSystem.formatForContext per-execution lazy load）、派 retro 子代理通过 AsyncTaskSystem、retro subagent 写新 skill 到 `clawspace/dispatch-skills/`（dispatch 工具 execute 时 per-execution lazy load / 不经 main skillRegistry reload）|
| Runtime | L5 | 常驻事件驱动循环、dialog 生命周期协调（通过 stepCallback 调 DialogStore）、turn 级 audit、turn 中断响应、snapshot 轮级 commit、AsyncTaskSystem 生命周期协调、用户中断 |
| Cron | L5 | 调度启停、单次 tick 触发、时间表解析 |
| Gateway | L5 | 实时双向交互桥接、Stream 事件订阅推送、客户端信号路由、连接视图派生 |
| StatusService | L5 | agent 自我状态聚合（active contract progress + task queue + clawspace 概览）、status 工具实现、read-only 多源视图 |
| Daemon | L6 | 进程主入口、启动期装配加 snapshot commit、事件循环驱动、inbox 阻塞等待、信号 handler、异常退出审计、优雅关停 |
| CLI | L6 | daemon 生命周期管理（start、stop、status、init）、contract 操作（create、pause、resume、cancel、log）、chat-viewport TUI、claw、motion、watchdog 子命令 |
| Watchdog | L6 | 进程存活轮询、motion 自动重启加 backoff、claw 崩溃检测加 motion 中介通知、claw 不活跃提醒、系统 liveness 审计、start、stop 命令、状态查询原子（getPid/isAlive/getEntryPath / 由 CLI 综合 status 命令消费）|
| Assembly | L6 | 按 identity 加 config 构造 Instances 句柄集、跨模块回调注入、装配期失败结构化审计、反向拓扑关停、lockfile 冲突识别、gitignore content 组装注入 Snapshot、caller universe 加权限矩阵组装注入 Tools |

### 表 3 对智能体的承诺

只列有导出工具的模块。每个工具的完整 5 维度承诺（用途、入参、返回、副作用与跨通道、profile 准入与不变量）归 modules/*.md §10。

| 模块 | 层 | 导出工具 |
|---|---|---|
| Messaging | L2c | send（claw 视角 / 写自己 outbox / motion 异步 pull）、notify_claw（motion 视角 / 写他人 inbox / motion-only profile / D11 单向访问）|
| SkillSystem | L2c | skill（按 skill 名加载完整 SKILL.md 内容）|
| FileTool | L2c | read、write、search、ls（结构化文件操作）|
| CommandTool | L2c | exec（执行 shell 命令，OS 能力主通道）|
| AsyncTaskSystem | L4 | spawn（派生子代理执行任务）、dispatch（派生 dispatch-skills 类子代理）、ask_caller（spawn cluster 派生 / 子代理询问父 caller）|
| ContractSystem | L4 | done（标记契约已完成）|
| MemorySystem | L4 | memory_search（查询持久化记忆）|
| Gateway | L5 | ask_user（向用户提问等待回复）|
| StatusService | L5 | status（agent 自我状态聚合 introspection / 多源视图：active contract progress + task queue + clawspace 概览）|

---

## 未来演进方向

### 目录驱动化

当前工具直接调用业务模块 API。未来可能演进为"工具只写目录、业务模块轮询响应"。为保留这个可能性 / V1 实现遵守以下自律：

1. **工具调业务模块只做"下单"动作 / 不消费返回值** — spawn 立即返回 taskId / 不等任务结果；done 只做"标记"动作。工具不持有 handle / 不订阅后续事件
2. **业务模块把磁盘当权威状态 / 不在内存里缓存"真相"** — AsyncTaskSystem 的待跑任务从目录读 / ContractSystem 的活跃契约从 active 子目录读
3. **所有写操作用原子写** — 临时文件 + rename / 未来工具直接写目录时格式完全一致
4. **文件格式严格定义** — 跨模块数据结构集中定义 / 业务模块写出的文件 = 未来工具要写出的文件 / 同一份 schema 共用

### 分布式部署

当前所有模块在单机运行。未来跨主机部署时：

- CLI 命令通过 SSH 执行目标主机的 CLI / 调用点不变
- Transport 内部换成跨网络协议 / 对外接口不变
- Watchdog 的健康检查通过 CLI 远程执行 / 不直接读目标主机文件

### 跨 OS 支持

当前实现假设 POSIX（macOS / Linux）。未来支持 Windows / 其他 OS 时 / 差异由 L1 / L2 抽象层吸收 / 上层业务模块（L2+ 业务模块 + L3-L6）对 OS 平台无感知。

需改的模块（OS 抽象集中在 L1）：

- **ProcessExec（L1）**：进程 OS 能力的统一 wrapper — 所有 OS 进程操作（exec / detached spawn / 信号 / 存活检查 / 进程查找）/ 内部按 OS 分支吸收异构 — 跨 OS 主战场
- **Transport（L1）**：当前 POSIX 域套接字实现 / Windows 需命名管道实现 / 协议层切换（已是 Transport 抽象的设计目标）
- **FileSystem（L1）**：clawforum 根路径约定（Unix vs Windows）/ 路径常量需 OS 分支
- **FileWatcher（L1）**：跨平台 fs 事件库已吸收 OS 差异 / 改动量极小 / 主要测试覆盖
- **CLI / TUI（L6）**：终端行为差异 — 需测试覆盖

不需改的模块：**LLMProvider（L1 / 经 HTTP API / 0 OS 依赖）**+ 所有 L2+ 业务模块 — 通过 L1 抽象访问 OS 能力。

跟「分布式部署」同型架构原则：**L1 / L2 抽象层吸收部署 + OS 差异 / 上层业务模块对部署模式 + OS 平台无感知**。
