# L6c Assembly 对外接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §29 align）：模块装配根。按 identity 配置分支决定启哪些模块 + 调各模块 setup 函数 + 注入跨模块回调 + 返回 Instances 句柄集。Assembly 会随模块数量增加而变大，但对外耦合界面恒定为「装配 + 反向清理」两动作，外部模块增减不影响调用方。

**实然**：落地于 `src/assembly/index.ts`。assemble() / disassemble() 两异步函数 + readonly Instances 接口。按 identity（motion / claw）配置分支决定装哪些模块。§7.A 6/6 全清零（phase154-158 接力）。§7.B 6 条偏差保留。无状态（无磁盘/进程资源）。

归属：L6c 装配。
- **应然依赖**：L1-L5 各模块的 setup 函数
- **实然依赖**：所有 L1-L5 模块的 constructor / factory（装配汇聚点本质）, node 内置

## 1. 概述

模块装配根。按 identity（motion / claw）配置分支决定启哪些模块、调各模块 `createX` setup 函数、注入跨模块回调、返回 Instances 句柄集给 Daemon；关停时按依赖拓扑反向调各模块的 close/stop。

资源：无（Assembly 本身无状态，不持有磁盘或进程级资源；仅在 `assemble()` / `disassemble()` 调用期间持有构造中的局部引用）。

消费者：Daemon（唯一调用方，进程启动时调 `assemble(config)` 拿 Instances 后调 Runtime；关停时调 `disassemble(instances)`）。

**为何独立成 L6c**：装配逻辑本身是一组独立可变的职责（按 identity 分支、跨模块回调注入、关停拓扑），与 Daemon 的进程生命周期职责（信号处理、主事件循环）完全不同关注点，合并在 Daemon 里会让 Daemon 违反原则 #1（一个模块封装一组独立可变的职责）。参见 modules.md 关键决策 #15 / #23。

## 2. 职责边界

**做**：
- 按 `config.identity` 分支决定装哪些模块（如 `Heartbeat` / `CronRunner` 仅 motion 装）
- 调各模块的 `new X(...)` 或 `createX(...)` 工厂构造实例
- 构造期注入跨模块回调（如 `runtime.setParentStreamLog(streamWriter)` / `runtime.setContractNotifyCallback(...)`）
- 返回 **`readonly` Instances** 句柄集给 Daemon
- 构造期逐步 audit（成功写 `daemon_started`，任一步失败写 `assemble_failed` 后 throw）
- `disassemble(instances)` 按依赖反序关停各模块，每步 try/catch + audit 失败但继续下一步；最末写 `daemon_stop`
- `processManager.acquireLock` 在 `assemble` 内调，冲突即写 `assemble_lock_conflict` 抛 `LockConflictError`

**不做**：
- 模块**内部初始化**（`init()` / `initialize()` / `loadAll()` / `archive()` 等）——属各模块自身业务语义，由各模块的 `createX` 工厂内部完成或由消费方调
  - 例外：`snapshot.init()` + `recovery-snapshot commit` 目前在 assemble 内执行（属启动期一次性关键路径）；phase155 做 `createSnapshot` 工厂时彻底归位到工厂内部
- **Runtime 业务动作**：`runtime.initialize()` 中的 session repair、`runtime.resumeContractIfPaused()` 等由 Daemon 调（属业务语义，不是装配）
- **错误回滚**：构造途中失败不调 `disassemble` 回滚已构造的模块，Daemon 捕获异常后 `process.exit`，OS 回收资源
- **Instances 字段的重新赋值**：Daemon 只能读 Instances 字段或调字段对象的方法（`runtime.stop()` 等）；字段引用本身 `readonly`，tsc 编译期保证

## 3. 接口

```ts
type Identity = 'motion' | 'claw';

interface AssembleConfig {
  identity: Identity;
  clawId: string;
  clawDir: string;
  globalConfig: GlobalConfig;     // 来自 clawforum.yaml
  clawConfig: ClawConfig | null;  // identity='claw' 时必填（来自 claw.yaml），'motion' 时为 null
}

interface Instances {
  readonly runtime: MotionRuntime | ClawRuntime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditWriter;
  readonly cronRunner?: CronRunner;   // motion only + config.cron.enabled
  readonly heartbeat?: Heartbeat;     // motion only + heartbeat_interval_ms > 0
}

class LockConflictError extends Error {
  readonly clawId: string;
}

// 预期失败一类：LockConflictError（返 throw，消费者 catch 后友好提示，不 crash）
// 不可预期失败：模块构造异常 / FileSystem 异常等，audit assemble_failed 后抛 Error（带 cause）
async function assemble(config: AssembleConfig): Promise<Instances>;

// 全序继续：每步 try/catch audit + 写 daemon_stop 末尾
async function disassemble(instances: Instances, signal: string): Promise<void>;
```

关键约定：
- `assemble` 成功返回时：所有模块已构造完毕、跨模块回调已注入、`acquireLock` 已拿到、`daemon_started` audit 已写
- `assemble` 失败：写 `assemble_failed`（载荷含失败模块名 + phase + reason）后抛 `Error`（带 `cause`）；或 `acquireLock` 冲突时写 `assemble_lock_conflict` 抛 `LockConflictError`
- `disassemble` 返回前保证写入 `daemon_stop`；中间步骤失败写 `disassemble_step_failed` 后继续
- `Instances` 是 **readonly 值对象**，Daemon 不得重新赋值字段（tsc 编译期保证）；调字段对象的方法允许
- `Instances` 接口会随 phase155-158 扩展字段（TaskSystem / ContractManager 等随 Runtime 剥离进入），属 Assembly 职责演进，非原则 #7 违反

**L1-L2 装配与 RuntimeDependencies**

phase155B 起，Assembly 负责全部 L1-L2 预制和装配，通过 `RuntimeDependencies` 一次性注入 Runtime：

- **L1 预制**：`systemFs`（`enforcePermissions=false`）+ `clawFs`（`enforcePermissions=true`），两者 `baseDir=clawDir`
- **L2 装配**：`auditWriter` / `snapshot` / `sessionManager` / `inboxReader` / `outboxWriter`
- 这些 L2 模块**不进 `Instances`**（Daemon 不直接消费），只通过 `dependencies` 传入 Runtime
- **Snapshot 单实例约束**：Assembly 构造唯一 `Snapshot` 对象，同时出现在 `Instances.snapshot`（Daemon 视角）和 `RuntimeDependencies.snapshot`（Runtime 视角）；两接口皆 `readonly`，不共享写权。违反风险：Assembly 内重复 `new Snapshot(...)` 会回归双实例 bug（audit.tsv 见 `recovery-snapshot` 2 条而非 1 条）
- 完整 `RuntimeDependencies` 16 字段定义见 `coding plan/phase155/接口冻结.md` §3；代码最终权威在 `src/core/runtime.ts`

## 4. 失败语义

### assemble()

| 场景 | 行为 | 分类 |
|---|---|---|
| lockfile 冲突（已有进程在跑）| audit `assemble_lock_conflict` + 抛 `LockConflictError`（Daemon 捕获后友好提示 `process.exit(1)`）| 预期失败 |
| 某模块 constructor 抛错（fs 异常 / config 非法 / git 不存在 等）| audit `assemble_failed`（module/phase/reason）+ 抛 `Error(cause)`（Daemon 捕获后 `process.exit(1)`）| 不可预期失败 |
| `snapshot.init()` 失败 | audit `assemble_failed`（module='snapshot', phase='init'）+ 抛 | 不可预期失败 |
| `recovery-snapshot commit` 失败 | audit `assemble_failed`（module='snapshot', phase='recovery-commit'）+ **不抛**（recovery 失败不应阻塞启动；audit 留痕即可）| 软失败（显式决策） |
| 跨模块回调注入失败（setter 方法抛错）| audit `assemble_failed` + 抛 | 不可预期失败 |
| `session_manager|inbox_reader|outbox_writer` constructor 抛错 | audit `assemble_failed`（module='session_manager'/'inbox_reader'/'outbox_writer', phase='construct'）+ 抛 | 不可预期失败 |
| `runtime.initialize()` 抛错（含 session repair、inbox init 冒泡）| audit `assemble_failed`（module='runtime', phase='post_assemble_init'）+ Daemon `process.exit(1)` | 不可预期失败（兜底） |
| 所有步骤成功 | audit `daemon_started`（clawId + pid）| ok |

### disassemble()

| 场景 | 行为 | 分类 |
|---|---|---|
| 某步 await 抛错（如 `runtime.stop()` 超时）| audit `disassemble_step_failed`（step + reason）+ 继续下一步 | 全序继续 |
| `processManager.releaseLock` 失败 | audit `disassemble_step_failed`（step='release_lock'）+ 继续 | 全序继续 |
| 所有步骤完成 | audit `daemon_stop`（signal）| ok |

**关键约束**：
- audit 是**观察通道**，不是失败处理通道。assemble 的不可预期失败必须**抛**给 Daemon 决策（process.exit）；disassemble 的失败**不抛**（关停过程已无消费者可决策，信号已到 OS 层面）
- `AuditWriter` 不在 disassemble 内 close（TSV 追加写无 close 义务），保证 `daemon_stop` 事件写入磁盘

### 审计事件清单

| 事件名 | 触发位置 | 载荷 |
|---|---|---|
| `daemon_started` | assemble() 末尾 | `clawId`, `pid` |
| `daemon_stop` | disassemble() 末尾 | `signal` |
| `assemble_failed` | assemble() 任一构造步骤失败 | `module`, `phase`, `reason` |
| `assemble_lock_conflict` | `processManager.acquireLock` 失败 | `clawId` |
| `disassemble_step_failed` | disassemble() 任一步 await 抛错 | `step`, `reason` |

## 5. 不可消除的耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Assembly 自身就是 13 port 的注入终点（消费方各自 own / Assembly 装配 default impl / 注入 RuntimeDependencies）。

- **Assembly 依赖所有 L1-L5 模块的 constructor / factory**：作为 L6c 装配根，Assembly 必须知道所有被装配模块的构造签名。这是"**装配职责**"本质，合规（依赖单向、L6c 在所有 L1-L5 之上）
- **identity 分支决定装配差异**：`motion` / `claw` 的差异在 Assembly 内集中表达（如 Heartbeat / CronRunner 仅 motion 装），**不泄漏到业务模块**。配合 `type Identity = 'motion' | 'claw'` 联合类型，tsc 保证分支穷尽（原则 #9：不可消除耦合显式表达，编译器可检）
- **构造顺序隐含依赖拓扑**：如 `streamWriter` 构造需要 `auditWriter` 先在、`snapshot` 构造需要 `auditWriter` 先在。当前代码层面靠手写顺序保证；phase156/157 Runtime 剥离后，顺序约束变多（toolRegistry → skillRegistry → contractManager → outboxWriter → taskSystem），仍靠代码顺序表达。若未来顺序复杂到出错，考虑显式拓扑声明（DAG 结构）
- **跨模块回调注入的时机约定**：`runtime.setParentStreamLog(streamWriter)` 和 `runtime.setContractNotifyCallback(...)` 必须在 `runtime.initialize()` 之前调（Runtime 内部模块消费这两个引用）。当前 Daemon 先调 `assemble()` 拿 runtime（已 setXxx 完毕），再调 `runtime.initialize()`——时序正确但靠约定而非类型保护
- **Instances 字段对象的生命周期由 Daemon 管理**：Daemon 持有 Instances 引用直至 `disassemble()` 完成。期间任何 Instances 字段对象被 GC / 替换都会破坏关停拓扑；readonly 修饰 + Daemon 源码约束共同保证

## 6. 配置常量归属

- `type Identity = 'motion' | 'claw'` 常量类型定义在 Assembly 模块内（因为 Assembly 是唯一消费 identity 分支的地方）
- **motion-specific 配置键**（如 `motion.heartbeat_interval_ms` / `motion.max_steps` / `cron.enabled`）归属 `clawforum.yaml` schema（types/config），Assembly 只读取
- **claw-specific 配置键**（如 `tool_profile` / `subagent_max_steps`）归属 `claw.yaml` schema，Assembly 从 `config.clawConfig` 读取
- **`assemble_failed` / `assemble_lock_conflict` / `disassemble_step_failed`** 事件名常量定义在 Assembly 模块（归属于触发方）；`daemon_started` / `daemon_stop` 事件名复用现有 Daemon 约定常量

## 7. 与现状的差异

### A 类（phase154-158 全清零）

~~**A.1 — Assembly 模块不存在**~~ → **phase154 已清零**（`src/assembly/` 落地 + `assemble()` / `disassemble()` 导出）
  - **违规核心**：modules.md L309 L6c Assembly 已定义职责，但源码无对应模块；装配代码散在 `daemon.ts` (~260 行) / `motion.ts` (~100 行) / `runtime.ts` (~155 行) / `claw.ts` (~50 行)。
  - **违反原则**：
    - #1（一个模块封装一组独立可变的职责）—— Daemon 同时承担"装配 + 进程生命周期"
    - #23（装配职责三分）—— modules.md 决策已立但未落地
  - **修复方向**：phase154 新建 `src/assembly/`，搬 daemon 层装配代码进 `assemble()`；daemon.ts 瘦身为进程生命周期。Runtime.initialize() 的 15 个模块装配暂保留（phase156/157 议题）

~~**A.2 — Instances 接口不存在**~~ → **phase154 已清零**（`interface Instances` readonly 字段集）
  - **违规核心**：Daemon / Motion / Claw 命令层各自持有散乱的 local 模块引用变量，无统一句柄集
  - **违反原则**：#9（不可消除耦合显式表达，优先编译器可检）
  - **修复方向**：phase154 定义 `interface Instances`（readonly 字段），tsc 编译期保证 Daemon 不得越权修改

~~**A.3 — TaskSystem setter 注入**~~ → **phase157 已清零**（constructor 重排 + 4 setter 删除）
  - **违规核心**：`runtime.ts` L277-279 通过 `taskSystem.setSkillRegistry / setContractManager / setOutboxWriter` 注入依赖，是**构造顺序错**的凑合（审计结论：不是真循环，只是 TaskSystem 过早构造）
  - **违反原则**：#5（依赖单向）嫌疑（实际无真循环）+ 编码规范"可变状态应有唯一且明确的管理者"（setter 让 TaskSystem 的依赖字段可被多点写入）
  - **修复方向**：phase157 构造顺序重排为 `toolRegistry → skillRegistry → contractManager → outboxWriter → taskSystem`，TaskSystem 所有依赖通过 constructor 参数传入；删除 4 个 setter 方法

~~**A.4 — Runtime.initialize() 混合装配与业务**~~ → **phase156/157 已清零**（构造搬 Assembly / 业务留 Runtime）
  - **违规核心**：runtime.ts L152-307 同时做"模块构造"和"模块初始化"和"session repair 业务动作"
  - **违反原则**：#2（模块为自己的业务语义负责）
  - **修复方向**：phase156/157 把构造部分搬到 Assembly；session repair 等业务动作保留在 Runtime

~~**A.5 — 各模块 createX 工厂缺失**~~ → **phase155 已清零**（L1-L5 各模块导出 `createX(config)` 工厂）
  - **违规核心**：大多数 L1-L5 模块仅导出 class，无工厂函数；Assembly 装配时大量 `new X(fs, dir, audit, ...)` 位置参数调用
  - **违反原则**：编码规范"命名一致性是接口契约的一部分"+ "依赖尽量少，必要的显式表达"
  - **修复方向**：phase155 每个 L1-L5 模块导出 `createX(config)` 工厂（对象参数 + 内部做 init 等初始化），Assembly 改调工厂

~~**A.6 — 周边装配未纳入**~~ → **phase158 已清零**（周边装配收拢到 Assembly 内部）
  - **违规核心**：`daemon-loop.ts` 的 `createStreamCallbacks` + `waitForInbox` 里 `FileWatcher` 装配、watchdog 装配段不在 Assembly
  - **违反原则**：#1 装配职责集中化不彻底
  - **修复方向**：phase158 周边装配收拢到 Assembly 内部子模块或辅助函数

### B 类（偏差登记，不必修）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B 类历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - Instances 接口字段增长 = **design 决策已存**（scope 演进主动结果）
> - recovery-snapshot 失败不抛 = **design 决策已存**
> - 构造顺序拓扑隐式 = **drift**（修法明确：DAG 显式声明 / 推 r43+）
> - LockConflictError 是 Assembly 专属类型 = **drift**（应归 ProcessManager）
> - phase155B 决策 = **design 决策已存**（双 audit + 单 Snapshot）
> - **B.p344-Z assembly audit event 字符串硬编码** = **drift**（r42 D fork 新发现 / `daemon_started` / `assemble_failed` / `assemble_lock_conflict` / `disassemble_step_failed` / `disassemble_*` 等 caller 直字符串 / 应在 assembly/audit-events.ts const / 与 contract B.p344-1 + cron B.p336-1 同模式 / 推 r42 B 治理并轨）
> - **daemon_started 归属错配**（r42 D fork 发现）= **drift**（实由 Assembly assemble.ts:508 发 / 但 l6_daemon §3.1 也列 / 应在本契约 §3 audit events 列出 + l6_daemon §3 移除）

- **Instances 接口字段增长**：phase154 是最小集（7 字段），phase155-157 会扩展（Runtime 剥离带入 TaskSystem / ContractManager 等）。**非原则 #7 违反**——#7 约束"对外表面不随外部模块增减传染"，Assembly Instances 增长是自身 scope 演进的主动结果。但每次扩展须同步更新本契约 §3 接口定义
- **recovery-snapshot 失败不抛**：`snapshot.commit('recovery-snapshot')` 失败时 audit 留痕但不阻塞启动。这是**显式设计决策**（启动期已有失败累积保护，recovery 失败不应级联 block daemon 启动）。登记而不修
- **构造顺序拓扑当前隐式表达**：靠代码行顺序。phase155-157 模块增多后若出错风险上升，考虑引入显式 DAG 声明。当前 phase 内不纳入
- **LockConflictError 是 Assembly 专属类型**：属"边界违规"——锁冲突本应是 ProcessManager 的失败语义。phase154 沿用当前 PM 抛通用 Error 的现状，Assembly 内包装为 LockConflictError 上浮。长期应由 ProcessManager 契约定义此错误类型，Assembly 直接 re-throw
- **phase155B 决策 — Snapshot 单实例约束**：Assembly 构造唯一 `Snapshot` 对象，同时出现在 `Instances.snapshot`（Daemon 视角）和 `RuntimeDependencies.snapshot`（Runtime 视角）；两接口皆 `readonly`，不共享写权。违反风险：Assembly 内重复 `new Snapshot(...)` 会回归 phase154 双实例 bug（audit.tsv 见 `recovery-snapshot` 2 条而非 1 条）
- **phase155B 决策 — Runtime 精确 audit + Daemon 兜底 audit 幂等共存**：Runtime 对启动期关键路径业务动作（`inboxReader.init()` / `sessionManager.save(repaired)`）单独 try/catch 精确 audit（`module=inbox_reader|session_manager`）后 rethrow；Daemon 对 `runtime.initialize()` 整体 catch 写兜底 audit（`module=runtime phase=post_assemble_init`）。同一失败可能写两条 `assemble_failed`——精确粒度 + 笼统兜底同时存在是**设计意图**，不引入 `AssembleFailedError` 类（会扩散 Assembly 异常体系，超 scope）
- **phase155E 合入锚点：SHA=2e15d96（Step 4 合入后回填实际 SHA；作为"phase155 系列 drift 全部闭环 + Assembly 冻结期正式生效"的时间标记，phase16X 稳定化 phase 以此为"已闭环前点"参照）

### 7.C 原则对照（Philosophy 4 + Design 11 + Module 11 + Path 6 = 32 条 / 2026-04-27 r42 D 结构合规修：补完 / 旧 C 类合规论述保留供溯源 见后）

> Path 6 authoritative source 待核 / 暂列已知 4 + 待补 2

#### Philosophy（4）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| P1 | Agent 即目录 | N/A | Assembly 是装配根 / 不直接消费目录形态 |
| P2 | clawforum 本质上下文工程 | N/A | 同上 |
| P3 | 分智能体目的 | 合规 | identity 分支装配 motion + claw 不同 instances |
| P4 | 系统为智能体服务 | 合规 | Assembly 提供「装配 + 拆装」基础设施 |

#### Design Principles（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| D1 | 信息不丢失 / 可观察 / 可恢复 / 可审计 | **部分违规** | `assemble_failed` / `assemble_lock_conflict` / `disassemble_step_failed` 全 audit ✓；但事件名字符串硬编码（B.p344-Z）影响 M9 |
| D2 | 信息未经显式设计不得静默忽略 | 合规 | recovery-snapshot 失败显式登记不阻塞（design 决策） / disassemble 全序继续（每步 try/catch + audit）|
| D3 | 用户可观察所有状态 | 合规 | audit + console + Instances readonly |
| D4 | 中断即从最后完整 LLM 调用恢复 | 合规 | recovery-snapshot 启动期 commit |
| D5 | 事后仅凭日志重建决策链路 | 合规 | assemble + disassemble 全程 audit |
| D6 | 子代理后不阻塞 | N/A | Assembly 不参与子代理生命周期 |
| D7 | 系统内部走可信路径 | 合规 | Assembly 装配后注入 Runtime / 不绕过 |
| D8 | 事件驱动 | N/A | Assembly 是装配点 / 非事件驱动 |
| D9 | CLI 唯一外部入口 | 合规 | Assembly 经 daemon-entry 进 |
| D10 | 多 claw 信息不隔绝 | 合规 | Assembly 装配跨 claw fs 共享 |
| D11 | motion 单向访问 | 合规 | identity 分支 motion-only 装 Heartbeat / CronRunner |

#### Module Logic（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| M1 | 一组独立可变职责 | 合规 | 装配 + 拆装独立可变 / vs Daemon 进程生命周期独立 |
| M2 | 业务语义自发起 | 合规 | assemble / disassemble 由本模块发起 |
| M3 | 资源唯一归属 | 合规 | Assembly 无状态 / 无独占资源 |
| M4 | 持久化一切信息 | 合规 | 全 audit + recovery-snapshot |
| M5 | 依赖单向 / 不预设上层 | 合规 | L6c 在所有 L1-L5 之上 |
| M6 | 依赖结构稳定 | 合规 | RuntimeDependencies 16 字段 ctor 一次注入 |
| M7 | 耦合界面稳定 | 合规 | assemble + disassemble + Instances readonly |
| M8 | 耦合界面最小 | 合规 | Assembly 对 Daemon 仅 2 函数 + 1 接口 |
| M9 | 编译器优先 | **部分违规** | Identity 联合类型 + Instances readonly ✓；但 audit event 字符串硬编码（B.p344-Z）= 编译期不可查 |
| M10 | 反向测试 | 合规 | identity 分支可独立改不动 daemon |
| M11 | 边界与依赖对不上停下 | 合规 | DispatchTool 闭包 B.11 跨契约引用显式登记 |

#### Path Principles（6 待核）

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase154-158 各 phase 起步 Path #1 核 |
| Path #3 | 语义原子最小变更 | 合规 | phase154-158 各自单一 scope（A.1-A.6 分 phase 消化）|
| Path #6 | 冲突停 | 合规 | phase155C squash-merge L2 装配顺序异常 / 显式登记不绕过 |
| Path #8 | 总难度最低 | 合规 | A 类 6 条分 5 phase 消化 / 不堆 |

---

### C 类（原则对照补充 / 旧合规论述 / 完整 §7.C 32 条见上）

- Assembly 无状态（无磁盘/进程资源），完全靠入参 config 决定行为——原则 #3（资源唯一归属）+ #6（依赖结构稳定）天然满足
- `Identity` 联合类型 + 分支穷尽由 tsc 保证——原则 #9 显式表达合规
- Assembly 对 Daemon 的接口最小（两个异步函数 + 一个 readonly 接口）——原则 #8 耦合界面最小合规
- `readonly` 修饰 Instances 字段强制 Daemon 单向消费——编码规范"可变状态应有唯一且明确的管理者"合规（管理者是 Assembly）

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#9（原 modules.md）配置是数据不是模块**：统一 config 文件,Daemon 装配时切片分发
- **KD#13（原 modules.md）回调注入是显式耦合**：装配期注入的回调签名是模块耦合界面的一部分,在模块描述中显式列出
- **KD#15（原 modules.md）Assembly 是装配汇聚点，Daemon 只做进程生命周期**：装配职责独立为 Assembly 模块（L6c），Daemon 不参与任何模块装配。任何模块的构造接口变更只触及 Assembly 和该模块自身的 `createX` setup，不扩散到 Daemon 或入口脚本（motion.ts / daemon.ts）  
  关联模块：l6_daemon.md（cross-ref / 主登记在本模块）
- **KD#23（原 modules.md）装配职责三分**：「怎么装出一个模块」归各模块的 `createX` setup 函数；「启什么模块、以什么拓扑装配」归 Assembly 模块；「进程生命周期」归 Daemon。三者是独立可变的职责（变更源不同），按原则 1「每种职责只归一个模块」必须拆
- **KD#24（原 modules.md）Motion 不是模块，是 identity 配置分支**：motion.ts 和 daemon.ts 是两种进程入口文件，都经 `Assembly.assemble(config)` 装配 + `Daemon.run(instances)` 跑循环；差异由 Assembly 按 `identity: 'motion' | 'claw'` 分支决定，不构成独立模块

---

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 缺 head 应然/实然 split | 补全（已执行）|

### 7.Phase 执行纪律（2026-04-27 r42 D 结构合规修：补完 / 此前缺）

#### phase154-158 纪律 — Assembly 模块落地 + A.1-A.6 全清零（2026-03-XX 期 / 主线 phase 链）

- A.1 Assembly 模块不存在 → phase154 落地 src/assembly/
- A.2 Instances interface 不存在 → phase154 readonly 字段集
- A.3 TaskSystem setter 注入 → phase157 ctor 重排
- A.4 Runtime.initialize() 混合装配业务 → phase156/157 拆
- A.5 createX 工厂缺 → phase155 全 L1-L5 加
- A.6 周边装配未纳入 → phase158 收拢

#### phase328 纪律 — LLMService L1→L2 audit-sink 物理迁移（r34 C / main `430e342` / 2026-04-26）

- L1 sharpen v2 应然落地 / src/foundation/llm/ 0 audit 残留 / src/assembly/llm-audit-sink.ts NEW
- B.p328-1 模板首用

#### phase335 纪律 — H7+H8 Runtime 注入化（r37 D + r38 D / main `c0405c2` / 2026-04-26）

- 13 port interfaces 全注入 RuntimeDependencies / Runtime own port 模板
- DispatchTool 物理迁 (δ)

#### phase340 纪律 — ContractVerifierScheduler port 注入（r40 B / main `736991b` / 2026-04-27）

- ContractManager ctor 增 verifierScheduler? + assemble.ts L193 注入 default scheduler / port pattern 第 3 次复用

#### phase342 纪律 — B.p340-2 异步 catch 吞 TypeError 治理（r41 B / main `2994632` / 2026-04-27）

- ContractManager / verifier-scheduler 编程 bug rethrow + UNEXPECTED_ASYNC_THROW audit
- 行为契约 0 改 / vitest 1353/1353

#### phase344 纪律 — types/contract.ts 按语义域拆（r41 D / main `ad96296` / 2026-04-27）

- types 共享层拆 messaging.ts + priority.ts + contract.ts
- assemble.ts import 同步 / 0 runtime / 0 行为

#### r42 D 结构合规复盘（2026-04-27 / 主会话）

- §7.C 32 条枚举补完（此前 0 枚举 / 仅 4 条「补充」）
- §7.Phase 节补完（此前缺）
- §5 加 r40.2 port pattern 优先标记
- §7.B 加 r40.3 drift / design-gap type 二分 + 已知 type 初判 + B.p344-Z assembly audit event 字符串硬编码登记 + daemon_started 归属错配登记

---

## 8. 测试覆盖（验证行为契约）

### 测试文件

`tests/assembly/assemble.test.ts` + `tests/assembly/disassemble.test.ts`（或合并 `assembly.test.ts`）

### 必测行为契约

**分支穷尽**（identity × config 组合）：
- `assemble({identity: 'motion', config with cron.enabled})` → Instances 含 `cronRunner`
- `assemble({identity: 'motion', config with heartbeat_interval_ms > 0})` → Instances 含 `heartbeat`
- `assemble({identity: 'motion', config with cron.enabled=false})` → Instances 无 `cronRunner`
- `assemble({identity: 'motion', config with heartbeat_interval_ms=0})` → Instances 无 `heartbeat`
- `assemble({identity: 'claw'})` → Instances 无 `cronRunner` 无 `heartbeat`

**disassemble 拓扑反序**（mock 各模块，断言调用顺序）：
- 顺序：`cronRunner.stop` → `runtime.stop` → `streamWriter.close` → `heartbeat.stop` → `processManager.releaseLock` → `auditWriter.write('daemon_stop', ...)`
- auditWriter 写 `daemon_stop` 必须**最后**

**audit 事件触发时机与载荷**（编码规范硬要求）：
- `daemon_started` 在 assemble() 成功末尾，载荷 `clawId=<config.clawId>` + `pid=<process.pid>`
- `daemon_stop` 在 disassemble() 末尾，载荷 `signal=<传入值>`
- `assemble_failed` 在构造异常时，载荷 `module` / `phase` / `reason`
- `assemble_lock_conflict` 在 `acquireLock` 抛错时
- `disassemble_step_failed` 在关停某步失败时；且**后续步骤仍执行**

**失败语义**：
- mock 某模块 constructor 抛错 → audit `assemble_failed` → throw（确认 audit 在 throw 之前调用完毕）
- mock acquireLock 抛错 → audit `assemble_lock_conflict` → throw `LockConflictError`
- mock `runtime.stop()` 抛错 → audit `disassemble_step_failed` → **后续 streamWriter.close / heartbeat.stop / releaseLock / daemon_stop 仍执行**
- mock `snapshot.commit('recovery-snapshot')` 抛错 → audit `assemble_failed`（phase='recovery-commit'）→ **不抛**（recovery 失败不阻塞启动）

**Instances readonly**：
- tsc 编译期验证（无需运行时测试）。尝试 `instances.runtime = ...` 编译报错即合规

### 覆盖率目标

Assembly 模块行覆盖率 ≥ 90%。motion / claw 分支均需用例覆盖。

## 9. Runtime / Daemon audit 分工

phase155B 后，Runtime 不再自建 L1-L2，但 `initialize()` 内仍执行业务动作（session repair、inbox init）。这类失败**不归 `assemble_failed` 的装配语义**，而归各自的业务事件链。

**分工约定**：

- **Runtime 侧（精确 audit 归属）**：对每个启动期关键路径业务动作单独 `try { await x } catch (e) { audit 'assemble_failed module=<精确> phase=<精确> reason=...'; throw; }`。rethrow 保证"失败暴露不吞没"
- **Daemon 侧（兜底笼统 audit）**：`try { runtime.initialize() } catch` 内无条件写 `assemble_failed module=runtime phase=post_assemble_init`，然后 `exit(1)`

两处同时存在、**语义互补**：
- 正常失败路径：Runtime 写了精确行，rethrow 冒到 Daemon，Daemon 再写一条笼统行——postmortem 看到 2 条 `assemble_failed`（精确 + 兜底），按时序解读
- Runtime 内未单独 try/catch 的漏网失败：只有 Daemon 的兜底行命中，postmortem 见 1 条笼统 `module=runtime`——信号是"精确归属缺失"，提示检查 Runtime 侧代码补 try/catch

**为何 Daemon 不做 `instanceof AssembleFailedError` 判别**：`AssembleFailedError` 类在本 phase **不存在**（phase154 / phase155B 都只抛通用 `Error`）。引入新异常类会扩散到 Assembly 所有 throw 点 + 契约文档，超 scope。

**为何幂等重复 audit 可接受**：`assemble_failed` 事件**多写一条不破坏 postmortem**——事件是诊断信号不是状态；ts 递增保证顺序可读；重复行对"事后重建决策链路"只添信息不减信息。相比引入 `AssembleFailedError` 的契约扩散，接受"幂等重复"是更小代价的工程解。

## 10. postmortem 读取指引

以 `sessionManager.save(repaired)` 失败为例（磁盘满抛 ENOSPC）：

时序上可见 3 条 audit：

1. `session_save_failed`（由 SessionStore 自身写，`l2_session_store.md` §失败语义——最底层信号，定位失败原因）
2. `assemble_failed module=session_manager phase=session_repair_save`（Runtime 精确 audit——定位失败在"启动期 session repair"链路）
3. `assemble_failed module=runtime phase=post_assemble_init`（Daemon 兜底 audit——标记整体启动失败）

**读法**：主凶是 1（底层原因），2 和 3 是诊断加层（定位在哪条业务链路 + 谁决定 abort）。运维看到 3 条一起出是**正常**，不是 bug；看到只有 2 或只有 3 则需检查缺失层。此冗余是幂等分工的设计代价，符合"事件是诊断信号不是状态"的权衡。

| 业务动作 | 位置 | 失败处理（phase155B） |
|---|---|---|
| `sessionManager.load()` | Runtime.initialize() session repair 链路 | SessionManager 自身语义：不抛、走 `session_corrupted` / `session_archive_read_failed` 等 audit 事件。Runtime 不介入 |
| `SessionManager.repair()` 静态方法 | Runtime.initialize() L214 | 纯函数，不抛；repair 失败回退到 empty session |
| `sessionManager.save(repaired)` | Runtime.initialize() L218 | `writeAtomic` 失败 → Runtime try/catch + audit `assemble_failed module=session_manager phase=session_repair_save` + rethrow |
| `snapshot.commit('session-repair')` | Runtime.initialize() L220 | Snapshot A.6：预期失败返 `{ ok: false, reason }`，Runtime 写 audit 记录不抛；不可预期失败抛，Runtime 捕获后 audit `snapshot_commit_failed` 不再上浮 |
| `inboxReader.init()` | Runtime.initialize() L304 | Runtime try/catch + audit `assemble_failed module=inbox_reader phase=init` + rethrow |
| `runtime.resumeContractIfPaused()` | daemon.ts 调（Runtime 方法）| 失败归 ContractManager 语义；若抛到 Daemon 则 `contract_resume_failed` + 启动继续（业务旁路） |
