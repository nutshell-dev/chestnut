# Clawforum 架构

> 应然描述层。原则见 `principles.md`，跨模块代码层级接口契约见 `interfaces.md`，单模块内部 spec 与 drift 登记见 `modules/*.md`，治理实践见 `practices.md`，关键设计决策历史见 `adr/`。

## 模块层定位

每层为上一层提供它需要但不该自己 own 的能力。	任何模块持「非自己 own 方层的能力」即违反层定位。

| 层 | 功能本质 | 根本问题 |
|---|---|---|
| L1 | 原语（primitive）| 与外部世界（OS、网络、外部 SDK）的中性接口。把异构吸收成可调用 primitive。 |
| L2 通用 | 基础设施（infrastructure）| 在 L1 原语之上的通用基础服务（audit、快照、进程编排），多模块共用的能力抽到这一层。 |
| L2 LLM 语义 | LLM 协议层基础设施 | LLM 协议层概念抽象（dialog 持久化、event stream、LLM 调用容错编排、工具协议）。 |
| L2 agent 语义 | agent 业务概念基础设施 | agent 业务概念 wrapper（messaging、skill、工具机制、file 工具、command 工具）。 |
| L3 | agent 原语（agent primitive）| agent 执行的最小单元：单步 LLM 调用、agent loop、子代理。 |
| L4 | agent 基础设施（agent infrastructure）| 在 L3 agent 原语之上的可重用业务流程框架，调用 agent 完成业务流程（任务调度、契约管理、记忆、契约复盘等）。 |
| L5 | 服务（service）| 逻辑层服务抽象 — 装进主 daemon 进程内长期运行（事件驱动循环、定时调度、客户端交互桥接等）。 |
| L6 | 进程边界（process boundary）| 物理层进程实现 — 把抽象栈装成进程（主 daemon、独立监控进程、命令进程、装配根）。 |

新模块或新能力归属时先查表，找 own 方层，不写到错的层。

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
| `按需` | 任何 daemon 装配方按 use case 决定是否装 / 多少实例（绝大多数模块）|
| `独立进程` | 自成进程，架构强制（如 Watchdog 跨 daemon health monitor / 不能装入被监控对象内）|
| `命令进程` | 短生命周期命令进程（如 CLI / 不装入 daemon 是因为命令式入口 vs long-running service 的不同）|

**原则**：
- 装配决策查此维度 + 拓扑图，不凭直觉
- 模块边界与拓扑不一致 → 按原则 #11「边界和实际依赖对不上停下来讨论」启动重构

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

### 6. AuditLog

**本质**：状态迁移审计记录的追加写服务

**层归属**：L2 通用基础设施。在 L1 FileSystem 之上提供 audit 追加写能力，多模块共用，业务逻辑不重复实现。AuditLog 自己不知任何业务语义，是纯通用基础设施。

### 7. Snapshot

**本质**：目标目录的版本化快照服务

**层归属**：L2 通用基础设施。把版本化快照能力封装成可重用基础服务，多模块共用，业务逻辑不重复实现。Snapshot 自己不知任何业务语义，是纯通用基础设施。

### 8. ProcessManager

**本质**：进程生命周期编排服务

**层归属**：L2 通用基础设施。在 L1 ProcessExec 加 L1 FileSystem 之上，把进程生命周期编排封装成多模块共用的基础服务。ProcessManager 自己不知任何 agent 或 LLM 业务，是纯通用基础设施。

### 9. DialogStore

**本质**：dialog 持久化服务

**层归属**：L2 LLM 语义基础设施。在 L1 FileSystem 之上把 messages 数组持久化封装成可重用基础服务。messages 是 LLM 协议层概念，不属任何具体业务（不绑 agent 概念）。

### 10. Stream

**本质**：执行过程事件流服务

**层归属**：L2 LLM 语义基础设施。在 L1 FileSystem 之上把执行过程事件流封装成可重用基础服务。Stream 知 LLM 协议层 event types，不知 agent 业务（不绑 agent identity）。

### 11. LLMOrchestrator

**本质**：LLM 调用的协议层封装。把 LLM 协议层细节从 caller 隔离，让 caller 透明看到调用结果。

**层归属**：L2 LLM 语义基础设施。在 L1 LLMProvider 之上把 LLM 调用的协议层处理封装成可重用基础服务。LLMOrchestrator 知 LLM 调用语义，不知 agent 业务。

### 12. ToolProtocol

**本质**：LLM 工具调用协议的 schema 抽象

**层归属**：L2 LLM 语义基础设施。对接 LLM messages 中 tool_use/tool_result 协议，与 DialogStore、Stream 同层。ToolProtocol 不知 clawforum 业务，是纯 LLM 协议层抽象。

### 13. Messaging

**本质**：跨 agent 消息通信服务

**层归属**：L2 agent 语义基础设施。在 L1 FileSystem 之上把 inbox/outbox 文件目录通信封装成可重用基础服务。Messaging 知 agent 概念（claw 间通信是 agent 业务），是 agent 语义层。

### 14. SkillSystem

**本质**：技能资源加载注册表服务

**层归属**：L2 agent 语义基础设施。在 L1 FileSystem 之上把 skill 资源目录加载封装成可重用基础服务，渐进式披露（启动加载元信息，调用时加载完整内容）。SkillSystem 知 agent 概念（skills 是 agent 能力），是 agent 语义层。

### 15. Tools

**本质**：工具注册加派发机制框架

**层归属**：L2 agent 语义基础设施。在 L2 ToolProtocol 之上把 clawforum 工具机制封装成可重用基础服务。Tools 不预设具体 caller 类型 universe 也不预设权限矩阵 — caller 类型有哪些加哪个 caller 能用哪个工具由 L6 Assembly 装配期 own 加注入。

### 16. FileTool

**本质**：agent 文件工具服务

**层归属**：L2 agent 语义基础设施。把「文件 I/O 能力 expose 给 agent」封装成可重用基础服务。FileTool 知 agent 概念（agent 自由输入路径需 sandbox），是 agent 语义层。

### 17. CommandTool

**本质**：agent 命令工具服务

**层归属**：L2 agent 语义基础设施。把「命令能力 expose 给 agent」封装成可重用基础服务。CommandTool 知 agent 概念（agent 自由命令需 sandbox），是 agent 语义层。

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

### 21. TaskSystem

**本质**：基于目录队列的通用异步任务调度服务

**层归属**：L4 agent 基础设施 ——「任务调度」。

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

**层归属**：L5 服务 ——「事件驱动循环」（layer table「装进主 daemon 进程内长期运行」3 子服务之一）。

### 26. Cron

**本质**：定时调度服务

**层归属**：L5 服务 ——「定时调度」（layer table「装进主 daemon 进程内长期运行」3 子服务之一）。

### 27. Gateway

【设计中，先不实现】**本质**：外部客户端 ↔ 内部系统实时交互门面（数据面）

**层归属**：L5 服务 ——「客户端交互桥接」（layer table「装进主 daemon 进程内长期运行」3 子服务之一）。

---

## L6 进程边界

### 28. Daemon

**本质**：进程生命周期管理服务

**层归属**：L6 进程边界 ——「主 daemon」。

### 29. CLI

**本质**：系统的标准操作接口

**层归属**：L6 进程边界 ——「命令进程」。

### 30. Watchdog

**本质**：进程级健康监控服务

**层归属**：L6 进程边界 ——「独立监控进程」。

### 31. Assembly

**本质**：模块装配根

**层归属**：L6 进程边界 ——「装配根」。

---

## 全模块架构 fact 一览

每模块在系统里的作用分两种：对其他模块的承诺（API 与协议）和对智能体的承诺（agent-facing tool）。后者是 clawforum 系统的特殊维度，derive 自 Philosophy「系统为智能体服务」与 Design Principle「智能体是决策主体，系统在智能体需要决策时交付相关信息」。下列三张表分别给出模块在系统中的位置、对其他模块的承诺、对智能体的承诺。

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
| DialogStore | L2b | 按需 | messages 数组持久化（含 active 加 archive 加 corrupted） | FileSystem、AuditLog | 无 | AgentExecutor |
| Stream | L2b | 按需（写侧由产生事件的 daemon 装，读侧由消费方装）| 事件流持久化（含 active 加 archive） | FileSystem | 无 | 所有需要发布、订阅或回放执行过程事件的模块 |
| LLMOrchestrator | L2b | 按需 | 无 | LLMProvider、AuditLog | 无 | StepExecutor |
| ToolProtocol | L2b | 按需 | 无（type-only） | 无 | 无 | Tools、所有实现 Tool 协议的业务模块 |
| Messaging | L2c | 按需 | inbox 加 outbox 持久化 | FileSystem、AuditLog | 无 | Runtime、TaskSystem、ContractSystem、MemorySystem、CLI |
| SkillSystem | L2c | 按需 | skillsDir（per-agent skills/ 目录 / 必填 / 装配期注入）内的 skill 资源加内存元信息表（运行期派生态 / 重启 loadAll 重建）| FileSystem、AuditLog | 上下文摘要格式化作为耦合窄化点 | Assembly、Runtime（含内部 ContextInjector 组件）、TaskSystem、SubAgent、skill 工具、EvolutionSystem |
| Tools | L2c | 按需 | 无（注册表是运行期派生态）| ToolProtocol、AuditLog | 无 | StepExecutor、AgentExecutor、SubAgent、TaskSystem、ContractSystem、Runtime、Assembly |
| FileTool | L2c | 按需 | 无 | FileSystem、ToolProtocol | 无 | Assembly |
| CommandTool | L2c | 按需 | 无 | ProcessExec、ToolProtocol | caller 自负 shell mode 跨 OS 风险 | Assembly |
| StepExecutor | L3 | 按需 | 无 | LLMOrchestrator、Tools、abort-helpers（L3 同层）| 工具 handler 协议（装配方注入工具 map）、执行过程事件回调（调用方透传）| AgentExecutor |
| AgentExecutor | L3 | 按需 | 无 | StepExecutor | stepCallback hook（调用方在 callback 内决定每步副作用）、abort 回调（Daemon 注入）| Runtime、SubAgent |
| SubAgent | L3 | 按需（由调用方实例化）| 无（执行期消费调用方提供的 input 加 output channel）| FileSystem、AgentExecutor、DialogStore、AuditLog、Tools、Stream（StreamLog）| 执行过程事件回调（调用方透传）| TaskSystem、ContractSystem（验收路径双实例化 / B.1）|
| TaskSystem | L4 | 按需 | 目录队列 | FileSystem、AuditLog、FileWatcher、Stream、SkillSystem、Messaging、SubAgent、ToolProtocol | 可选父级流式输出 sink（运行期注入）| Runtime、Assembly、Cron、Daemon、ContractSystem、EvolutionSystem、MemorySystem、TaskSystem own 的 spawn/dispatch 工具内部调用（async tool handler / 工具 own 在 TaskSystem L4 自身 / 不是 L2 Tools framework 反向调用）|
| ContractSystem | L4 | 按需 | 契约目录树（含 active、paused、archive 状态子目录加 progress 文件加并发锁）| FileSystem、AuditLog、Messaging、ProcessExec、TaskSystem、ToolProtocol | 定义通知回调协议供装配方注入、progress.lock 文件锁 / emit `contract_completed` event 供订阅方自治触发 | Runtime、agent 工具层（done）、CLI、Assembly（装配期 inject onContractCompleted callback）/ 事件订阅方：EvolutionSystem（订阅 contract_completed / 单向 / 不是 caller）|
| MemorySystem | L4 | 按需 | dream 状态持久化（per claw 加跨 claw motion-scope 两类）| LLMOrchestrator、TaskSystem、Messaging、FileSystem、AuditLog、ToolProtocol | 无 | Assembly、Cron 的 dream-trigger 任务、agent 工具层（memory_search）|
| EvolutionSystem | L4 | 按需 | 已 retro 过的 contract 索引（去重用）| FileSystem、AuditLog、TaskSystem、ContractSystem、SkillSystem | 订阅 ContractSystem 发布的 contract_completed 事件协议 | Assembly（装配期 wire 订阅链）/ 事件触发源：ContractSystem（emit contract_completed event）|
| Runtime | L5 | 按需 | 无 | FileSystem、LLMOrchestrator、AuditLog、Snapshot、DialogStore、Messaging、Tools（Registry+Executor）、SkillSystem、ContractSystem、TaskSystem | stepCallback hook（Assembly 注入透传）+ parentStreamLog 可选 sink + contractNotifyCallback 可选回调 | Daemon |
| Cron | L5 | 按需 | 无 | AuditLog（cron 触发加 handler 异常事件审计）；其他业务依赖由 caller 注入 jobs handler 自持 | 定义任务注入协议，由装配方聚合任务清单后提供 | Assembly |
| Gateway | L5 | 按需 | 派生运行时状态：连接表、pending 询问、中断防抖时戳 | Transport（可选，无则进入 offline mode）、Stream（工厂注入）、AuditLog、Tools（ask_user 工具注册）| 定义中断回调协议、只读订阅 Stream、Transport 生命周期绑定、连接视图派生 | Daemon |
| Daemon | L6 | 按需 | `<dir>/status/pid` lockfile 加 process signal handler（SIGTERM、SIGINT、uncaughtException、unhandledRejection）| Assembly、Runtime 公共 API、ProcessManager（lockfile 操作）、Snapshot（启动期 commit）、AuditLog | 无 | 进程入口（daemon-entry 脚本）|
| CLI | L6 | 命令进程（短生命周期，每次 invoke 独立）| 无 | L1-L5 各模块（每命令独立实例化所需子集），AuditLog（CLI 操作 audit）| 无 | 用户终端、智能体（exec 工具）|
| Watchdog | L6 | 独立进程（不装进 motion 或 claw daemon）| watchdog 监控状态持久化 | ProcessManager、AuditLog、FileSystem、Messaging（InboxWriter）、ContractSystem（utils / collectContractEvents）、Stream（LLM_OUTPUT_EVENTS Set）、CLI config | motion 作为 claw crash 通知中介 | CLI watchdog start/stop/status 命令 |
| Assembly | L6 | 按需 | 无 | L1-L5 各模块的 setup 函数、AuditLog（装配期事件 audit）| 无 | Daemon |

### 表 2 对其他模块的承诺

| 模块 | 层 | 对外能力 |
|---|---|---|
| FileSystem | L1 | 基本文件读写、原子写、独占创建 |
| ProcessExec | L1 | exec 短任务、detached spawn、进程停止信号、存活检查、pattern 查找。内部按 OS 分支，不暴露 shell mode（caller 自负 shell 跨 OS 风险）|
| LLMProvider | L1 | 单次调用、流式调用、健康探测、abort、KV cache 标记 |
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
| SkillSystem | L2c | 技能元信息扫描加载（skillsDir 装配期注入 / 必填 / 单 dir per-agent）、单名查加列全（按 frontmatter filter）、渐进式完整内容加载、reload 触发 rescan、上下文摘要生成 |
| Tools | L2c | 工具注册、卸载、查询、按 caller_type 加注入的 permission map 过滤、工具调用（同步加 async 路由加 generic audit、timeout、abort）、并行优化（readonly 工具批量并发）|
| FileTool | L2c | read、write、search、ls 工具定义对象（实现 Tool 协议）、路径权限域配置、越界守护 |
| CommandTool | L2c | exec 工具定义对象（实现 Tool 协议）|
| StepExecutor | L3 | 单次 LLM 调用、tool_use 分组并行执行、messages in-place 追加、max_tokens 截断修复、停止信号 |
| AgentExecutor | L3 | 完整 agent 执行循环、跨步计数加熔断、stepCallback hook、maxSteps 守卫、caller 注入熔断阈值（phase409） |
| SubAgent | L3 | sub-agent 实例化加生命周期管理、独立 dialog 构造、生命周期 events 审计、总超时加 idle 超时 |
| TaskSystem | L4 | 异步任务调度（磁盘目录队列驱动，含子代理任务、异步工具任务等任务类型）、崩溃恢复、大结果持久化加已发送 marker 幂等、取消、优雅关停 |
| ContractSystem | L4 | 契约 CRUD、subtask 状态迁移、脚本验收、LLM 验收（直 dep TaskSystem 调度 verifier 子代理 / 同层单向）、重试（system 自治，配置定义次数）、escalation 通知（达阈值后投 inbox 通知 agent，决策权归 agent）、文件锁并发保护、完结归档、验收结果 inbox 反写 |
| MemorySystem | L4 | deep dream 触发（per claw 经验提炼）、random dream 触发（跨 claw 整合，motion scope）、记忆查询能力供工具层消费 |
| EvolutionSystem | L4 | retro 触发（事件驱动）、retro prompt 构造、派 retro 子代理透过 TaskSystem、retro 完成后调 SkillSystem.reload |
| Runtime | L5 | 常驻事件驱动循环、dialog 生命周期协调（透 stepCallback 调 DialogStore）、turn 级 audit、turn 中断响应、snapshot 轮级 commit、TaskSystem 生命周期协调、用户中断 |
| Cron | L5 | 调度启停、单次 tick 触发、时间表解析 |
| Gateway | L5 | 实时双向交互桥接、Stream 事件订阅推送、客户端信号路由、连接视图派生 |
| Daemon | L6 | 进程主入口、启动期装配加 snapshot commit、事件循环驱动、inbox 阻塞等待、信号 handler、异常退出审计、优雅关停 |
| CLI | L6 | daemon 生命周期管理（start、stop、status、init）、contract 操作（create、pause、resume、cancel、log）、chat-viewport TUI、claw、motion、watchdog 子命令 |
| Watchdog | L6 | 进程存活轮询、motion 自动重启加 backoff、claw 崩溃检测加 motion 中介通知、claw 不活跃提醒、系统 liveness 审计、start、stop、status 命令 |
| Assembly | L6 | 按 identity 加 config 构造 Instances 句柄集、跨模块回调注入、装配期失败结构化审计、反向拓扑关停、lockfile 冲突识别、gitignore content 组装注入 Snapshot、caller universe 加权限矩阵组装注入 Tools |

### 表 3 对智能体的承诺

只列有导出工具的模块。每个工具的完整 5 维度承诺（用途、入参、返回、副作用与跨通道、profile 准入与不变量）归 modules/*.md §10。

| 模块 | 层 | 导出工具 |
|---|---|---|
| Messaging | L2c | send（claw 视角 / 写自己 outbox / motion 异步 pull）、notify_claw（motion 视角 / 写他人 inbox / motion-only profile / D11 单向访问 / **应然 silent 待实施** — 详 l2_messaging §A.7）|
| SkillSystem | L2c | skill（按 skill 名加载完整 SKILL.md 内容）|
| FileTool | L2c | read、write、search、ls（结构化文件操作）|
| CommandTool | L2c | exec（执行 shell 命令，OS 能力主通道）|
| TaskSystem | L4 | spawn（派生子代理执行任务）、dispatch（派生 dispatch-skills 类子代理）|
| ContractSystem | L4 | done（标记契约已完成）|
| MemorySystem | L4 | memory_search（查询持久化记忆）|
| Gateway | L5 | ask_user（向用户提问等待回复）|
| CLI | L6 | status（查询 daemon 状态，进程内调用 CLI 命令处理函数，不 spawn 子进程）|

---

## 未来演进方向

### 目录驱动化

当前工具直接调用业务模块 API。未来可能演进为"工具只写目录、业务模块轮询响应"。为保留这个可能性 / V1 实现遵守以下自律：

1. **工具调业务模块只做"下单"动作 / 不消费返回值** — spawn 立即返回 taskId / 不等任务结果；done 只做"标记"动作。工具不持有 handle / 不订阅后续事件
2. **业务模块把磁盘当权威状态 / 不在内存里缓存"真相"** — TaskRunner 的待跑任务从目录读 / ContractSystem 的活跃契约从 contract/active/ 读
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

- **ProcessExec（L1）**：进程 OS 能力的统一 wrapper — exec / detached spawn / kill / 存活检查 / 进程查找等所有 OS 进程操作 / 内部按 OS 分支（POSIX child_process + signals + pgrep / Windows TerminateProcess + tasklist 等）— 跨 OS 主战场
- **Transport（L1）**：当前 `UnixDomainSocketTransport` 绑死 POSIX / Windows 需 Named Pipe 实现 / 协议层切换（已是 Transport 抽象的设计目标 / 实现层补 NamedPipeTransport）
- **FileSystem（L1）**：clawforum 根路径约定（`~/.clawforum` Unix vs `%APPDATA%\clawforum` Windows）/ 路径常量需 OS 分支
- **FileWatcher（L1）**：chokidar 已 wrap 多平台差异（inotify / FSEvents / ReadDirectoryChangesW）/ 改动量极小 / 主要测试覆盖
- **CLI / TUI（L6）**：终端 ANSI / TTY 行为 / Windows cmd / PowerShell 表现差异 — 需测试覆盖

不需改的模块：**LLMProvider（L1 / LLM SDK 经 HTTP API / 跨平台 npm package / 0 OS 依赖）**+ 所有 L2+ 业务模块（ProcessManager、Stream、DialogStore、AuditLog、Messaging、Snapshot、SkillSystem、Tools、ToolProtocol、LLMOrchestrator、FileTool、CommandTool、TaskSystem、ContractSystem、MemorySystem、Cron、SubAgent、StepExecutor、AgentExecutor、Gateway、Runtime、Daemon、Watchdog、Assembly、EvolutionSystem）— 通过 L1 抽象访问 OS 能力，不直接 import OS-specific stdlib。注意：ProcessManager 应然不直接 import `child_process`，通过 ProcessExec 调。

跟「分布式部署」同型架构原则：**L1 / L2 抽象层吸收部署 + OS 差异 / 上层业务模块对部署模式 + OS 平台无感知**。
