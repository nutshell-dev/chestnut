# CLI 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) CLI 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §29「CLI 本质：系统的标准操作接口 / L6 进程边界 ——『命令进程』」加 M#1 / M#2 / M#5 加 Design Principle「外部对系统的操作通过 CLI 唯一入口」加「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），CLI 的单一职责 = **外部操作的唯一入口**：

按子命令族：

**daemon 生命周期管理**：
- `clawforum start` / `stop` / `status` / `init`
- 经 ProcessManager 加 lockfile 操作 daemon 进程

**contract 操作**：
- `clawforum contract create` / `pause` / `resume` / `cancel` / `log`
- 经 L4 ContractSystem 调对外 API

**子进程子命令**：
- `clawforum claw <subcommand>` / `motion <subcommand>` / `watchdog <subcommand>`
- watchdog 子命令直 dep Watchdog 公共 export（同层 L6→L6 单向 / 内部细节由 module visibility 控制）

**chat-viewport TUI**：
- `clawforum chat <clawId>` REPL 入口
- pi-tui Input 加 chat history 渲染

**进程内 status 工具**（agent-facing）：
- `status` 工具是进程内调用 CLI 命令处理函数（不 spawn 子进程 / 详 [architecture.md](../architecture.md) 表 3）

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) CLI 节。具体子命令细节（cliMain / 各 subcommand handler / CliArgs 形态等）的存在依据是「外部操作唯一入口」原语 — 实然采纳的细节差异加 chat-viewport TUI 实现加各子命令业务调用细节等登记 §7（待治理 phase 触发后补）。

### 不做

- **不做业务模块装配持久化**（命令运行时实例化所需子集 / 调完即结束 / 不持久化 module instances）— derive 自 M#1 + M#2
- **不做长期运行循环**（归 L6 Daemon / CLI 是命令进程 / 短生命周期）— derive 自 M#1
- **不做 agent 业务流程**（归 L4 TaskSystem 加 ContractSystem 加 EvolutionSystem 等）— derive 自 M#1 + M#5
- **不做 daemon 进程内 state 管理**（CLI 通过 ProcessManager 加 lockfile 等接口操作 daemon process / 不 own daemon process state）— derive 自 M#3
- **不做 agent 业务循环**（CLI 不跑 agent loop / 仅命令操作）— derive 自 M#1
- **不做进程间通信协议**（归 L1 Transport / CLI 经 Transport 抽象访问 daemon）— derive 自 M#5
- **不直 import watchdog 内部实现细节**（CLI 直 dep Watchdog 公共 export / 内部细节由 module visibility 控制）— derive 自 M#7 + M#8

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），CLI 的业务语义边界：

- **own**：「外部操作唯一入口」业务语义唯一发起点 — 命令路由 / 参数解析 / 子进程交互 / 子命令分派。这些是 CLI 唯一懂的「业务」（命令进程级）。
- **角色定位**：CLI 是「**命令进程 + 外部操作唯一入口**」非「**装配方**」非「**长期运行 service**」非「**业务模块**」。每次 invoke 独立实例化所需 L1-L5 模块子集 / 调完即结束 / 不持久化 module instances。
- **业务语义动词集**：
  - 「命令分派」：`cliMain(argv)` → 按 subcommand 路由
  - 「子命令处理」：各 `CliSubcommandHandler` 实现 / 返 exit code
- **装配「命令进程」**（短生命周期 / 每次 invoke 独立实例化所需子集 / 详 [architecture.md](../architecture.md) §装配归属维度）
- **motion 作为用户代理**（透过 exec 执行 CLI 命令管理 clawforum / 不绕过 CLI 直接调内部模块）
- **CLI 是外部操作唯一入口**（user / motion 等都经 CLI / Design Principle D11）

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），CLI 独占的资源：

**M#3 资源（持久化 / 独占）**：无（与 arch 表 1 「资源 = 无」一致）。

**派生态（运行时态 / 命令进程短生命周期 / 不计 M#3）**：

| 派生态 | 类别 | 生命周期 |
|---|---|---|
| 命令路由表 | 派生态 | 每次 cliMain invoke 重建 |
| 各子命令处理器函数引用 | 派生态 | invoke 期 |
| 命令进程内 L1-L5 模块子集实例 | 派生态 | 调完即销毁 |

**无磁盘资源** — CLI 是命令进程 / 持久化归各被消费业务模块（fs / audit / contract / 等各归其主）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），CLI 自身的持久化立场：

- **模块零状态**：CLI 不持自有磁盘 artifact — 命令进程短生命周期 / 调完即结束 / 不持久化 module instances。
- **持久化归下游**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| daemon 进程 state | Daemon（L6）| `<dir>/status/pid` lockfile |
| audit 事件（cli_invoke / cli_failed 等）| AuditWriter（L2）| `audit.tsv` |
| contract 状态 | ContractSystem（L4）| 契约目录树 |
| watchdog 状态 | Watchdog（L6）| `watchdog-state.json` 等 |
| chat history | DialogStore（L2 / 经 daemon 内）| `current.json` 等 |

**重建语义**：每次 cliMain invoke 经各模块 createX 工厂重建实例 / 内部状态从磁盘加载（归各模块）/ CLI 本身重启归零（命令进程短生命周期）。

## 5. 审计事件清单

> 事件常量集中定义于 `src/cli/audit-events.ts` `CLI_AUDIT_EVENTS`（模块自治）。

**应然清单**（13 events 按子命令族分组）：

**顶层 framework（3 events）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_invoke` | cliMain 入口（任何子命令）| `command`, `argv` |
| `cli_failed` | 子命令失败（任何）| `command`, `reason`, `exit_code` |
| `cli_lock_conflict` | start 命令遇 `LockConflictError` | `clawId` |

**daemon 子命令族（4 events）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_daemon_start` | start 子命令完成（daemon spawn 成功）| `clawId`, `pid` |
| `cli_daemon_stop` | stop 子命令完成（daemon SIGTERM 后退出）| `clawId`, `pid` |
| `cli_daemon_status_query` | status 子命令查询 | `clawId`, `alive` |
| `cli_daemon_init` | init 子命令完成（dir 加 config 加 lockfile 初始化）| `clawId`, `dir` |

**contract 子命令族（5 events）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_contract_create` | contract create 子命令完成 | `contractId`, `clawId` |
| `cli_contract_pause` | contract pause 子命令完成 | `contractId` |
| `cli_contract_resume` | contract resume 子命令完成 | `contractId` |
| `cli_contract_cancel` | contract cancel 子命令完成 | `contractId`, `reason` |
| `cli_contract_log_query` | contract log 子命令查询 | `contractId` |

**watchdog 子命令族（3 events / 经 H9 WatchdogPort）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_watchdog_start` | watchdog start 子命令完成 | `pid` |
| `cli_watchdog_stop` | watchdog stop 子命令完成 | — |
| `cli_watchdog_status_query` | watchdog status 子命令查询 | `pid`, `alive` |

**chat-viewport 子命令（1 event）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_chat_session` | chat 子命令 REPL 会话起 / 止 | `clawId`, `phase=start\|end` |

**进程内 status 工具（agent-facing）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_status_tool_invoked` | agent exec status 工具（进程内调用 / 不 spawn）| `clawId` |

> 总应然 events ≈ 17 events 跨 6 子命令族 / 实然回填见 §7。

**保留 console 清单**（CLI 用户交互输出 / 非审计语义）：
- 各子命令 status / 错误输出 / usage 打印 — CLI 本质需直接 stdout/stderr 与用户交互 / 经 audit 间接难以满足 UX 要求

## 6. 层级声明

L6 进程边界（与 L6 Daemon / L6 Watchdog / L6 Assembly 同层 / 「外部操作唯一入口」业务语义独立可变 / **命令进程**装配归属代表模块）。下游用户终端加智能体（exec 工具）唯一消费 cliMain。本模块下引 L1-L5 各模块（每命令独立实例化所需子集）+ AuditLog（CLI 操作 audit）+ L6 同层 Watchdog（直 dep 公共 export）+ L6 Daemon（间接 / 经 ProcessManager 操作 daemon process）/ 不上引 L6+。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| **A.spec-1 应然 `cliMain(argv)` 单函数 + `CliSubcommandHandler` + `CliArgs` 抽象 ↔ 实然 commander program-style + 子命令 named export 分散** | spec drift / 大 | **closed**（phase414c L6 audit / interfaces/l6.md align 实然 commander 模式 + 删 3 应然幻象 type）| 历史 interfaces 写应然 `cliMain(argv): Promise<void>` 单 entry + `CliSubcommandHandler` type + `CliArgs` interface / 实然 = src/cli/index.ts 用 commander `program` API / 模块顶层执行 `program.parse(process.argv)` / 子命令分散 named exports from `src/cli/commands/*.ts` (claw / motion / contract / skill / start / stop / status / etc) / 应然 3 抽象 type 实然 0 实施 / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l6.md 修订 align 实然 commander 模式 + 删 cliMain/CliSubcommandHandler/CliArgs 应然幻象 + 加 CliError + handleCliError 实然 export |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 应然 stub / 内部 spec 待回填 | meta | 治理 phase 触发后逐条补 §A / §B |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：「外部操作唯一入口」业务语义独立 / 不与 Daemon（进程生命周期）/ Watchdog（健康监控）/ Assembly（装配根）共变
- **M#2 业务语义归属**：命令路由 / 参数解析 / 子进程交互 / 子命令分派由本模块发起
- **M#3 资源唯一归属**：无磁盘资源 / 命令进程短生命周期
- **M#4 持久化**：无（命令进程）/ 持久化归各被消费业务模块
- **M#5 依赖单向**：L6 → L1-L5 / L6 同层 Watchdog 直 dep 公共 export 单向 / 不上引 L6+
- **M#6 依赖结构稳定**：cliMain 单入口 / 各子命令处理器签名形态稳定
- **M#7 耦合界面稳定**：cliMain + CliSubcommandHandler 形态 / Watchdog 经公共 export 消费内部封装由 module visibility 控制
- **M#8 耦合界面最小**：cliMain(argv) 单参最小 / 各子命令 own 自身参数解析
- **M#9 显式编译器可检**：CliArgs 加 CliSubcommandHandler 类型签名 / CLI_AUDIT_EVENTS const
- **M#10 不合理停下**：应然 stub 显式登记 / 治理 phase 触发后逐条补
- **M#11 边界对不上停下**：CLI 不直 import watchdog 内部实现 / 经公共 export 消费

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：CLI_AUDIT_EVENTS 应然全覆盖（待回填）
- **D1b 状态可观察**：cli_invoke / cli_failed audit 加 console 双轨
- **D1c 中断可恢复**：CLI 是命令进程 / 短生命周期 / 中断重新 invoke 即重建
- **D1d 事后可审计**：CLI_AUDIT_EVENTS 应然全覆盖（待回填）
- **D2 不丢弃 / 静默**：子命令失败 audit + exit code 双轨 / 不静默
- **D3 用户可观察**：console stdout/stderr 直输出 + audit 留痕
- **D4 中断恢复**：命令进程短生命周期 / 中断后下次 invoke 重建 instances
- **D5 日志重建**：cli_invoke + cli_failed audit 加 daemon 各 audit 协同重建外部操作轨迹
- **D6 子代理后不阻塞**：CLI 不派子代理（业务归 L4 TaskSystem）
- **D7 系统可信路径**：CLI 是外部对系统操作的唯一入口（user / motion / agent 都经 CLI）/ 受信路径
- **D8 事件驱动**：CLI 是命令进程 / 不轮询 / 每次 invoke 由用户加 motion 主动触发
- **D9 CLI 唯一对外**：核心驱动原则（CLI 是外部对系统操作的唯一入口）
- **D10 多 claw 不隔绝**：CLI 跨 claw 操作（contract create 跨 claw 派 / motion 跨 claw 通讯都经 CLI）
- **D11 motion 特殊**：motion 作为用户的代理透过 exec 执行 CLI 命令管理 clawforum

#### Philosophy（4 条）

- **P3 多 agent 利用**：CLI 是 motion / claw / user 共用入口 / 多 agent 操作共享语义
- **P4 系统为智能体服务**：提供 status 工具加 contract 操作加 watchdog 子命令等基础设施 / 让 agent 操作系统资源

#### Path Principles（核心条）

- **Path #1 实然为唯一基准**：CLI 应然 stub / 内部 spec 待代码 phase 落地后回填 / 不 mechanical 推断 §7.A
- **Path #3 语义最小变更**：treatments 待治理 phase 落地时单一意图 / 不附带其他 refactor
- **反向测试**：本模块可独立替换 ContractSystem / Watchdog / Daemon caller 而不动 cliMain —— M#1 ✓

### 7.D 历史纪律

- 2026-04-27 / phase348 H9 L3 WatchdogObserver/Control port 立（CLI 经 H9 WatchdogPort 消费 Watchdog / phase337+335+340+348 port pattern 第 4 次复用里程碑）⚠ STALE 2026-05-03 推翻：port pattern 4 实例整套 design debt / 详 feedback_governance_workaround_smell
- 2026-05-01 / r60+ 应然 stub 落地（CLI 整模块 8 节模板对外承诺稳定 / interfaces/l6.md CLI 节首版 / modules/l6_cli.md 内部 spec stub）
- 待治理 phase 触发：§7.A 内部 drift 清单逐条补 / CLI_AUDIT_EVENTS 模块自治 / 各子命令族 cli_* 事件细化

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / D11 derive）| CLI 是外部对系统操作的唯一入口（user / motion 等都经 CLI）| 应然契约一致 |
| KD（待编号）| CLI 是命令进程短生命周期 / 不持久化 module instances / 不跑长期 agent loop | 应然契约一致 |
| KD（待编号 / phase348 H9）| CLI 经 H9 WatchdogPort 消费 Watchdog / 不直 import 内部 | ⚠ STALE 2026-05-03 推翻 / port pattern 第 4 次复用是 design debt / 真合规 = CLI 直 dep Watchdog 顺向 + module visibility 控制内部 / 详 feedback_governance_workaround_smell |
| KD（待编号）| status 工具是进程内调用 CLI 命令处理函数 / 不 spawn 子进程 | 应然契约一致 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 待治理 phase 触发后回填）：

- **cliMain 入口分派**：各子命令路由正确 / 未知命令打印 usage + exit code 非零
- **daemon 生命周期子命令**：start / stop / status / init 各路径 + LockConflictError 处理
- **contract 操作子命令**：create / pause / resume / cancel / log 各路径 + ContractSystem 调用断言
- **watchdog 子命令**：经 H9 WatchdogPort 消费 / startCommand / stopCommand / statusCommand 路径
- **chat-viewport TUI**：REPL 入口 + 中文输入加 history 渲染
- **进程内 status 工具**：进程内调用 CLI 命令处理函数 / 不 spawn 子进程
- **审计回链**：每个 §5 CLI_AUDIT_EVENTS 事件触发时机 + 载荷断言（待回填）
- **命令进程短生命周期**：每次 invoke 独立实例化 / 调完即结束 / 不持久化 module instances 防御测试
- **motion 透过 exec 调用**：motion CLI 命令路径与 user 一致 / 共用入口
