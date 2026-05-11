# EvolutionSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) EvolutionSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §24「EvolutionSystem 本质：能力进化服务 / L4 agent 基础设施 ——『契约复盘』」加 M#1 / M#2 / M#3 / M#5 / Philosophy「各个 claw 的特长能力可以轻易复制过来」加 Design Principle「智能体是决策主体」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），EvolutionSystem 的单一职责 = **实现 Philosophy 「各个 claw 的特长能力可以轻易复制过来」的核心机制**：

- **订阅 contract 完成事件**：EvolutionSystem 是 subscriber / ContractSystem 是 publisher / 装配期 Assembly 显式订阅链 / 不工厂内静默
- **派 retro 子代理提炼能力**：经 AsyncTaskSystem 派 retro subagent / 不持 SubAgent 类引用 / 不 `new SubAgent`
- **去重协调**：同 contractId 已 retro 跳过（state 文件 `.evolution-system-state.json` 记录）
- ~~**SkillSystem.reload 协调**：retro 子代理用 write 工具写到 L2 SkillSystem 管理的 system dir / 本模块只调 SkillSystem.reload 触发 rescan~~ ✅ **closed by ε（2026-05-07 / l2c §G2 closure 同步）**：framing 推翻 / 实然 retro skill 走 **per-execution lazy load** 模式（dispatch + retro-scheduler 各 `createSkillSystem(...DISPATCH_SKILLS_DIR)` 临时 create instance）/ retro skill 写到 `clawspace/dispatch-skills/`（per-claw clawspace）/ 与 main skillsDir (system skills/) 隔离 / 本模块 0 真触发 SkillSystem reload/register / dead intent + dead field 群体推 r+1 code phase 顺手清
- **错误隔离**：单契约 retro 失败不影响后续契约（try/catch + audit）

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) EvolutionSystem 节。具体实现细节（subscribeToContractCompleted / runRetroForContract / dedupeByContractId / EvolutionSystemOptions 等）的存在依据是「事件驱动 + retro 子代理派发 + 去重」原语 — 实然采纳的细节差异等登记 §7.B。**注**（ε 决策 2026-05-07 closure）：~~triggerSkillSystemReload~~ + ~~SkillSystem.reload 协调~~ 描述 phantom 删 / 实然 dispatch + retro 走 per-execution lazy load 模式（详 §1 closed 行）。

### 不做

- **不做 contract 生命周期管理**（归 ContractSystem）— derive 自 M#1 + M#2
- **不发布 contract_completed 事件**（EvolutionSystem 是 subscriber / ContractSystem 是 publisher）— derive 自 M#3
- **不直接 `new SubAgent`**（必须经 AsyncTaskSystem 派 retro subagent）— derive 自 M#1 + M#5
- **不构造 LLMOrchestrator**（归 Assembly 注入）— derive 自 M#5
- **不做技能装配**（dispatch 工具读 SkillSystem 加载 system skill 装配 / 本模块只负责触发加去重 / **reload 协调 phantom 删** ε 2026-05-07 closure）— derive 自 M#1
- **不强约束模板 schema**（提炼内容由 retro subagent 决定）— derive 自 M#2
- **不跨实例合并状态**（每个实例自有 stateDir 加 retro 状态文件 / 不预设全局合并；skill 资源跨实例合并归 SkillSystem）— derive 自 M#3
- **不 own skill 内容存储**（skill 资源 own 在 L2 SkillSystem，retro 子代理用 write 工具写到 SkillSystem 管理的 system dir）— derive 自 M#3
- **不 own skill 写入接口**（skill 写入由 agent 用 write 工具完成，本模块不暴露 writeSkill 接口）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），EvolutionSystem 的业务语义边界：

- **own**：「契约完成后能力沉淀」业务语义唯一发起点：retro 触发 / prompt 构造（含 dispatch-skills 摘要 per-execution lazy load）/ 派 retro subagent / 去重（skill 内容由 retro subagent 用 write 工具写到 `clawspace/dispatch-skills/` per-claw clawspace / dispatch 工具 execute 时 per-execution lazy load 加载 / 本模块不 own skill 资源加 skill 查询接口 / **reload 协调 phantom 删** ε 2026-05-07）
- **角色定位**：EvolutionSystem 是「**契约完成事件订阅者 + retro 子代理派发器**」非「**能力提炼器**」。能力提炼由 retro 子代理实际执行（agent 决策）/ 本模块只协调触发加去重。
- **装配「按需」**：不绑死 motion 独占 / 不绑死 claw 独占 / 一个 daemon 内可装多个实例（隔离不同来源 retro 触发逻辑）
- **事件驱动**：装配期由 Assembly 注册到 ContractSystem 的 `contract_completed` 事件订阅链 / 显式订阅（非工厂内静默）
- **单契约 retro 失败不影响后续契约**（错误隔离 / try/catch + audit）

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），EvolutionSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<stateDir>/.evolution-system-state.json` 已 retro 过 contractId 列表（去重用） | 持久化（独占） | ✓ |

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），EvolutionSystem 的持久化立场：stateDir 磁盘是权威 / 无长驻内存 / 事件回调按需读 state / 处理完写回 / retro subagent 调度后不阻塞等待结果（异步 / 由 AsyncTaskSystem watcher 拾起）/ skill 内容由 retro subagent 用 write 工具写到 L2 SkillSystem 管理的 system dir / 不通过本模块自有 dir。

### 磁盘布局

```
<stateDir>/
└── .evolution-system-state.json   ← 已 retro 过 contractId 列表 + 上次处理时间戳
```

### 文件格式

- `.evolution-system-state.json`：`{ processedContractIds: string[], lastProcessedAt: string }`

### 重建语义

- state 文件读取失败 → 静默回退到空初始状态（容错）
- 无长驻内存 / 事件回调按需读 state / 处理完写回
- retro subagent 调度后不阻塞等待结果（异步 / 由 AsyncTaskSystem watcher 拾起）
- skill 资源持久化归 L2 SkillSystem own / 本模块 retro subagent 写到 `clawspace/dispatch-skills/`（per-claw）/ dispatch 工具 execute 时 per-execution lazy load 加载（**reload 协调 phantom 删 ε 2026-05-07 / 详 §A.dead-1**）

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/evolution-system/audit-events.ts` `RETRO_AUDIT_EVENTS`（模块自治）。

12 个 RETRO_* 事件（11 原 + phase 472 +3 SKIPPED_DUPLICATE+STATE_LOAD_FAILED+STATE_SAVE_FAILED / **ε 2026-05-07**：`skill_system_reload_triggered` + `retro_reload_failed` 2 phantom events 已删 by phase 520）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `retro_subscribed` | subscribeToContractCompleted 完成 | — |
| `retro_triggered` | contract_completed 事件回调进入 | `contractId`, `sourceClawId` |
| `retro_skipped_duplicate` | runRetroForContract dedupe 命中（processedContractIds Set）| `contractId` |
| `retro_state_load_failed` | _loadState 非 ENOENT 失败（JSON parse / read error）| `reason` |
| `retro_state_save_failed` | _saveState 失败（writeAtomic 失败 / retro 已 schedule 不撤销）| `reason` |
| `retro_prompt_built` | retro prompt 构造完成 | `contractId` |
| `retro_subagent_dispatched` | 经 AsyncTaskSystem 派 retro subagent | `contractId`, `taskId` |
| `retro_extraction_started` | retro subagent 开始执行 | `contractId`, `taskId` |
| `retro_finished` | retro 流程正常收口 | `contractId` |
| `retro_subagent_timeout` | retro subagent 超时（软失败）| `contractId` |
| `retro_no_skill_output` | retro subagent 无 skill 写入输出（软失败）| `contractId` |
| `retro_error` | 硬错误（catch + 隔离）| `step`, `contractId`, `reason` |

## 6. 层级声明

L4 agent 业务流程层（与 AsyncTaskSystem / ContractSystem / MemorySystem 同层 / 「契约完成后能力沉淀」业务语义独立可变 / 与 MemorySystem 同属「经验整合」类业务：MemorySystem 整合会话经验 / EvolutionSystem 整合契约能力）。下游 Assembly（L6）通过 `createEvolutionSystem` 工厂消费 + 注入 deps + Assembly 触发 `subscribeToContractCompleted()`。skill 装配由 L2 SkillSystem own / retro subagent 写新 skill 到 `clawspace/dispatch-skills/`（per-claw clawspace）/ dispatch 工具 execute 时 per-execution lazy load 加载装配给其他 claw（**reload 协调 phantom 删 ε 2026-05-07 / 详 §A.dead-1**）。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| **A.bypass-1 EvolutionSystem system.ts 直 import `node:fs/promises`** | M#5 弱违反 / 低 | **✅ closed**（phase455 / main `f619b303`）| L4 EvolutionSystem 1 file 直 import OS async API 绕 FileSystem L1 / 3 fsAsync calls 全清：`system.ts` (1) byContractPath read (2) messagesPath read (mining 模式) (3) byContractPath unlink (cleanup) → `ctx.motionFs.{read, delete}` async API / path 改成相对 motionFs baseDir / per-claw clawFs L138 instantiation 不动（同 phase434 模式合规）/ 行为 0 改 / 同 phase434+436 bypass cluster 模板 |
| **A.caller-DIP-clawFsFactory system.ts:192 业务模块内裸 new NodeFileSystem** | DIP drift / 中 / r74 G fork phase 609 derive | **✅ closed by phase 609**（main `710c1fb5` / merge）| **触发**：r74 fs 深耕 fan-out 副发现 + Step 0 sweep `new NodeFileSystem` src 全文 31 site 分类核（业务模块内 2 真 violation：本模块 + memory/deep-dream / 余 28 全合规）。**实然偏离**（r74 fan-out verified）：`system.ts:192` `const clawFs = new NodeFileSystem({ baseDir: clawDir })` 业务模块内 per-call dynamic 构 L1 impl / 违 M#5 单向依赖（L4 业务直 import L1 impl）+ M#7 耦合界面稳定（impl 改影响 caller）+ M#8 最小耦合（impl 暴露细节）。**phase 609 决策（28 原则核 6/6 dominant α factory 注入 vs β path 前缀重写 3/6 + γ 不动 2/6）**：MotionReviewContext +1 field `clawFsFactory: (clawDir: string) => FileSystem` / line 192 改 `ctx.clawFsFactory(clawDir)` / 删 NodeFileSystem import / assembly wiring `(d) => new NodeFileSystem({ baseDir: d })` / `createSystemAudit` 不动（已 factory function form / 合规）/ `new ContractSystem` line 193 不动（推 r75+ 评估）/ 0 NEW const / 0 行为差。**caller DIP enforce N=6+ 实证累**（phase 414b + 498 ×2 + 499 + 504 ×2 + 609 / 升格阈值彻底过）/ **「业务模块内 dynamic L1 instantiation → factory injection」子模板首发**（mirror caller DIP enforce 扩 dynamic resource creation 分类 / 推 r75+ ≥ 2 实证升格独立 feedback）|
| **A.caller-DIP-clawContractManagerFactory system.ts:194 业务模块内裸 new ContractSystem + createSystemAudit** | DIP drift / 中 / r75 E fork phase 619 derive | **✅ closed by phase 619**（r75 E fork / 起步 SHA `dfc593ce`）| **触发**：r74 G fork phase 609 副发现「`new ContractSystem` line 193 不动 / 推 r75+ 评估」/ r75 E fork Path #1 实测核。**实然偏离**：`system.ts:194` `new ContractSystem(clawDir, targetClaw, clawFs, createSystemAudit(clawFs, clawDir))` 业务模块内裸 new L4 + L2 dynamic instantiation / 违 M#5 单向依赖（业务 evolution 直构 L4 ContractSystem + L2 createSystemAudit）+ M#7 耦合界面稳定（impl 改影响 caller）+ M#8 最小耦合。**phase 619 决策（28 原则核 6/6 dominant α factory 注入 vs β path 前缀重写 3/6 + γ 不动 2/6 / mirror phase 609 模板）**：MotionReviewContext +1 field `clawContractManagerFactory: (clawDir, targetClaw, fs) => ContractSystem` / line 194 改 `ctx.clawContractManagerFactory(clawDir, targetClaw, clawFs)` / assembly wiring `(d, id, fs) => createContractSystem(d, id, fs, createSystemAudit(fs, d))` / 复用既有 createContractSystem factory（5 参 audit 显式注入）/ 0 NEW factory / 0 行为差。**「业务模块内 dynamic L1-L4 instantiation → factory injection」N=2 升格阈值过线**（phase 609 NodeFileSystem + phase 619 ContractSystem+createSystemAudit / Meta 41 候选独立 feedback）|
| **A.dead-1 SkillSystem.reload 协调 dead intent cluster** | dead field/intent/audit-event 群体 / 中 | **✅ closed by phase 520 / SHA `f2fcabaa`**（同 phase 426 ContractManager.retroScheduler 模板 / l2c §G2 closure ε 浮出 2026-05-07 / code phase 顺手清）| Path #1 实测核浮出 dead intent cluster：(1) `EvolutionSystem.skillRegistry?: SkillSystem` field（system.ts:22）declared 但 `grep this.skillRegistry / skillRegistry\.` in evolution-system/ = **0 真调用** = dead store / (2) `'reload_failed'` EvolutionError code（system.ts:33+39+40）declared 0 真用 / (3) `skill_system_reload_triggered` audit event（line 91）+ `RETRO_RELOAD_FAILED` audit event（line 95）declared 0 真写 / (4) assemble.ts 仍传 `skillRegistry` 到 createEvolutionSystem options / 全 phantom / 实然 retro skill 走 per-execution lazy load 模式（dispatch + retro-scheduler 各 `createSkillSystem(...DISPATCH_SKILLS_DIR)` 临时 create instance）/ 真合规处置：删 EvolutionSystem.skillRegistry option/field + 删 'reload_failed' code + 删 EvolutionError class + 删 2 audit events + 删 assemble.ts 传参 / design 同步 §1 + §2 + §5 + §6 + §7.D + §8 phantom 描述 |
| ~~**A.r68-1 PROGRAMMING_BUG_TYPES 跨模块 DRY violation（与 contract 模块共用语义）**~~ | ~~DRY drift / 中~~ | **✅ closed (phase 568 / `6863ff24`)** | **应然**：M#7 耦合界面稳定 + M#3 资源唯一归属 / 同业务语义 const + helper 应单源（与 contract 模块同 DRY 治理 / cross-ref `l4_contract_system §7.B B.r68-1`）。**实然漂移**：`system.ts:48-51` 本地 `PROGRAMMING_BUG_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError]` const + `isProgrammingBug` function（caller line 266）/ 同型复制至 `manager.ts:64-67` + `acceptance.ts:23-26` / 3 site byte-identical / 同根 phase 342 fail-fast 设计。**dispatch ⚠️ 标 evolution-system / Step 0 sweep 扩 contract 2 site**（per `feedback_plan_by_main_implement_by_user §7 Step 0 grep scope 完整性纪律` 第 N+1 实证 / dispatch ⚠️ 推 r+1 ≠ phantom prior 第 N+1 实证）。**phase 568 治理**：α 抽 src/types/errors.ts shared / β NEW foundation/errors dir / γ 保留复制 / dominant α / 28 原则 derive 5/5（M#3+M#7+M#8+Path #7）|
| ~~**A.race-state-load-atomicity stateFileLoaded race / lazy load 非原子**~~ | ~~drift / 中 / r68 D fork phase 566 derive~~ | **✅ closed（phase 566 Step B / main `10270e5f`）**：α 落地 — system.ts:58 +`private stateLoadPromise: Promise<void> \| null = null` + L114-115 `this.stateLoadPromise ??= this._loadState(); await this.stateLoadPromise;` Promise cache pattern / `stateFileLoaded` boolean 保留作 fast-path skip（已 loaded → 0 await 开销）/ concurrent runRetroForContract 仅一次 _loadState 真执行（vitest 并发测试 PASS）/ 反向 3 项全过 / 行为 0 差（既有 retro 流程 align）| **触发**：r68 ⚠️ verified review + Path #1 实测核。**实然偏离**：`system.ts:118-121` `if (!this.stateFileLoaded) { await this._loadState(); this.stateFileLoaded = true; }` / concurrent `runRetroForContract(c1) + runRetroForContract(c2)` → 二者都见 stateFileLoaded === false → 二次 await this._loadState() → 二次读 STATE_FILE / 二次设 processedContractIds Set / 第二次覆盖第一次（数据相同）+ STATE_LOAD_FAILED audit 可能写 2 次（D5 链路混淆）。**impact 行为差极低**（同源同结果）/ 但 design 不 robust / 触发场景 cron 派 motion 多 retro 并发 / contract 完成 callback 短间隔触发。**候选 α dominant 自决**（28 原则核 5/5 align）：`private stateLoadPromise: Promise<void> \| null = null` + `await (this.stateLoadPromise ??= this._loadState()); this.stateFileLoaded = true` / Promise cache pattern / 二者 await 同一 Promise / 仅一次实际 _loadState 执行 / 保留 stateFileLoaded boolean 作 fast-path skip（已 loaded 直 0 await 开销）/ M#3 单实例约束 + M#9 编译器可检 + D5 链路单条 audit + M#7 耦合稳定 + M#8 耦合最小。β（mutex/lock library）反 YAGNI 排除 / γ（eager load）反 M#1 lifecycle 设计意图排除。**应然 invariant sharpen**：⚓ EvolutionSystem 内部 lazy load 必原子（concurrent caller 仅触发一次 _loadState 真执行）/ 状态文件读取必单次 / 跨 retro 调用复用 promise cache。**升档条件**：Step B 落地 → row close by phase 566（α 实施） / 或 β/γ 拍板（不预期）|

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

> **整体状态**：✅ **phase411 主体落地**（main `07bc7e9f` / 3 commit fast-forward merge）/ 整模块物理建 src/core/evolution-system/ + 拆 `ContractManager.handleReviewRequest` 6 步业务 → `EvolutionSystem.runRetroForContract` + ContractSystem +`onContractCompleted` callback decoupling + Assembly 装配 wire 订阅链 + dispatch-skills const 物理迁 evolution-system/ / 4 个 design-gap 候选闭环 + 候选 5 同 phase / 剩余 §B 候选（去重 state file / retroSubagentTimeoutMs 配置）推后续 phase。

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~无独立模块 / 无工厂 `createEvolutionSystem` / 无装配端点~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ 物理建 src/core/evolution-system/ + createEvolutionSystem 工厂 + Assembly 装配（motion only）|
| ~~无事件订阅注册 / 实然 daemon 直调 `handleReviewRequest`~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ ContractManager +`onContractCompleted` callback + `_emitContractCompleted` / contract 完成路径 emit / Assembly wire `contract_completed` → `EvolutionSystem.runRetroForContract` / Daemon 不再直调 handleReviewRequest |
| audit 事件命名空间越界（RETRO_* 6 事件在 CONTRACT_AUDIT_EVENTS 而非 RETRO_AUDIT_EVENTS）| drift | ✅ phase383 清零 / SHA=fff1949 |
| ~~dispatch-skills 资源归属未落地~~ | ~~design-gap~~ | **✅ closed phase411（候选 5 同 phase 治理）**（main `07bc7e9f`）/ 物理迁 `DISPATCH_SKILLS_SUBDIR` + `DISPATCH_SKILLS_DIR` from `core/skill/skill-paths.ts` → `core/evolution-system/dispatch-skills-paths.ts` / caller (retro-scheduler / dispatch.ts / cli/commands/skill.ts) import 改 / 资源归属归 EvolutionSystem own |
| ~~缺 SkillTemplate 模型 + 持久化 + 索引 / retro subagent 输出仅由 prompt 指导 / 无解析 / 无持久化~~ | ~~design-gap / 高优~~ | ✅ closed by design reset（r60+ EvolutionSystem 不 own 模板库 / skill 内容由 retro subagent 用 write 工具写到 L2 SkillSystem 管理的 system dir / SkillTemplate 模型已不需要） |
| ~~缺去重状态文件 `.evolution-system-state.json` / 同 contractId 多次调可重复 retro~~ | design-gap | **✅ closed (phase 472 / SHA `2d4e251f`)** / r63 C fork：NEW state file `<motionDir>/.evolution-system-state.json` schema `{version, processedContractIds, lastProcessedAt}` + EvolutionSystem class 加 `processedContractIds: Set<string>` lazy load + `_loadState()` + `_saveState()` best-effort + runRetroForContract 入口 dedupe check / 出口 `'finished'` 路径 push + save / ENOENT 路径 RetroResult.status 改 `'skipped_index_missing'`（区分真 dedupe）/ 3 NEW audit (SKIPPED_DUPLICATE/STATE_LOAD_FAILED/STATE_SAVE_FAILED) / 7 NEW tests / 1369 tests PASS |
| ~~缺 `retroSubagentTimeoutMs` 配置参数 / timeout 硬编码 600 秒 / 无超时软失败 audit~~ | drift | **✅ closed (phase 472 / SHA `2d4e251f`)** / EvolutionSystemDeps +`retroSubagentTimeoutMs?: number` 默认 600000ms / RetroConfig 加同字段 / scheduleRetro 替代 hardcode `600 * 1000` |
| ~~fire-and-forget catch 块缺 `isProgrammingBug` 检（manager.ts:1378-1395 + 1398-1403）/ phase342 模式未推广至 retro 路径~~ | ~~drift（contract 异步 catch 同根扩展）~~ | **✅ closed by phase 384 / B.p347-retro-8** / r64 sweep 实测核 `evolution-system/system.ts:61` 实装 `isProgrammingBug` + `:278` 在 `retroIndexCleanup` catch 块已应用 / phase342 模式已系统级推广至 evolution-system retro 路径 |
| ~~缺 `listTemplates(filter?)` / `getTemplate(templateId)` 对外接口~~ | ~~design-gap / 高优~~ | ✅ closed by design reset（r60+ EvolutionSystem 不 own 模板查询接口 / skill 查询归 L2 SkillSystem） |
| ~~缺工厂 + 装配端点 / retro 逻辑硬绑 Motion daemon~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ createEvolutionSystem 工厂 + Assembly 装配（motion only / 按需）/ retro 逻辑迁 EvolutionSystem.runRetroForContract / Daemon 不再 own retro |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：「契约完成能力沉淀」业务语义独立 / 不与 ContractSystem（生命周期）/ MemorySystem（会话经验）共变
- **M#2 业务语义归属**：retro 触发 / prompt 构造 / 派 retro subagent / 去重 由本模块发起（~~SkillSystem.reload 协调~~ phantom 删 ε 2026-05-07 / 详 §A.dead-1）
- **M#3 资源唯一归属**：state 文件独占 / skill 内容资源归 L2 SkillSystem own / 本模块不通过自有 dir 持久化 skill
- **M#4 持久化**：state 文件落盘 / skill 资源持久化归 L2 SkillSystem
- **M#5 依赖单向**：L4 → L1 (FileSystem) + L2 (AuditLog) + L4 同层 (AsyncTaskSystem 派 retro 子代理 / ContractSystem 经 callback subscription protocol Assembly wire / 0 直 import ContractSystem)（per arch §24 表 1 + 耦合列「订阅 contract_completed 事件协议」）/ ~~SkillSystem.reload~~ phantom 删 ε 2026-05-07 / 不上引 L6+
- **M#6 依赖结构稳定**：ctor 一次注入 / 运行期不变
- **M#7 耦合界面稳定**：3 公共方法 (start / stop / runRetroForContract) + 1 type (`RetroResult` interface 详 interfaces/l4.md) 设计稳定 / 本模块不暴露 listTemplates / getTemplate 等模板库接口
- **M#8 耦合界面最小**：retro 业务对外仅 start / stop / runRetroForContract / subscribeToContractCompleted
- **M#9 显式编译器可检**：所有签名 type-only / RETRO_AUDIT_EVENTS 模块自治应然
- **M#10 不合理停下**：phase342 + phase384 isProgrammingBug 模式已推广至 retro 路径（fire-and-forget catch 治理 / evolution-system/system.ts:278）
- **M#11 边界对不上停下**：实然嵌 ContractManager.handleReviewRequest / 应然独立模块 / 显式登记治理

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：12 events 应然全覆盖（11 原 + phase 472 +3）
- **D1b 状态可观察**：state 文件可观察 / skill 资源可观察归 L2 SkillSystem
- **D1c 中断可恢复**：state 文件去重 / 重启可恢复（不重 retro 已处理 contractId）
- **D1d 事后可审计**：12 events 应然全覆盖（11 原 + phase 472 +3）
- **D2 不丢弃 / 静默**：retro 软失败 audit 留痕 / 硬错误 catch + audit 隔离
- **D3 用户可观察**：state 文件可观察 / skill 资源可观察归 L2 SkillSystem
- **D4 LLM 调用恢复**：N/A（retro subagent 内部 LLM 调用恢复归 L2 LLMOrchestrator + L3 AgentExecutor / 本模块仅派 subagent 不直调 LLM）
- **D5 日志重建**：12 events + state 文件 + L2 SkillSystem skill 文件足以重建
- **D6 子代理后不阻塞**：retro 经 AsyncTaskSystem fire-and-forget
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 3 轮 src 实测核 align）：retro 实然走 `writePendingSubagentTaskFile` (retro-scheduler.ts:65) → AsyncTaskSystem subagent-executor 同 spawn 路径 / **OS 资源继承机制完全相同**（tool instance module-level const reuse + ctx.clawDir 透传 → 同 PermissionChecker）/ retro 子代理 OS 边界 = motion OS 边界（motion 调度 retro / motion 是 caller）/ 系统调度但走智能体路径机制（不是「系统独立路径」）/ 不违此原则
- **D7 系统可信路径**：经 AsyncTaskSystem 派 retro subagent / 不绕路
- **D8 事件驱动**：subscribe contract_completed 事件 / 不轮询
- **D9 CLI 唯一外部入口**：N/A（本模块无外部入口 / Assembly 装配期 wire 订阅链 / 内部模块）
- **D10 多 claw 不隔绝**：skill 跨 claw 复用（retro 子代理 write 至 SkillSystem system dir / dispatch 经 SkillSystem 加载装配给其他 claw / 实现 Philosophy）
- **D11 motion 单向访问**：EvolutionSystem 不绑 identity / 装配方决定

#### Philosophy（4 条）

- **P1 Agent 即目录**：retro 触发对应 contract 完成后的 skill 沉淀（落 SkillSystem 管理的 system dir）
- **P2 上下文工程**：retro 沉淀的 skill 是「跨 claw 上下文复用」的核心载体
- **P3 分多个智能体加分子任务**：核心驱动原则（实现 Philosophy 「特长能力可以轻易复制过来」）
- **P4 系统为智能体服务**：触发 retro 子代理沉淀能力到 L2 SkillSystem / 让 agent 间能力复用

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：r43 A audit fork 第 6 轮验证「实然 0 落地」/ 应然先于实然 design（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：代码 phase 落地是单一意图 / 不附带其他 refactor / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 AsyncTaskSystem 实现（mock）而不动 SkillSystem caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：ContractSystem 三 design-gap 合并评估时机协调（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase324+325 / phase383 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-26 / phase324+325 应然 framing 全推（modules.md §25 注册）
- 2026-04-27 / r43 A audit fork 第 6 轮验证「实然 0 落地」+ 治理候选清单确立（10 项）
- 2026-04-27 / phase383 audit 事件命名空间越界 清零（SHA=fff1949 / RETRO_* 6 事件物理迁 RETRO_AUDIT_EVENTS）
- 2026-05-03 / phase411 整模块拆出落地（main `07bc7e9f` / 3 commit fast-forward merge / 17 files / +372 / -309）/ Step A 物理新建 src/core/evolution-system/ + git mv retro-scheduler.ts + retro-audit-events.ts from contract/ + 新建 system.ts + index.ts + ContractRetroScheduler → RetroScheduler rename / Step B 拆 ContractManager.handleReviewRequest 6 步业务 → EvolutionSystem.runRetroForContract + ContractManager +onContractCompleted callback / contract_completed event 触发 + Assembly 装配 wire 订阅链 + Daemon 删直调 handleReviewRequest / Step C 物理迁 DISPATCH_SKILLS_SUBDIR + DISPATCH_SKILLS_DIR → evolution-system/dispatch-skills-paths.ts + caller import 改 / 4 个 design-gap 候选闭环 + 候选 5 同 phase / Path #7 路径 β 第 2 phase / 模块边界重构阶段第 3 phase / 整模块拆出模板首发
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Design Principles 编号 reorder：D4 重复 D1c 改 LLM 调用恢复 N/A + D9 → D10「多 claw 不隔绝」+ 加 D9「CLI 唯一外部入口」N/A 标 align principles.md verbatim）
- 2026-05-04 / phase455 fsAsync bypass 治理（main `f619b303`）/ system.ts 3 async calls 全切 ctx.motionFs / 体量最小 / 同 phase434+436 bypass cluster 模板
- 2026-05-04 / phase463 barrel hygiene Tier 2（main `b52c1cca`）/ caller barrel-bypass 修正（cli/commands/skill.ts:13 + core/task/tools/dispatch.ts:5 改用 evolution-system/index.js barrel / barrel 已 export DISPATCH_SKILLS_*）/ M#7 耦合界面稳定 align / 同模块内 retro-scheduler.ts:14 reach 不动（合规）
- phase 384 isProgrammingBug 推广 retro 路径闭环（B.p347-retro-8）/ evolution-system/system.ts:61 + :278 retroIndexCleanup catch 块应用 phase342 模式 / fire-and-forget catch 治理 / phase342 模式系统级推广至 evolution-system retro 路径
- 2026-05-04 / phase 472 r63 C fork 去重 state file + retroSubagentTimeoutMs 配置（main `2d4e251f`）/ NEW state file `<motionDir>/.evolution-system-state.json` schema `{version, processedContractIds, lastProcessedAt}` + EvolutionSystem class 加 `processedContractIds: Set<string>` lazy load + `_loadState()` + `_saveState()` best-effort + runRetroForContract 入口 dedupe check / 出口 `'finished'` 路径 push + save / ENOENT 路径 RetroResult.status 改 `'skipped_index_missing'`（区分真 dedupe）/ 3 NEW audit (SKIPPED_DUPLICATE/STATE_LOAD_FAILED/STATE_SAVE_FAILED) / EvolutionSystemDeps +`retroSubagentTimeoutMs?: number` 默认 600000ms（10 min）+ scheduleRetro 替代 hardcode `600 * 1000` / 7 NEW tests / 1369 tests PASS
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l4_evolution_system.md vs arch §24 + 表 1/2 + interfaces/l4.md EvolutionSystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D6/D7/D8/D10/D11 + Philosophy P1-P4 / **P3 核心驱动原则** 实现「各 claw 特长能力可轻易复制」）/ 4 主能力 align arch 表 2（retro 触发事件驱动 + retro prompt 构造 + 派 retro 子代理 + SkillSystem.reload 协调）/ 4 dep + caller list（Assembly + 事件订阅源 ContractSystem）align arch 表 1 / 修 §5 events count 不一致（line 79「15」+ D1a/D1d「12」→ 实际 table 14 events / 11 原 + phase 472 +3）+ 补 phase 384 + phase 472 timeline entry / phase411 整模块拆出首发 + phase383+phase455+phase463 多里程碑稳态保留 / design only / 0 src 改
- 2026-05-07 / **L2c.G2 closure ε 联动 reload phantom 全清**（design only / 0 src）/ Path #1 实测核浮出 SkillSystem.reload 协调 = dead intent cluster：(1) EvolutionSystem.skillRegistry field declared 0 真调用 / (2) 'reload_failed' EvolutionError code dead status / (3) skill_system_reload_triggered + RETRO_RELOAD_FAILED audit events 0 真写 / (4) assemble.ts skillRegistry 传参 phantom / 实然 retro skill 走 per-execution lazy load 模式（dispatch + retro-scheduler 各 createSkillSystem(...DISPATCH_SKILLS_DIR) 临时 create instance）/ §1.做 + §1.不做 + §2.own + §1.21（implementation note）reload 协调 phantom 全删 + §A 加 A.dead-1 dead cluster 登记推 r+1 code phase 顺手清（同 phase 426 ContractManager.retroScheduler 模板）/ arch 表 2 SkillSystem reload 改 register 增量 + 表 2 EvolutionSystem reload 改 per-execution lazy load / interfaces/l2c.md G1+G2 closed 注 + 加 formatForContext method 暴露 / modules/l2_skill_system.md §B G1+G2 closed 注 / framing 推翻第 N 实证（同 phase 458 STALE + l6_watchdog A.spec-2 + 本 phase）/ Path #1 实测核浮出 hidden drift 治理模板第 N 实证（dead code orphan + dead intent 复合形态扩展）
- 2026-05-07 / phase 520 dead intent cluster 顺手清（main `f2fcabaa`）/ 3 src files / 1 commit / ~15 行 net delete / 删 EvolutionSystem.skillRegistry field + EvolutionError class + 'reload_failed' union + assemble.ts skillRegistry 传参 + index.ts re-export / tsc 0 errors / vitest 96 files 1428 tests all pass / design 同步 §A.dead-1 closed + §5 events 14→12 + §7.D milestone + §8 phantom 删 / 反向验证 3 项全过 / Path #1 实测核浮出 hidden drift 治理模板第 N+1 实证
- 2026-05-09 / phase 566 Step A D fork r68 design only / NEW §A row「A.race-state-load-atomicity」起草（lazy load 非原子 race / Path #1 实测核 system.ts:118-121 concurrent runRetroForContract 双 _loadState）/ 候选 α `Promise<void>` cache 模式 dominant 自决（28 原则 5/5 align：M#3+M#9+D5+M#7+M#8）/ 应然 invariant ⚓ EvolutionSystem 内部 lazy load 必原子 / 0 src 改 / Step B 用户实施待（system.ts ~5 行改 + tests）/ 「单实例并发 race fix」cluster 模板第 N 实证（同 phase 540 cron timeout race + phase 538 abort/cancel chain）
- 2026-05-09 / phase 566 Step B D fork r68 code（main `10270e5f`）/ **§A.race-state-load-atomicity ✅ closed**：α 落地 system.ts:58 +`stateLoadPromise: Promise<void> \| null` field + L114-115 `??= this._loadState() / await` Promise cache pattern / `stateFileLoaded` boolean 保留 fast-path skip / concurrent runRetroForContract 仅一次 _loadState 真执行 / 反向 3 项 PASS / 行为 0 差 / 与 watchdog β 同 commit / **「单实例并发 race fix」cluster N 实证完整闭环**（design+code 联动 单 phase 双 Step / 主会话 Step A + 用户 Step B 分工模板首发实证）
- 2026-05-10 / **phase 619 E fork r75 code**（起步 SHA `dfc593ce` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）/ **§A.caller-DIP-clawContractManagerFactory ✅ closed**：MotionReviewContext +1 field `clawContractManagerFactory: (clawDir, targetClaw, fs) => ContractSystem` / line 194 改 `ctx.clawContractManagerFactory(clawDir, targetClaw, clawFs)` / assembly wiring `(d, id, fs) => createContractSystem(d, id, fs, createSystemAudit(fs, d))` / 复用既有 createContractSystem factory（5 参 audit 显式注入）/ 0 NEW factory / 0 接口改（ContractSystem ctor 不动）/ 0 行为差 / α 6/6 dominant（mirror phase 609 模板）/ 业务决策性 phase 但 28 原则 6/6 dominant 自决 / 不入 J fork ratify / **「业务模块内 dynamic L1-L4 instantiation → factory injection」N=2 升格阈值过线**（phase 609 NodeFileSystem + phase 619 ContractSystem+createSystemAudit / Meta 41 候选独立 feedback / mirror caller DIP enforce 扩 dynamic resource creation 分类）/ **「caller DIP enforce N=7+ 实证累」**（phase 414b + 498 ×2 + 499 + 504 ×2 + 609 + 619）/ 同 phase 含 S2 NEW stream-events.ts module-self（async-task-system 域 / 详 l4_async_task_system §7.D）+ S3 audit critical fallback caller 层扩展 STALE 推翻（0 NEW worthy sites / phase 604 N=2 实证保持 / 推 r76+ N=3 升格）/ **「dispatch 数字 stale → reframe」第 N=4 实证累**（phase 605+587+613+619 / Meta 41 升格阈值远过）
- 2026-05-10 / phase 609 G fork r74 code（main `710c1fb5`）/ **§A.caller-DIP-clawFsFactory ✅ closed**：MotionReviewContext +1 field `clawFsFactory: (clawDir: string) => FileSystem` / line 192 改 `ctx.clawFsFactory(clawDir)` / 删 NodeFileSystem import / assembly wiring `(d) => new NodeFileSystem({ baseDir: d })` / `createSystemAudit` 不动（factory function 合规）/ `new ContractSystem` line 193 不动（推 r75+ 评估）/ 0 NEW const / 0 行为差 / Step 0 sweep `new NodeFileSystem` src 全文 31 site 分类核（业务模块内 2 真 violation 含 memory/deep-dream / 余 28 全合规：assembly 7 + factory 3 + CLI 11 + watchdog 6 + file-tool 5）/ α 6/6 dominant（vs β path 前缀重写 3/6 + γ 不动 2/6）/ 28 原则 derive: M#1+M#5+M#7+M#8+caller-DIP+YAGNI 全 align / 业务决策性 phase 但 28 原则 6/6 dominant 自决 / 不入 J fork ratify / **「caller DIP enforce N=6+ 实证累」**（phase 414b + 498 ×2 + 499 + 504 ×2 + 609 / Meta 41 升格阈值彻底过）/ **「业务模块内 dynamic L1 instantiation → factory injection」子模板首发**（mirror caller DIP enforce 扩 dynamic resource creation 分类 / 推 r75+ ≥ 2 实证升格独立 feedback）/ **「Step 0 grep scope 完整性扩 caller cascade」N+1 实证**（同 phase 598 模板）/ **「per-claw 资源 factory 注入 vs path 前缀重写」选择判据首发**

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / Philosophy P3 derive）| 各 claw 特长能力可轻易复制 / 经 EvolutionSystem 触发 retro 子代理 write 至 L2 SkillSystem + dispatch 经 SkillSystem 装配 | 应然契约一致 / 实然 0 落地 |
| KD（待编号）| EvolutionSystem 装配「按需」/ 不绑 identity | 应然契约一致 |
| KD（待编号）| skill 资源唯一归 L2 SkillSystem own / EvolutionSystem 不通过自有 dir 持久化 skill / ~~仅触发 SkillSystem.reload 协调 rescan~~ ε 2026-05-07：retro subagent 写到 `clawspace/dispatch-skills/`（per-claw clawspace） / dispatch 工具 execute 时 per-execution lazy load 加载（不经 main reload）| 应然契约一致 / dispatch-skills 资源归属未落地 治理候选（同 l2_skill_system「dispatch-skills 归属错配」） |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 代码 phase 落地后回填）：

- **工厂构造**：createEvolutionSystem + 必传 deps 注入断言
- **subscribeToContractCompleted**：Assembly 显式调 / 注册到 ContractSystem 事件订阅链 / 工厂内不静默订阅
- **事件回调路径**：contract_completed → retro_triggered audit → retro_prompt_built → 经 AsyncTaskSystem 派 retro subagent → retro_subagent_dispatched
- **去重**：同 contractId 第二次触发 → retro_skip_duplicate audit + 不派 subagent
- **能力提炼**：retro subagent 派出 + contract_completed 触发 / state 文件去重写回 / retro subagent 用 write 工具写到 `clawspace/dispatch-skills/`（per-claw clawspace）/ dispatch 工具 execute 时 per-execution lazy load 加载（**~~SkillSystem.reload 调用~~** phantom 删 ε 2026-05-07 / 详 §A.dead-1）
- **超时软失败**：retro subagent 超时 → retro_subagent_timeout audit + 不影响后续契约
- **无 skill 输出软失败**：retro subagent 无 skill 写入 → retro_no_skill_output audit + 跳过 reload
- ~~**reload 软失败**：SkillSystem.reload 调用失败 → retro_reload_failed audit + 不影响后续契约~~ ⚠ phantom 删 ε 2026-05-07 / 实然 retro skill 走 per-execution lazy load 模式（dispatch / retro-scheduler 各 createSkillSystem 临时 create instance 时 best-effort + 内部 audit / 不归本模块业务）
- **错误隔离**：单契约 retro 硬错误 catch → retro_error audit + 不冒泡
- **runRetroForContract** 测试触发路径：手动触发同事件驱动路径
- **state 文件容错**：读取失败 → 空初始状态 / 写入失败 → 调用方 catch + audit
- **审计回链**：每个 §5 RETRO_* 事件触发时机 + 载荷断言（12 events 全覆盖）
- **多实例隔离**：同 daemon 内 2 个 EvolutionSystem 实例（不同 stateDir）/ retro 状态不互通 / skill 资源跨实例合并归 SkillSystem

## phase 684 — Sub-B fan-out evolution-system design row

### B-P2.4 evolution-system _saveState 失败 silent + 不抛

- **业务决策**：retro 状态文件 save 失败时 throw vs swallow + audit
- **选项**：
  - α：throw（与 random-dream `saveRandomDreamState` line 84 对齐 / fail-loud）
  - β：**保现状**（best-effort swallow + audit / 业务可重复 retro 接受）
  - γ：throw 但 caller 加 catch fallback（具体 caller 的兜底语义需另定）
- **28 原则核**：
  - M#1 fail-loud → 倾向 α
  - 业务语义：retro 重复消费有害但非数据丢失 / dedupe 失效是次要恶果
  - random-dream throw 让 cron runner late_error 路径捕获 / evolution-system 上层 catch 层级 unclear → 推 user 核 caller 链路
- **主会话预期**：β 保现状（dedupe 失效非数据丢失 / α 改造需上溯 caller 兜底语义 / β 维持简单）
- **决策状态**：**待 user 拍板**
