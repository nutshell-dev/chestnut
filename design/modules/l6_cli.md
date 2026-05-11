# CLI 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) CLI 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §30「CLI 本质：系统的标准操作接口 / L6 进程边界 ——『命令进程』」加 M#1 / M#2 / M#5 加 Design Principle「外部对系统的操作通过 CLI 唯一入口」加「事后可审计」。

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

**注**：agent-facing `status` 工具已迁 L5 StatusService own（详 [architecture.md](../architecture.md) §28）/ CLI 综合 `clawforum status` 命令仍归本模块 / 但 dep StatusService.collect 而非自实现聚合。

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) CLI 节。具体子命令细节（cliMain / 各 subcommand handler / CliArgs 形态等）的存在依据是「外部操作唯一入口」原语 — 实然采纳的细节差异加 chat-viewport TUI 实现加各子命令业务调用细节等登记 §7（待治理 phase 触发后补）。

### 不做

- **不做业务模块装配持久化**（命令运行时实例化所需子集 / 调完即结束 / 不持久化 module instances）— derive 自 M#1 + M#2
- **不做长期运行循环**（归 L6 Daemon / CLI 是命令进程 / 短生命周期）— derive 自 M#1
- **不做 agent 业务流程**（归 L4 AsyncTaskSystem 加 ContractSystem 加 EvolutionSystem 等）— derive 自 M#1 + M#5
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

**watchdog 子命令族（3 events）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_watchdog_start` | watchdog start 子命令完成 | `pid` |
| `cli_watchdog_stop` | watchdog stop 子命令完成 | — |
| `cli_watchdog_status_query` | watchdog status 子命令查询 | `pid`, `alive` |

**chat-viewport 子命令（1 event）**：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `cli_chat_session` | chat 子命令 REPL 会话起 / 止 | `clawId`, `phase=start\|end` |

> 总应然 events ≈ 16 events 跨 5 子命令族 / 实然回填见 §7。
>
> 注：agent-facing `status` 工具 audit（如 `status_tool_invoked`）已迁 L5 StatusService 命名空间 / 不在本模块 §5 列。

**保留 console 清单**（CLI 用户交互输出 / 非审计语义）：
- 各子命令 status / 错误输出 / usage 打印 — CLI 本质需直接 stdout/stderr 与用户交互 / 经 audit 间接难以满足 UX 要求

## 6. 层级声明

L6 进程边界（与 L6 Daemon / L6 Watchdog / L6 Assembly 同层 / 「外部操作唯一入口」业务语义独立可变 / **命令进程**装配归属代表模块）。caller 用户终端加智能体（exec 工具）经 commander program-style entry 消费各子命令 named export（phase414c 后 / 实然不立 cliMain 单入口）。本模块下引 L1-L5 各模块（每命令独立实例化所需子集）+ AuditLog（CLI 操作 audit）+ L6 同层 Watchdog（直 dep 公共 export）+ L6 Daemon（间接 / 经 ProcessManager 操作 daemon process）/ 不上引 L6+。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| **A.spec-1 应然 `cliMain(argv)` 单函数 + `CliSubcommandHandler` + `CliArgs` 抽象 ↔ 实然 commander program-style + 子命令 named export 分散** | spec drift / 大 | **closed**（phase414c L6 audit / interfaces/l6.md align 实然 commander 模式 + 删 3 应然幻象 type）| 历史 interfaces 写应然 `cliMain(argv): Promise<void>` 单 entry + `CliSubcommandHandler` type + `CliArgs` interface / 实然 = src/cli/index.ts 用 commander `program` API / 模块顶层执行 `program.parse(process.argv)` / 子命令分散 named exports from `src/cli/commands/*.ts` (claw / motion / contract / skill / start / stop / status / etc) / 应然 3 抽象 type 实然 0 实施 / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l6.md 修订 align 实然 commander 模式 + 删 cliMain/CliSubcommandHandler/CliArgs 应然幻象 + 加 CliError + handleCliError 实然 export |
| ~~A.spec-2 CLI 标识符类参数 traversal 硬约束~~ | ~~security spec / 高~~ | **✅ closed**（phase 537 / main `47fdb542`）| **应然（phase 537 sharpen）**：CLI 命令凡接受 claw-id / skill-name / task-id 等**标识符**类参数（非 path 类）/ 进 `path.join` 或 fs 操作前必校验 traversal：reject 含 `/` / 含 `..` / 空串 / 单 `.` / `.` 前缀。**实然漂移**：~~(B.3) `src/foundation/config/paths.ts:21` `getClawDir(name)` 无校验~~ / 影响 contract.ts + claw-create + claw-chat 等所有 caller（`name="../foo"` → traversal 逃逸 claws/ 沙箱）~~(B.4) `src/cli/commands/skill.ts:72-74` skillName + clawId 双重 traversal~~ / 不经 getClawDir 直拼 ~~(B.5) `src/cli/commands/chat-viewport.ts:410` task_started.taskId 半内部 D7 受信路径但深防御~~。**phase 537 Step B 实施**：getClawDir 内化 file-private `assertSafeClawId` helper（一次治全 claw caller / ε 决策 5/5 原则一致 / M#3 资源唯一归属归宿）+ skill.ts/chat-viewport.ts 内联同形 inline 校验（与 file-tool cross-claw branch 既有 inline 模式 align）/ 0 NEW helper file（YAGNI / β 抽 shared `assertSafeIdentifier` 推 r+1+ 实证累后升格）|
| ~~**A.r68-1 passwordQuestion `_writeToOutput` 私 API hack 失败路径 mute 残留**~~ | ~~spec drift / 小~~ | **✅ closed (phase 562 / `40bf50ed`)** | start.ts:201-216 + init.ts:54-70 byte-identical pattern 双 site / dispatch 单 site 漏 init.ts / Step 0 sweep 扩入（per `feedback_plan_by_main_implement_by_user §7`）。phase 562 落地 α：(1) start.ts + init.ts passwordQuestion 加 restore() helper + try/finally 包裹 set + 私 API undefined 时 optional chain 安全；(2) NEW `tests/cli/password-restore-reverse.test.ts` 66 行反向测试覆盖 mute lifecycle 失败路径 / β 抽 shared helper 推 r+1+ cluster 累实证后升格 / γ 公开 API 重写推 r+1+ / 2 src files +50 -19 + 1 NEW test +66 / dominant α / 28 原则 derive 5/5（M#7+M#10+M#11+D5+D7+Path #7）/ 反向 3 项 PASS |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 应然 stub / 内部 spec 待回填 | meta | 治理 phase 触发后逐条补 §A / §B |
| **B.stop-double-catch-stale-recheck stop.ts 双 catch「单层化」claim STALE 推翻** | r73 C fork phase 604 derive STALE 注 | **closed by phase 604（STALE 推翻 / 0 src 改）** | r72 F fork dispatch claim：`stop.ts:76,88,98 双 catch 结构本身保 / 内层 audit 失败仍 silent / 单层化 sharpen` / **Path #1 实测 STALE 推翻**：(1) line 76 catch ProcessListUnavailable / 其他 throw 细化分类 0 silent；(2) line 88 catch kill 失败 audit `ORPHAN_SIGTERM_FAILED` (phase 578 align) 0 silent；(3) line 98 outer catch audit `PROCESS_LIST_FAILED` 包含 line 68-97 整段 0 silent；(4)「内层 audit 失败仍 silent」phantom：phase 586 audit writer 已 try/catch 全包 → audit.write 永不抛 → 内层 audit 不会失败；(5)「单层化 sharpen」反效果：外层 catch 包整段 + 内层 catch 细化 kill 失败 vs 流程其他失败 / **单层化降粒度**违 D5 日志重建精度。**结论**：实然结构合规 / 0 改 / phase 604 design only 注 STALE 推翻 / 同 phase 543+555+591 dispatch claim Path #1 实测 STALE 推翻模板 align |
| **L6.G1 (cli)** chat-viewport TUI 在 arch 表 2 列 / interfaces 缺显式 export 或注 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：arch 表 2 CLI row 「daemon 生命周期管理 + contract 操作 + **chat-viewport TUI** + claw / motion / watchdog 子命令」/ interfaces/l6.md CLI 节 export 16 子命令函数 / chat-viewport TUI 隐含在 `chatCommand` (line 119) 内 / 未显式 export TUI 组件或注 | **业务决策性 / 用户拍板候选**：α interfaces CLI 节加注「chat-viewport TUI 实施在 chatCommand 内 / TUI 组件 src/cli/chat-viewport.tsx own / 不暴露 public API」/ β interfaces 加 TUI 组件 named export（如 `ChatViewport: ReactComponent`）/ γ 保留现状（implementation detail / chatCommand 是 caller 唯一入口）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：「外部操作唯一入口」业务语义独立 / 不与 Daemon（进程生命周期）/ Watchdog（健康监控）/ Assembly（装配根）共变
- **M#2 业务语义归属**：命令路由 / 参数解析 / 子进程交互 / 子命令分派由本模块发起
- **M#3 资源唯一归属**：无磁盘资源 / 命令进程短生命周期
- **M#4 持久化**：无（命令进程）/ 持久化归各被消费业务模块
- **M#5 依赖单向**：L6 → L1-L5 / L6 同层 Watchdog 直 dep 公共 export 单向 / 不上引 L6+
- **M#6 依赖结构稳定**：commander program-style 顶层入口（phase414c 后）/ 各子命令 named export 签名形态稳定
- **M#7 耦合界面稳定**：commander program API 模式 / 子命令 named export 分散 / Watchdog 经公共 export 消费内部封装由 module visibility 控制
- **M#8 耦合界面最小**：各子命令 own 自身参数解析 / commander 顶层 program.parse(process.argv) 单参
- **M#9 显式编译器可检**：CliError + handleCliError 类型签名 / CLI_AUDIT_EVENTS const
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
- **D6 子代理后不阻塞**：CLI 不派子代理（业务归 L4 AsyncTaskSystem）
- **D7 系统可信路径**：CLI 是外部对系统操作的唯一入口（user / motion / agent 都经 CLI）/ 受信路径
- **D8 事件驱动**：CLI 是命令进程 / 不轮询 / 每次 invoke 由用户加 motion 主动触发
- **D9 CLI 唯一对外**：核心驱动原则（CLI 是外部对系统操作的唯一入口）
- **D10 多 claw 不隔绝**：CLI 跨 claw 操作（contract create 跨 claw 派 / motion 跨 claw 通讯都经 CLI）
- **D11 motion 特殊**：motion 作为用户的代理透过 exec 执行 CLI 命令管理 clawforum

#### Philosophy（4 条）

- **P3 分多个智能体加分子任务**：CLI 是 motion / claw / user 共用入口 / 多 agent 操作共享语义
- **P4 系统为智能体服务**：提供 contract 操作加 watchdog 子命令等基础设施 / 让 agent 操作系统资源（agent-facing status 工具归 L5 StatusService）

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：CLI 应然 stub / 内部 spec 待代码 phase 落地后回填 / 不 mechanical 推断 §7.A（治理动作要 grep 实然代码佐证）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：treatments 待治理 phase 落地时单一意图 / 不附带其他 refactor / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 ContractSystem / Watchdog / Daemon caller 而不动 commander program 顶层入口 —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-27 / phase348 H9 L3 WatchdogObserver/Control port 立（CLI 经 H9 WatchdogPort 消费 Watchdog / phase337+335+340+348 port pattern 第 4 次复用里程碑）⚠ STALE 2026-05-03 推翻：port pattern 4 实例整套 design debt / 详 feedback_governance_workaround_smell / **✅ closed by phase422**（main `9e6f6e74`）
- 2026-05-01 / r60+ 应然 stub 落地（CLI 整模块 8 节模板对外承诺稳定 / interfaces/l6.md CLI 节首版 / modules/l6_cli.md 内部 spec stub）
- 2026-05-03 / phase414c interfaces/l6.md L6 audit 修订（A.spec-1 closed）：删 `cliMain(argv)` + `CliSubcommandHandler` + `CliArgs` 3 应然幻象 type / interfaces 改 commander program-style entry + 子命令 named export 分散 / 加 `CliError` + `handleCliError` 实然 export
- 2026-05-03 / phase422 WatchdogPort STALE 推翻闭环（main `9e6f6e74` / **反向 design phase** / DELETE 2 抽象层文件 watchdog-port.ts + watchdog-port-factory.ts / 4 CLI caller 直 import watchdog 5 公共 export 同层 L6→L6 / 净 -59 行 / phase348 H9 KD ✅ closed / 「治理 work-around 是 design smell」首次代码闭环 / 5 port STALE cluster 推翻 1/5 收）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l6_cli.md vs arch §30 + 表 1/2 + interfaces/l6.md CLI 节）/ 0 derive drift / 修 7+ 处 cliMain/CliSubcommandHandler/CliArgs stale references（post phase414c 应然幻象删除后 modules 同步纪律 / `feedback_design_doc_sync_after_phase_closure` 第 N+多 实证累）+ 补 phase414c/phase422 closure timeline entry / design only / 0 src 改
- 2026-05-05 / **phase 484 chat-viewport.ts 文件级 sub-file 抽出**（main `ca695171`）/ chat-viewport.ts 1296 → 995 行（净 -301）/ +5 NEW sub-file（chat-viewport-utils.ts 29 + chat-viewport-watcher.ts 61 + chat-viewport-claw-line.ts 99 + main-turn-ui.ts 150 + chat-viewport-task-events.ts 48 / 总 387 行 NEW）/ runChatViewport 1017 行单 concern 状态机闭包主体 0 改 / chat-viewport.ts re-export 保 5 tests caller（chat-viewport.test/main-turn-ui-controller.test/chat-viewport-contract.test/chat-viewport-regression.e2e/chat-viewport-subscribe.e2e）import path 0 改 / 1370 tests + 880 行 e2e PASS / 0 行为差 / 0 渲染时序差 / **「保守式模块内重构」模板首发**（vs phase 480 contract/manager 激进式 sub-module 拆 7 个 / 形成 **「模块内重构两形态分类」N=2 阈值达**）/ 决策依据：UI 交互模块（单 concern 状态机 / 闭包多 / 用户体感不可测）拆 sub-module ROI 反向 / 真合规 = 仅抽 0 闭包依赖部分（顶层 export 函数 + utility helper + 纯 type）/ 闭包主体 cohesive 保留 / 推 r+ Meta **必硬化** feedback「模块内重构两形态分类」
- 2026-05-05 / **phase 486 claw.ts 8 command 拆 sub-file**（main `1fb8bf47`）/ claw.ts 932 → 24 行（barrel only / 净 -908）/ +9 NEW sub-file（claw-shared.ts 38 + claw-create.ts 46 + claw-chat.ts 54 + claw-stop.ts 40 + claw-list.ts 162 + claw-health.ts 78 + claw-send.ts 45 + claw-outbox.ts 79 + claw-trace.ts 447 / 总 989 行 NEW）/ 8 command 真独立 / 仅 list+health 共享 3 helper（formatRelativeTime + LLM_OUTPUT_EVENTS + getLastActiveMs）→ claw-shared.ts / trace 子族 6 helper（readContractStartedAt + readContractTitle + readStreamEvents + showTraceOverview + showStepDetail + formatToolResultContent）cohesive 保 1 file（同 acceptance.ts 模式）/ claw.ts barrel re-export 8 command 保 caller 0 改（cli/index.ts:25 static 7 + cli/index.ts:203 dynamic clawTraceCommand + tests/cli/cli.test.ts:18 listCommand）/ 0 行为差 / 1370 tests PASS / 10 files +1012 -931 / **「模块内重构两形态分类」激进式形态第 2 实证**（累 phase 480 contract + phase 486 claw / N=2 阈值达 / +保守式 phase 484 chat-viewport N=1 / 5 维度决策判据完整 / 推 r+ Meta **必硬化** feedback）
- 2026-05-05 / **phase 496 config/factories.ts cross-layer location drift 物理迁**（main `5a7cfb18`）/ 物理迁 `src/foundation/config/factories.ts` (L2) → `src/cli/utils/factories.ts` (L6) / 89 行 / git mv 保 history / 19 files +26 -26 / 14 src caller cascade（12 cli/commands + 2 watchdog）+ 5 tests caller（实施期 §7 grep scope 完整性纪律自补）/ 0 行为差 / 1397 tests PASS / **触发**：用户深核问 L1-L6 跨模块边界 / Path #1 浮出 + 28 条原则核确认 4 强 violation（M#1 + M#2 + M#3 + M#5：L2 config 封装 L6 CLI 装配职责 + 显式预设 L6 语义）/ 治理代价仅 M#7 一次性 path 改 / 净 align / D9 更 align（CLI 唯一入口的内部装配归 CLI 模块）/ src/foundation/config/ 仅留 index.ts（cross-cutting 配置 / 合规 L2 host）/ **「cross-layer location drift cluster」累 9 实证完整**（phase 419+420+423+425+428+431+433+435+496）/ 推 Meta 36+ **必硬化**独立 feedback「cross-layer location drift 治理 cluster」/ **「28 条原则核审 phase 提案」纪律首发**（用户用 M#10+M#11 enforce 模块重构讨论 / 主会话提案修订 / 推累 ≥ 2 升格 feedback）/ naming drift "createProcessManagerForCLI"（watchdog 也调）推 r+1 评估 rename
- 2026-05-08 / phase 537 §A.spec-2 CLI 标识符 traversal closed（main `47fdb542` / r65 B fork / 起步 SHA `81275057` / 主会话 Step A design + user Step B+C code）/ ε 决策 5/5 原则一致：`getClawDir(name)` 内化 file-private `assertSafeClawId` 校验（M#3 资源唯一归属归宿 / 一次治理全 caller）+ skill.ts 入口 inline 校验 clawId+skillName + chat-viewport.ts task_started inline 校验 taskId（D7 受信路径深防御 / audit 留痕不静默）/ 0 NEW helper file（YAGNI / β 抽 shared `assertSafeIdentifier` 推 r+1+）/ commit 8 files +195 -4 / 与 l2_file_tool §A.9+§A.10 同 phase（cross-claw 路径校验 cluster）/ **「business decision → 原则 derive 自决」第 N 实证累**（phase 520+521+522+531+537）/ **「same-root cluster 跨 2 模块（L2+L6）单 phase 治理」候选 feedback**（推累 ≥ 2 实证升格）
- 2026-05-09 / **phase 564 silent → audit cluster A（B fork r68）**（main `57daff7b`）/ chat-viewport-task-events.ts switch event.type 加 default + audit `VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT context=task_event` / TaskEventHandlerDeps +`audit?: AuditLog` optional + chat-viewport.ts caller 装配传 audit / phase 484 sub-file 拆出时漏继承 phase 523 chat-viewport.ts default 模板 / phase 553 sub-file 再瘦拆未 align / 本 phase closure / Path #1 实证 dispatch claim 5/5 真 / silent X cluster feedback N+1 实证累 / cross-cutting 同 phase：l4_contract_system §A.duplicate-audit + l2_dialog_store §A.archive-silent 同 closed
- 2026-05-09 / **phase 578 silent → audit cluster C（B fork r69）**（main `d3466037`）/ stop.ts:73+76 双 catch silent → audit `PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED`（inner kill / pid + context=stop_all_orphan_cleanup）+ `PROCESS_LIST_FAILED`（outer cleanup pipeline / context=stop_all_cleanup_pipeline）/ stop.ts 内自构 motion-level audit（α 模板复用 / `createSystemAudit(NodeFileSystem({baseDir:motionDir}), motionDir)` 同 daemon-entry shim+random-dream+deep-dream+heartbeat+evolution-system 5 实证 / N=6 累）+ fail-soft fallback null（audit 构造失败不抛）/ **0 NEW audit const**（既有 19 const 全复用 / 治理首选模板首发 / vs phase 564 NEW 2 const 对比）/ Path #1 实证 dispatch claim 4/4 真 / **「直觉 bug → phantom」反命题 N=3 实证累**（phase 557 4/4 + 564 5/5 + 578 4/4 / 升格独立 feedback 阈值过线）/ silent X cluster feedback N+1 实证累 / cross-cutting 同 phase：l2_process_manager §A spawn.ts:111 removePid 同 closed
- 待治理 phase 触发：§7.A 内部 drift 清单逐条补 / CLI_AUDIT_EVENTS 模块自治 / 各子命令族 cli_* 事件细化

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / D11 derive）| CLI 是外部对系统操作的唯一入口（user / motion 等都经 CLI）| 应然契约一致 |
| KD（待编号）| CLI 是命令进程短生命周期 / 不持久化 module instances / 不跑长期 agent loop | 应然契约一致 |
| KD（待编号 / phase348 H9）| CLI 经 H9 WatchdogPort 消费 Watchdog / 不直 import 内部 | **✅ closed by phase422**（main `9e6f6e74`）/ port pattern 第 4 次复用是 design debt 已闭 / 真合规 = CLI 直 dep Watchdog 顺向 + module visibility 控制内部 / 4 CLI caller 直 import watchdog 5 公共 export / 详 feedback_governance_workaround_smell + project_phase422_watchdogport_stale |
| KD（待编号）| agent-facing status 工具归 L5 StatusService own（不归 CLI）/ CLI 综合 `clawforum status` 命令 dep StatusService.collect | 应然契约一致 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 待治理 phase 触发后回填）：

- **commander program 顶层入口分派**（phase414c 后）：各子命令 named export 路由正确 / 未知命令打印 usage + exit code 非零
- **daemon 生命周期子命令**：start / stop / status / init 各路径 + LockConflictError 处理
- **contract 操作子命令**：create / pause / resume / cancel / log 各路径 + ContractSystem 调用断言
- **watchdog 子命令**：CLI 直 dep Watchdog 公共 export（同层 L6→L6 / phase422 H9 WatchdogPort STALE 推翻 / 不再经 port）/ `clawforum watchdog start` → `watchdog.ts:startCommand` + `clawforum watchdog stop` → `watchdog.ts:stopCommand` 两路径 / 注：watchdog 0 own `status` 子命令 / 全系统综合状态命令 `clawforum status` 在 `src/cli/commands/status.ts` 归 CLI 模块（dep watchdog 公共 `getWatchdogPid` + `isWatchdogAlive` + `getWatchdogEntryPath`）
- **chat-viewport TUI**：REPL 入口 + 中文输入加 history 渲染
- **CLI 综合 status 命令**：dep StatusService.collect 聚合视图 / format 给用户 stdout（agent-facing status 工具测试归 modules/l5_status_service.md §8）
- **审计回链**：每个 §5 CLI_AUDIT_EVENTS 事件触发时机 + 载荷断言（待回填）
- **命令进程短生命周期**：每次 invoke 独立实例化 / 调完即结束 / 不持久化 module instances 防御测试
- **motion 透过 exec 调用**：motion CLI 命令路径与 user 一致 / 共用入口
