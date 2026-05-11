# Assembly 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) Assembly 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §31「Assembly 本质：模块装配根 / L6 进程边界 ——『装配根』」加 M#1 / M#2 / M#3 加 M#5「底层模块不预设上层模块语义」加 Design Principle「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Assembly 的单一职责 = **模块装配根**：

按装配三段：

**构造期**：
- 按 identity（motion / claw）union type 分支决定启哪些模块（cronRunner / heartbeat 仅 motion 装）
- L1-L2 预制：`systemFs`（enforcePermissions=false）+ `clawFs`（enforcePermissions=true）/ 两者 baseDir=clawDir
- 调各 L1-L5 模块 createX 工厂构造 instances
- 跨模块回调注入（caller 类型 universe → Tools / gitignore content → Snapshot / Skill multi-source dirs → SkillSystem / 执行过程事件回调 / interrupt / Cron handler / TransportErrorEvent fan-out / LLM 业务事件审计等）
- Snapshot 单实例约束（保证唯一 Snapshot 对象 / 同时出现在 Instances.snapshot + RuntimeDependencies.snapshot）

**装后期**：
- 经 RuntimeDependencies 字段一次性注入 Runtime（parentStreamLog + contractNotifyCallback 经字段注入而非 setter 双阶段）
- `acquireLock` 拿 lockfile / 冲突时 audit `assemble_lock_conflict` + 抛 `LockConflictError`
- audit `daemon_started`（clawId + pid）

**关停期**：
- `disassemble(instances, signal)` 反向拓扑调各模块 close/stop
- 任一步抛错 audit `disassemble_step_failed` + 继续下一步（全序继续）
- 末尾 audit `daemon_stop`（signal）/ AuditWriter 不在 disassemble 内 close（TSV 追加写无 close 义务 / 保证 daemon_stop 写入磁盘）

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) Assembly 节。具体实现细节（assemble / disassemble / Identity union / AssembleConfig / Instances 接口 / LockConflictError 等）的存在依据是「模块装配根」原语 — 实然采纳的细节差异加跨模块回调注入清单加构造顺序拓扑等登记 §7.B。

### 不做

- **不做模块内部初始化**（init() / loadAll() / archive() 等归各模块自身业务语义 / 由 createX 工厂内部完成）— derive 自 M#1 + M#2
- **不做 Runtime 业务动作**（session repair / resumeContractIfPaused 由 Daemon 调 / Assembly 仅装配 / 不参与 runtime）— derive 自 M#1
- **不做错误回滚**（构造途中失败抛错 / 由 Daemon catch + process.exit / OS 回收资源 / 不调 disassemble 回滚）— derive 自 M#1 + M#10
- **不做长期运行 service**（Assembly 是 init-time function / assemble 加 disassemble 调完即结束 / 不持续运行）— derive 自 M#1
- **不做 agent 业务流程**（归 L3-L5 各模块）— derive 自 M#1 + M#5
- **不允许 Instances 字段重新赋值**（readonly + tsc 编译期保证 / Daemon 仅读字段或调字段对象方法）— derive 自 M#7
- **不 own LockConflictError 失败语义本质**（归 L2 ProcessManager / B.4 边界违规登记 / 长期治理 / 当前 Assembly 沿用 PM 抛通用 Error 现状加 re-throw）— derive 自 M#3

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Assembly 的业务语义边界：

- **own**：「装配 + 拆装」业务语义唯一发起点 — identity 分支 / 跨模块回调注入 / Instances 句柄集构造 / 反向拓扑关停 / Snapshot 单实例约束 / lockfile 冲突识别 / gitignore content 加 caller universe 加权限矩阵组装注入。这些是 Assembly 唯一懂的「业务」（装配根级）。
- **角色定位**：Assembly 是「**装配胶水 + 跨模块回调注入终点**」非「**长期运行 service**」非「**业务模块**」。Assembly 装好 instances + 注入跨模块回调 + 经 RuntimeDependencies 一次性透传 / Daemon 拿 Instances 后驱动 Runtime / 关停时按依赖拓扑反向调各模块 close/stop。
- **业务语义动词集**：
  - 「装配」：`assemble(config)` → `Instances`
  - 「拆装」：`disassemble(instances, signal)` → 反向拓扑关停
- **装配「按需」**（任何 daemon 进程入口需要装配模块图时调用）
- **Snapshot 单实例约束**：唯一 `Snapshot` 对象 / 同时出现在 `Instances.snapshot` + `RuntimeDependencies.snapshot` / 双实例 = `recovery-snapshot` audit 重复 bug
- **identity 分支**：cronRunner / heartbeat 仅 motion 装 / claw 不装 / Instances 字段 readonly + tsc 编译期保证

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Assembly 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无（Assembly 本身无状态 / 不持磁盘或进程级资源）| 派生态 | ✗ |
| `assemble()` / `disassemble()` 调用期局部引用 | 派生态 / 调用期短生命周期 | ✗ |

**无磁盘资源** — Assembly 是装配胶水 / 持久化归各被装配模块（fs / audit / snapshot / session 等各归其主）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Assembly 自身的持久化立场：

- **模块零状态**：Assembly 不持自有磁盘 artifact — 装配胶水 / 持久化归各被装配模块（fs / audit / snapshot / session 等各归其主）
- **持久化归下游**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| audit 事件 | AuditWriter（L2）| `audit.tsv` |
| snapshot | Snapshot（L2）| git repo |
| dialog | DialogStore（L2）| `current.json` / archive |
| inbox / outbox | Messaging（L2）| 各 claw inbox/outbox 目录 |
| lockfile | ProcessManager（L2 / 经 acquireLock）| `<dir>/status/pid` |

**重建语义**：进程重启 → Daemon 调 assemble → 各模块按 identity 分支重建实例 / 内部状态从磁盘加载（归各模块）/ Assembly 本身重启归零（运行期派生态 / 调用期短生命周期）。

## 5. 审计事件清单

> 事件常量集中定义于 `src/assembly/audit-events.ts` `ASSEMBLY_AUDIT_EVENTS`（模块自治 / caller const 引用）+ `src/assembly/llm-audit-events.ts` `LLM_AUDIT_EVENTS`（与 caller llm-audit-sink.ts 同目录）。

ASSEMBLY_AUDIT_EVENTS 6 个事件：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `daemon_started` | assemble() 末尾 | `clawId`, `pid` |
| `daemon_stop` | disassemble() 末尾 | `signal` |
| `daemon_unclean_exit` | assemble() 进入时 detectUncleanExit | `last_ts` |
| `assemble_failed` | assemble() 任一构造步骤失败 | `module`, `phase`, `reason` |
| `assemble_lock_conflict` | `processManager.acquireLock` 失败 | `clawId` |
| `disassemble_step_failed` | disassemble() 任一步抛错 | `step`, `reason` |

外加 LLM_AUDIT_EVENTS（模块自治 / 11 个事件）：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `llm_provider_attempt_failed` / `llm_retry_scheduled` / `llm_provider_exhausted` / `llm_fallback_switched` / `llm_breaker_opened` / `llm_breaker_half_open` / `llm_breaker_closed` / `llm_healthcheck_failed` / `llm_stream_reset` / `llm_stream_parse_error` / `llm_idle_failover_triggered` | `src/assembly/llm-audit-sink.ts` 经 LLMEventSink 注入 sink fan-out | LLMOrchestrator 契约 §5 透传 |

> 11 个 LLM_AUDIT_EVENTS 由 Assembly 装配 LLMEventSink 后 fan-out 写 / 物理位置 `src/assembly/llm-audit-events.ts` 与 caller llm-audit-sink.ts 同目录。

**关键约束**：audit 是观察通道 / 不是失败处理通道。assemble 不可预期失败必须抛给 Daemon 决策（process.exit）；disassemble 失败不抛（关停过程已无消费者可决策）/ AuditWriter 不在 disassemble 内 close（TSV 追加写无 close 义务 / 保证 daemon_stop 写入磁盘）。

## 6. 层级声明

L6 进程边界（与 L6 Daemon / L6 Watchdog / L6 CLI 同层 / 「装配模块图」业务语义独立可变 / 装配根角色 / 在所有 L1-L5 之上）。下游 Daemon（L6）通过 `assemble` / `disassemble` 函数式调用。上游 L1-L5 各模块的 createX 工厂 / 不上引 L6+。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A 6/6 全清零里程碑**（phase154-158 接力）：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 Assembly 模块不存在~~ | drift | **已闭环（phase154）** | `src/assembly/` 落地 + assemble() / disassemble() 导出 / 装配代码搬出 daemon.ts |
| ~~A.2 Instances 接口不存在~~ | drift | **已闭环（phase154）** | interface Instances readonly 字段集 / tsc 编译期保证 |
| ~~A.3 TaskSystem setter 注入~~ | drift | **已闭环（phase157）** | constructor 重排 + 4 setter 删除 / 顺序 toolRegistry → skillRegistry → contractManager → outboxWriter → taskSystem |
| ~~A.4 Runtime.initialize() 混合装配与业务~~ | drift | **已闭环（phase156/157）** | 构造搬 Assembly / 业务（session repair）留 Runtime |
| ~~A.5 各模块 createX 工厂缺失~~ | drift | **已闭环（phase155）** | L1-L5 各模块导出 createX(config) 工厂 / Assembly 改调工厂 |
| ~~A.6 周边装配未纳入~~ | drift | **已闭环（phase158）** | createStreamCallbacks + waitForInbox 内 FileWatcher 装配 / watchdog 装配段收拢 Assembly |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| B.1 Instances 接口字段增长（phase154→phase155-157+ 扩展）| design-gap / 设计意图 | 非 M#7 违反（约束「对外表面不随外部模块增减传染」）/ Assembly Instances 增长是自身 scope 演进的主动结果 / 每次扩展须同步本契约 §1 加 [interfaces/l6.md](../interfaces/l6.md) Assembly 接口定义 |
| B.2 recovery-snapshot 失败不抛 | design-gap / 显式决策 | 启动期已有失败累积保护 / recovery 失败不应级联 block daemon 启动 / 登记不修 |
| B.3 构造顺序拓扑当前隐式表达（靠代码行顺序）| drift / 中 | open / r41+ design phase | **应然 rule**：构造顺序约束应显式 DAG 声明（如 `interface ConstructionOrder { name: string; deps: string[] }[]` 或 topological sort 装配）/ 当前隐式靠代码行顺序（toolRegistry → skillRegistry → ... → taskSystem）/ 出错风险随依赖项增多而上升。升档：r41+ design phase 加显式 DAG / r42+ 代码实施 |
| ~~B.4 LockConflictError 是 Assembly 专属类型~~ | ~~drift / 边界违规~~ | **✅ closed phase410**（main `129e8505`）| 治理 = LockConflictError 类物理迁 process-manager + 合并 LockHeldError → LockConflictError（rename / 单一错误类型 / `clawId` 字段保留）+ ProcessManager.acquireLock 直接抛 LockConflictError + Assembly assemble.ts catch + audit + 直接 `throw e`（不 wrap）+ assembly/index.ts re-export（向后兼容）+ daemon.ts import 改 `../foundation/process-manager/index.js` / M#3 align（LockConflictError 资源唯一归属 PM）/ M#5 align（Assembly L6 不 own L2 失败类型）/ 物理迁模板第 N+1 次复用（同 phase303）|
| B.5 phase155B Snapshot 单实例约束 | design-gap / 显式 | 不修 | 双视角共享同一对象 / 重复 new Snapshot = audit `recovery-snapshot` 2 条而非 1 条 bug 风险 |
| B.6 phase155B Runtime 精确 audit + Daemon 兜底 audit 幂等共存 | design-gap / 显式 | 不修 | 同一失败可能写两条 assemble_failed / 精确粒度 + 笼统兜底同时存在是设计意图 / 不引入 AssembleFailedError 类（会扩散异常体系超 scope）|
| ~~assembly audit event 字符串硬编码~~ | ~~drift~~ | **✅ closed phase386**（main `<MERGE_SHA>`）| disassemble.ts 3 caller 改 ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED const ref / 字符串值完全等价 / 收尾（assembly 内 caller 风格并轨）|
| ~~daemon_started 归属错配~~ | ~~drift~~ | **✅ closed（phase385 / 同根 cross-ref l6_daemon daemon_started 归属错配 row）** | r42 D fork 发现 / 实由 Assembly assemble.ts:108 发（DAEMON_START）/ 本契约 §5 已显式列 / l6_daemon §5 已 phase385 同步移除 daemon_start 描述 / 双侧应然 align |
| DispatchTool 闭包注册结构性循环依赖（B 类偏差登记）| design-gap / 显式 | 不修 | Runtime initialize 期 DispatchTool 闭包绑（this.buildSystemPrompt / this.toolRegistry.formatForLLM）/ Assembly 构造期 Runtime 尚未 new / register 必须留 Runtime 内 / 实然 runtime.ts:242-254 注释已标「候选 γ：结构性循环依赖妥协」/ phase385 应然 sharpen 同步登记（cross-ref l5_runtime DispatchTool 注册闭包依赖 ✅ closed）/ 升档：若未来 Assembly 重构允许两阶段构造 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：装配逻辑（identity 分支 + 跨模块回调注入 + 关停拓扑）vs Daemon 进程生命周期（信号处理 + 主事件循环）= 完全不同关注点 / 合并即违 M#1
- M#2 业务语义归属：「装配 + 拆装」业务语义由本模块发起 / 各模块内部初始化由各模块自身负责
- M#3 资源唯一归属：Assembly 无资源 / 各被装配模块持各自资源 / Snapshot 单实例约束保证唯一性
- M#4 持久化：无 / 装配胶水
- M#5 依赖单向：L6 → L1-L5 / 不反向依赖 / readonly Instances 防 Daemon 反向修改字段引用
- M#6 依赖结构稳定：identity union type 编译期穷尽 / 构造顺序当前隐式（B.3 待 DAG 升档）
- M#7 耦合界面稳定：对外仅 assemble + disassemble 两动作 / Instances 字段增长非 M#7 违反（B.1 自身 scope 演进）
- M#8 耦合界面最小：Daemon 仅消费 Instances readonly 字段 + 调方法 / 不见装配内部
- M#9 显式编译器可检：identity union + readonly Instances 字段 / assembly audit event caller 字符串硬编码 ✅ closed phase386
- M#10 不合理停下：phase155 6 phase 接力 / phase328 audit-sink 物理迁 / phase335 13 port 注入化 ⚠ STALE / phase340 verifier port 立 ⚠ STALE / 各 phase 都遵循「停下重构」纪律（⚠ port pattern 实例 2026-05-03 整套推翻 / 详 feedback_governance_workaround_smell）
- M#11 边界对不上停下：A.1-A.6 显式登记 + 接力清零 / B.3 顺序拓扑显式登记 / 不强行 mechanical

**Design Principles**

- D1 信息不丢失 / 可观察 / 可恢复 / 可审计：6+11 events 全覆盖 + Runtime 精确 audit + Daemon 兜底 audit 幂等共存（B.6）
- D2 不丢弃 / 静默：assemble 失败 + recovery 失败 + lockfile 冲突 + disassemble 失败 全 audit 留痕
- D3 用户可观察：audit.tsv 全链路覆盖 / `daemon_started` / `daemon_stop` / `assemble_failed` 经 `clawforum status` 可读
- D4 中断恢复：disassemble 反向拓扑 + 全序继续 / Daemon 信号处理保证关停最末写 daemon_stop
- D5 日志重建：每个装配步骤 audit + module + phase + reason 三字段 / 故障复盘可重建 assemble 链路
- D6 子代理后不阻塞：Assembly 是同步装配 / 业务异步归各模块（TaskSystem 等）
- D7 系统可信路径：受信注入 deps / 非 caller 持有引用决定权
- D8 事件驱动：事件由 Daemon 调 assemble / 不轮询
- D9 CLI 唯一对外：Assembly 不与外部交互 / 由 Daemon 经 CLI 触发
- D10 多 claw 不隔绝：identity 分支区分 motion / claw / 装配差异在 Assembly 内集中
- D11 motion 特殊：cronRunner / heartbeat 仅 motion 装 / identity 分支显式

**Philosophy**

- P3 多 agent 利用：identity 分支装配 motion + claw 不同 instances
- P4 系统为智能体服务：提供「装配 + 拆装」基础设施

**Path Principles**

- Path #1 实然为唯一基准：phase154-158 接力清零 / phase328 物理迁 / phase335 注入化 / phase340 port 立 / 各 phase Path #1 核
- Path #3 语义最小变更单元：每 phase 单一 scope（A.1-A.6 各自独立 / 不混合）
- Path #6 冲突立即中断：r42 D 结构合规复盘 / 发现 8 节模板 vs 实然结构脱节 / 停下补完
- 反向测试：本模块可独立替换 identity 配置而不动 Runtime —— M#1 ✓

### 7.D 历史纪律

- 2026-03 / phase154 A.1+A.2 清零（Assembly 模块落地 + Instances 接口）
- 2026-03 / phase155 A.5 清零（L1-L5 各模块 createX 工厂 + RuntimeDependencies 16 字段定义）
- 2026-03 / phase155B Snapshot 单实例约束 + Runtime 精确 audit + Daemon 兜底 audit 设计决策
- 2026-03 / phase156+phase157 A.3+A.4 清零（Runtime.initialize 装配 vs 业务拆分 + TaskSystem setter 删 + constructor 重排）
- 2026-03 / phase158 A.6 清零（周边装配收拢）
- 2026-04-21 / phase182 setter 双阶段升级（装配期 setter 双阶段注入 / Runtime 公共接口 -2 setter / 改 RuntimeDependencies 字段注入）
- 2026-04-26 / phase328 LLMService（pre-split / r61+ 现 L1 LLMProvider）L1→L2 audit-sink 物理迁移（`src/assembly/llm-audit-sink.ts`）
- 2026-04-26 / phase335 H7+H8 13 port 注入化（Runtime DispatchTool 物理迁）⚠ STALE 2026-05-03 推翻：13 port 是 over-engineering / Runtime → Tools L5→L2 顺向直 dep 合规 / 详 feedback_governance_workaround_smell
- 2026-04-27 / phase336+phase338 H1 audit-events.ts 模块自治拆分（LLM_AUDIT_EVENTS 物理迁 `src/assembly/llm-audit-events.ts`）
- 2026-04-27 / phase340 ContractVerifierScheduler port 注入（H6+H11）⚠ STALE 2026-05-03 推翻：同层单向 over-engineering / ContractSystem 直 dep TaskSystem 完全合 M#5 / 详 feedback_governance_workaround_smell
- 2026-04-27 / phase344 types/contract.ts 按语义域拆 3 文件
- 2026-04-27 / r42 D 结构合规复盘（§7→§8 编号修订 + Path 6 待补）
- 2026-05-03 / phase410 B.4 LockConflictError 归 PM 闭环（main `129e8505`）/ 物理迁 LockConflictError → process-manager + 合并 LockHeldError → LockConflictError + Assembly 不 wrap re-throw + daemon.ts import path 改 / 同 phase 与 l5_runtime _hasHighPriorityInbox port 治理 / 模块边界重构阶段第 2 phase
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §1 所有权 hub / §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l6.md / 拆原 §1 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#15 | Assembly 独立成 L6 | ✓ phase154 落地 |
| KD#23 | 装配职责三分（Assembly + Daemon + Runtime）| ✓ phase156-158 接力实施 |
| KD#25 | Runtime 不自建 L1-L2 / 经 RuntimeDependencies 注入 | ✓ phase155B 落地 |
| KD#28 | LLM audit-sink 装配层 fan-out（phase328 物理迁 / r61+ pre-split LLMService → L1 LLMProvider + L2 LLMOrchestrator）| ✓ phase328 物理迁 |
| KD（待编号）| port pattern 三 phase 实证（phase337+335+340）| ⚠ STALE 2026-05-03 整套推翻 / 5 实例真用 M#5 + M#1 + M#2 核 = 5/5 design debt / 推 r61+ 反向 design phase / 详 feedback_governance_workaround_smell |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **assemble 成功路径**：所有模块构造 + 跨模块回调注入 + acquireLock + daemon_started audit
- **identity 分支**：motion 装 cronRunner + heartbeat / claw 不装 / Instances 字段 readonly + 编译期保证
- **lockfile 冲突**：assemble_lock_conflict audit + LockConflictError 抛
- **某模块构造失败**：assemble_failed（module + phase + reason）+ Error(cause) 抛 + Daemon process.exit
- **snapshot 失败二分**：init 失败抛 / recovery-commit 失败不抛（B.2 显式决策）
- **runtime.initialize 后置失败**：assemble_failed（module='runtime', phase='post_assemble_init'）+ Daemon 兜底
- **Snapshot 单实例**：双视角共享同一对象 / 重复 new = recovery-snapshot audit 重复 bug 防御测试
- **Runtime 精确 audit + Daemon 兜底 audit 幂等共存**：同一失败两条 assemble_failed 不重复触发关键路径
- **disassemble 全序继续**：某步抛错 disassemble_step_failed audit + 继续下一步
- **disassemble 末尾**：daemon_stop 写入磁盘（AuditWriter 不 close）
- **identity 分支穷尽**：tsc 保证 union type 不漏分支
- **审计回链**：6 ASSEMBLY_* + 11 LLM_AUDIT_EVENTS 全覆盖（phase386 const 引用合规）
- **detectUncleanExit**：daemon_unclean_exit audit + 不影响 assemble 继续
