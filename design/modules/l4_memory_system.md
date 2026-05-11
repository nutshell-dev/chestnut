# MemorySystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（own agent 工具的模块 / 5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) MemorySystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §23「MemorySystem 本质：智能体持久化记忆服务（dream 经验提炼 + 记忆查询）/ L4 agent 基础设施 ——『记忆』/ 设计中先不实现」加 M#1 / M#2 / M#3 / M#5 加 Philosophy P2「上下文工程」加 Design Principle「智能体是决策主体」。

### 做（应然）

应用 M#1（一个模块封装一组独立可变的职责），MemorySystem 的单一职责 = **智能体记忆服务**：

- **dream 触发**：deep-dream（per claw 经验提炼）+ random-dream（跨 claw 整合 / motion scope）
- **记忆查询**：`memory_search` 工具（agent-facing）/ 按关键词 / 时间窗 / claw 范围检索
- **记忆持久化**：dream 输出落盘 / 跨 claw 可见
- **去重协调**：避免重复 dream 同一段会话历史

### 不做（应然）

- **不做 LLM 调用主路径**（dream 内部经 L2 LLMOrchestrator）— derive 自 M#5
- **不做 dream 子代理生命周期**（归 L3 SubAgent + L4 AsyncTaskSystem）— derive 自 M#1
- **不做定时调度**（dream 触发由 L5 Cron）— derive 自 M#1
- **不做跨进程通信**（dream 结果通知归 L2 Messaging）— derive 自 M#5

## 2. 业务语义（M#2 业务语义归属）

- **own**：「智能体记忆」业务语义唯一发起点 — dream 触发 / 记忆查询 / 跨 claw 记忆共享
- **角色定位**：MemorySystem 是「**记忆基础设施**」非「**dream 执行器**」（dream 子代理实际执行）非「**调度器**」（Cron 触发）
- **装配「按需」**：motion 装跨 claw dream / claw 装 per-claw dream

## 3. 资源（M#3 资源唯一归属）

> 应然 / 待 phase 落地具体目录布局。

- dream 状态持久化（per claw + 跨 claw motion-scope 两类）
- memory 索引（待设计）
- 跨 claw 共享 memory（待设计）

## 4. 持久化（M#4）

- dream 状态落盘 / 跨重启可恢复
- memory 索引落盘
- 具体磁盘布局 / 文件格式 / 重建语义 待 phase 落地

## 5. 审计事件清单

> 事件常量**应然**集中定义于 `src/core/memory/audit-events.ts` `MEMORY_AUDIT_EVENTS`（模块自治）。

应然清单（待 phase 落地后回填具体）：
- `memory_search_invoked` / `memory_search_failed` — 查询
- `dream_triggered` / `dream_completed` / `dream_failed` — dream 主路径
- `memory_dedupe_skipped` — 去重

## 6. 层级声明

L4 agent 业务流程层（与 AsyncTaskSystem / ContractSystem / EvolutionSystem 同层 / 「智能体记忆」业务语义独立可变 / 与 EvolutionSystem 同属「经验整合」类业务：MemorySystem 整合会话经验 / EvolutionSystem 整合契约能力）。下游 Assembly（L6）通过工厂消费 + 注入 deps + Cron（L5）触发 dream。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 整模块设计中状态 / 实然部分嵌在 cron jobs（dream 系列）/ 待 phase 落地后系统化迁移。

### 7.A 必修违规

> **⚓ invariant（phase 561 sharpen）**：dream state 文件 I/O 错必 audit / 仅首启 ENOENT silent OK / parse 错 / write 错 / 其他 IO 错全 audit（违则失「重梦境」/ 违 D2 不静默 + D5 日志重建）。

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| **A.dream-state-io-silent dream state 文件 I/O silent** | drift / 中 / r68 C fork phase 561 derive | **closed by phase 561**（main `3739dc1a` / merge `6cd2b6f2`）+ **random-dream 同型扩散 closed by phase 597**（C fork r72 / main `d736738a` / merge `2c84e21a` / mirror phase 561 deep-dream 模板 / NEW const RANDOM_DREAM_ERROR / load FileNotFoundError silent + 其他 audit step=load_state / save inner try/catch + audit step=save_state re-throw / phase 561 模板未扩散反例 → r71 E fork phase 589 fan-out 浮出 → r72 C fork 兑现 / 候选 lint sister module audit pattern parity 推 r73+） | 实然 `deep-dream.ts:73-83` `loadDreamState` catch 全吞返空（FileNotFoundError / parse 错 / 其他 IO 错都 silent）/ 损坏的 state 文件 → 默默忘记所有 processedArchives → **重梦境** / `saveDreamState` writeAtomicSync 抛 raw / caller `runDeepDream` 外层 catch 吞 audit step=unexpected（粒度不足）/ 违 D2 不静默 + D5 日志重建 / **同型副发现**：`random-dream.ts:41-58` 完全 align deep-dream（dispatch P1.6「与 random-dream 不一致」claim 经 Path #1 实测 STALE / 真问题 = 两者同根 silent X）/ **本 phase scope 限 deep-dream**（避 scope creep）/ random-dream 同 drift 推 r+1 followup phase 单独闭。**phase 561 决策（28 原则核 5/5 一致 dominant 自决）**：(load) 区分 FileNotFoundError silent vs 其他 audit `DEEP_DREAM_ERROR step=load_state` + 返空 resilient（首启 OK / 损坏可观察 + 自愈）/ (save) inner try/catch + audit `DEEP_DREAM_ERROR step=save_state` 后 re-throw（保 caller flow + 加粒度）/ ζ 复用 `DEEP_DREAM_ERROR` const + step= context（0 NEW const / 与既有 step=call_1/call_2/unexpected 模型 align / phase 541 silent X cluster 模板 align M#7+M#8 收益）|
| **A.dream-session-retry-storm deep-dream sessionFile JSON.parse silent + retry-storm** | drift / 中 / r72 C fork phase 597 derive | **closed by phase 597**（main `d736738a` / merge `2c84e21a`）| 实然 `deep-dream.ts:191-196` `try { JSON.parse(...) } catch { console.warn(...); continue; }` silent + 损坏 archive 永不进 processedArchives → 下周期 discoverUnprocessed 仍发现 → catch 同样 retry → **每周期重试同一损坏 archive**（retry-storm 隐患 / 浪费 LLM call + cron cycle）/ 与 line 198-201 空 session 模式不一致（空 session push processedArchives 永标记 / 损坏 archive 不 push）/ 违 D2 不静默 + D5 日志重建 + M#10 不合理停下（资源消耗）。**phase 597 决策（28 原则核 5/5 一致 dominant 自决）**：α catch (err) → audit `DEEP_DREAM_ERROR step=read_session` + `if (sf.filename !== 'current.json') processedArchives.push(sf.filename)` 强制永标记跳过（mirror line 198-201 空 session 模式 align）/ 0 NEW const（复用 DEEP_DREAM_ERROR + step=read_session 子场景 align phase 541 模板 M#7+M#8 收益）/ β 内存 backoff 引入 D4 持久化违反 reject / γ 删损坏文件违 D1 信息不丢失 reject / current.json 损坏当日仍 retry 是 known limitation（极少 corrupt / r+1 评估 currentSessionDreamedDate=today 跳过 / out-of-scope）|
| **A.spec-1 应然 stub「设计中, 先不实现」 stale ↔ 实然部分实施** | spec drift / 中 | **closed**（phase414c L4 audit / interfaces/l4.md 升级 stub → 部分实施状态描述）| 应然原 interfaces/l4.md MemorySystem 节写「整体状态 = 设计中, 先不实现 / 详细设计登记见 modules/l4_memory_system.md (设计中 stub)」/ 实然 phase318 (main `5f6b689`) 已实施 `class MemorySystem` + ctor 注入 + `runDeepDream(maxCompressionTokens?)` + `runRandomDream()` + `createMemorySystem` factory + standalone `runDeepDream` / `runRandomDream` 函数 + memory_search 工具 (cross-layer location `src/core/tools/builtins/memory_search.ts`) / 应然 stub 早 phase318 落地后已 stale / phase414c interfaces/l4.md 修订升级 stub → align 实然部分实施状态 + 暴露未实施部分（去重状态 + 业务 spec 细节）|
| **A.location-1 memory_search 工具 cross-layer location** | location drift / 中 | **✅ closed**（phase416 / main `0ff29848`）| 实施落地：`src/core/tools/builtins/memory_search.ts` → `src/core/memory/tools/memory_search.ts` (git mv 保 history) + Assembly register caller 改为 MemorySystem 装配期 register / 测试文件同步迁 / phase360 done 物理迁模板复用 / 物理迁三模板复合第 5 实证 |
| **A.bypass-1 MemorySystem random-dream + deep-dream 直 import `node:fs`** | M#5 弱违反 / 中 | **✅ closed**（phase455 / main `f619b303`）| L4 MemorySystem 2 file 直 import OS API 绕 FileSystem L1 / 21 fsNative calls 全清：(1) `random-dream.ts` 12 calls (readFileSync / writeFileSync / existsSync / readdirSync / statSync) → `fs.{readSync, writeAtomicSync, existsSync, listSync, statSync}` + 5 helper 加 fs 参 cascade（loadRandomDreamState / saveRandomDreamState / computeWeight / discoverWeightedContracts / waitForTaskResult）+ `RandomDreamOptions` 加 motionFs 字段 / clawforumFs 用 opts.fs (2) `deep-dream.ts` 9 calls 同型替换 / 5 helper 同型 cascade / per-claw `new NodeFileSystem({baseDir: clawDir})` 实例化（同 phase434 evolution-system 模式 / phase430 cross-baseDir hidden bug 教训复核）/ 行为 0 改 / 同 phase434+436 bypass cluster 模板 |
| **A.caller-DIP-clawFsFactory deep-dream.ts:303 业务模块内裸 new NodeFileSystem** | DIP drift / 中 / r74 G fork phase 609 derive | **✅ closed by phase 609**（main `710c1fb5` / merge）| **触发**：r74 fs 深耕 fan-out 副发现 + Step 0 sweep `new NodeFileSystem` src 全文 31 site 分类核（业务模块内 2 真 violation：本模块 + evolution-system / 余 28 全合规）。**实然偏离**（r74 fan-out verified）：`deep-dream.ts:303` `const clawFs = new NodeFileSystem({ baseDir: clawDir })` runDeepDream for-loop per-claw 迭代构 L1 impl / 违 M#5 单向依赖（L4 业务直 import L1 impl）+ M#7 耦合界面稳定 + M#8 最小耦合 / phase 455 时保留作 bypass cluster 收尾权宜（per-claw clawFs 实例化）/ phase 609 DIP enforce 模板成熟后正式治理。**phase 609 决策（28 原则核 6/6 dominant α factory 注入 vs β path 前缀重写 3/6 + γ 不动 2/6）**：DeepDreamOptions + MemorySystemOptions 各 +1 field `clawFsFactory: (clawDir: string) => FileSystem` / line 303 改 `opts.clawFsFactory(clawDir)`（factory call 移入 try/catch 保 per-claw error isolation）/ 删 NodeFileSystem import / memory/system.ts cascade `runDeepDream` 调用传 factory / assembly wiring `(d) => new NodeFileSystem({ baseDir: d })` / 0 NEW const / 0 行为差。**runRandomDream 不入本 phase**（grep 0 命中 `new NodeFileSystem` / 推 r75+ sweep 评估）。**caller DIP enforce N=6+ 实证累**（phase 414b + 498 ×2 + 499 + 504 ×2 + 609 / 升格阈值彻底过）|

### 7.B 偏差登记

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~整模块设计中 / 实然 0 落地~~ | ~~design-gap~~ | **部分闭环**：phase318（main `5f6b689`）模块壳 + 工厂 + dream 物理迁 / **phase412**（cross-layer port + @module 注释修）/ 业务实装（runDream / memory_search）推后续 design phase（spec 业务细节待决策）|
| dream 系列双重归属（cron 触发 + memory 业务）| design-gap / 双重归属保留 | 同 l5_cron A.1 ⚓ accepted-stable |
| ~~random-dream cross-layer~~ ✅ closed | drift / 中 | **✅ closed**（phase424 / main `2bab8042`）| **phase412 错治理反向 + 真合规落地**：删 TaskLifecyclePort interface (runtime-ports.ts:83-94) + 5 caller 直 dep AsyncTaskSystem class (memory/system + memory/random-dream + runtime + task/tools/dispatch + tests/core/cron/random-dream) / 同层 L4 → L4 单向完全合 M#5 / 同 phase422 WatchdogPort STALE 推翻模板（port pattern reversal 第 2 例 / cluster 6 port 闭 2）/ feedback_governance_workaround_smell 真合规设计落地 |
| 缺 memory_search 工具 + 索引 | design-gap | 高优 / 与 dream 整合同 phase |
| 缺去重状态文件 | design-gap | 中 |
| **B.G1-r69 clawsSeen 空 Set / 新 claw bonus 退化** | logic bug / 中 | **✅ closed by phase 585**（B fork r70 / α 落地 / phase 582 G ratify → phase 585 code phase）| `random-dream.ts:134` clawsSeen 永远空 / line 89 `!clawsSeen.has(clawId)` 永远 true / +30 bonus 退化为常态加成 / line 150 注释承认应实现但从未 / **α 内层循环 computeWeight 后 clawsSeen.add(clawId)** 已落地（phase 585）/ 行为差：每 claw 首契约获 +30 / 后续 0 bonus / 不同 claw 各获首 bonus 真生效 / P2「上下文工程」+P3「高效利用上下文窗口」derive 跨 claw 差异化有价值 + D2 derive 当前非显式设计决策（bug）/ design report `coding plan/r69/G/G.1` + code phase `coding plan/phase585/` |
| **B.random-dream-pulse-strategy** random-dream waitForTaskResult pulse 策略 + opts 暴露 | drift / 中 / r72 G fork phase 599 ratify 标 ⚓11 部分可决 排除 / r74 J fork 登记 / **phase 622 ratify refine** / **closed by phase 633 (r77 C fork) / 真 α 实施** | ✅ **closed by phase 633（α dominant / 真实施 / main `92b99776` / merge `bc7128f7`）** | **真 α 实施**：waitForTaskResult sig 扩 `audit?: AuditLog` + `auditEnabled = false` 参数 + RandomDreamOptions 加 NEW 2 field（`pulseIntervalMs?: number` + `pulseAuditEnabled?: boolean`）+ NEW 1 const `RANDOM_DREAM_PULSE: 'cron_random_dream_pulse'` 加 audit-events.ts / per-pulse audit opt-in（pulseAuditEnabled default false 防 audit noise）/ runRandomDream function jsdoc 加 design intent / 4 audit per invocation 保留（既有 step=skip_empty/scheduled/subagent_started/finished）/ NEW 1 unit test cover 默认 + audit emission / β fs.watch + γ exponential backoff rejected per phase 622 28 原则核 / **修正**：起步 Path #1 实测 ⚓11 既有覆盖 ~30%（waitForTaskResult pollIntervalMs=30_000 硬编码 + 0 per-pulse audit）/ 非 β reframe 0-NEW 场景 / 真 α 实施需要 NEW field + NEW const / **「dispatch claim 实测 100% reframe → phase 内修正」首发**（升 phase 自身 reframe 实证 / per `feedback_dispatch_number_stale_path1_reframe` 元层应用）/ **「principle-derived ratify cluster 三阶段链路」N=4 实证**（599→622→628→633 / 与 l5_runtime §B.outbox-error-response-strategy ⚓2 β reframe 异质双 row close 同 phase） |
| **B.dream-prompt-trust-boundary** dream sub-agent log 输出 `[DREAM_OUTPUT contract_id="x"]content[/DREAM_OUTPUT]` 块经 random-dream.ts:215 regex 提取 → 直投 motion memory contract / 0 contract owner 校验 / 0 sanitize / 0 source attribution | **✅ closed by phase 565 / γ ⚓ accepted-stable**（用户主动提议「看看原则能否指导决策」+ 提供 Philosophy + Design Principles + Module Logic Principles 全文 → 主会话原则严格 derive dominant γ）| **closed by phase 565（Philosophy 4/4 + ML 8/11 + DP 7/11 + phase 502 §A.invariant-3 anchor 派生）**：γ ⚓ accepted-stable closed。**phase 502 §A.invariant-3 anchor 派生**「SubAgent class = L3 原语 / caller 是 L4 业务模块 / SubAgent 是 caller 延伸」→ dream sub-agent caller = motion claw（cron 触发 motion 的 random-dream / motion fs 写 motion contracts）→ sub-agent = motion 延伸 → sub-agent 写 motion contract = motion 自己写 / 0 跨 claw 写路径。**Philosophy 4/4 全 align**：智能体继承 OS 资源（sub-agent 继承 motion OS 权限）+ Agent 即目录（agent 身份 ≡ motion 目录配置）+ 多 claw 不隔绝（dream 写 motion 自己的 contract 不破隔绝立场）+ 上下文工程（dream 输出 = motion 自己整合的上下文）。**D7 align**「智能体是决策主体 / 系统内部走可信路径」→ sub-agent 走可信路径 / 不需 sanitize / 不需身份校验。**M#1+M#2 业务语义归属**：contract owner 校验（如真需）非 MemorySystem 责任 / 应归 ContractSystem 自决 own。**β 推 r69+ ContractSystem 独立 phase**：β（ContractSystem owner 校验）业务方向决策性（owner 校验是否成 ContractSystem invariant 属 ContractSystem 自决 / 不归 MemorySystem）/ contract.creator field 已存在 / 实施成本小但需 ContractSystem 整体业务决策（适用于所有 contract 写入 / 不仅 dream）/ 推 r69+ ContractSystem 独立 phase 含 contract creator 跨 caller 全核前置。 ~~open / 待用户拍板（r67 G fork phase 554 起草）~~ | **触发**：r66 G fork 副 + r67 ⚠️ 新 unverified review。**Path #1 实测核**：random-dream.ts:185-200 motionFs.readSync(daemon.log) + line 215-220 regex 提 `[DREAM_OUTPUT]` 块 → contract_id + content 由 sub-agent 全控制 / sub-agent 走 AsyncTaskSystem.writePendingSubAgentTask 路径（同 D6.1 OS 资源继承机制）。**候选**：(α) sub-agent 输出全 sanitize（escape `[DREAM_OUTPUT]` lookalike）— **反 Philosophy P3**（sub-agent 受信智能体不应额外 sanitize）/ ML 4/11 / 排除候选；(β) ContractSystem 加 contract owner 校验（dream 写 contract 前查 creator / 仅自己可写自己的 contract）— ML 7/11 + DP 8/11 align（M#1+M#11+D1d+D7）/ **业务决策推 r68+ ContractSystem phase 独立**（不归 MemorySystem own）；(γ) trust boundary 显式登记 motion 整体 trust / dream sub-agent 由 motion 调度 / 0 src 改 / row ⚓ accepted-stable — Philosophy 4/4 全 align / ML 5/11 弱 / DP 6/11 / **dominant 自决候选**；(δ) dream 不投 contract — **反 P2 上下文工程**（dream 输出失去 memory 业务价值）/ 排除。**dominant**：γ Philosophy 4/4 + Philosophy「智能体继承 OS 权限 + claw 不隔绝 + Agent 即目录」3/4 直接 align / β 业务决策推 ContractSystem 独立。**拍板待**：用户拍板 (1) γ + β 复合 → γ MemorySystem ⚓ stable + β 推 ContractSystem r68+ phase / (2) γ only → MemorySystem ⚓ stable / 关闭 contract owner 校验讨论 / (3) β only → 拒绝 γ Philosophy 立场 → 升档 contract owner 校验。**升档条件**：γ 拍板 → ⚓ accepted-stable / β 拍板 → r68+ ContractSystem owner 校验 phase（owner 已存在 contract.creator field 仅写时校验 / 实施成本小）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- M#1 独立职责：「智能体记忆」业务独立 / 不与 EvolutionSystem 共变
- M#2 业务语义：dream 触发 / 记忆查询由本模块发起
- M#3 资源：dream state + memory 索引独占
- M#4 持久化：dream 状态落盘 / memory 索引落盘
- M#5 单向：L4 → L1 (FileSystem) + L2 (LLMOrchestrator / Messaging / AuditLog / ToolProtocol) + L4 同层 (AsyncTaskSystem — dream 子代理 fire-and-forget)（per arch §23 表 1）/ 不上引 L5+
- M#6 结构稳定：ctor 一次注入
- M#7 界面稳定：待 phase 落地稳定
- M#8 界面最小：memory 业务对外仅 dream + search 入口
- M#9 编译期可检：所有签名 type-only
- M#10 不合理停下：当前嵌 cron jobs 是冻结期妥协 / 设计中
- M#11 边界对不上停下：实然嵌 cron / 应然独立模块 / 显式登记

#### Design Principles（11 条）

- D1a-d 信息 / 状态 / 中断 / 审计：dream 状态文件 + audit events 全覆盖（应然）
- D2 不丢弃：dream 失败 audit 留痕
- D6 子代理不阻塞：dream 经 AsyncTaskSystem fire-and-forget
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 3 轮 src 实测核 align）：random_dream 实然走 `taskSystem.writePendingSubAgentTask` (random-dream.ts:240) → AsyncTaskSystem subagent-executor 同 spawn 路径 / **OS 资源继承机制完全相同**（tool instance module-level const reuse + ctx.clawDir 透传 → 同 PermissionChecker）/ random_dream 子代理 OS 边界 = motion OS 边界（motion scope / motion 调度 / motion 是 caller）/ 系统调度但走智能体路径机制 / 不违此原则。**例外 deep_dream**：直 `llmService.call(...)` 处理 dialog archive 文本 / 不创 SubAgent / N/A 不在本继承范围
- D8 事件驱动：Cron 触发 / 不轮询
- D9 多 claw 不隔绝：跨 claw memory 可见

#### Philosophy（4 条）

- P1 Agent 即目录：dream 输出落对应 agent 目录
- P2 上下文工程：**核心驱动原则**（memory 是上下文压缩+复用的核心机制）
- P3 分多个智能体加分子任务：跨 claw memory 共享
- P4 系统为智能体服务：memory_search 工具让 agent 检索过往经验

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-26 / phase318 MemorySystem 模块化（main `5f6b689`）/ createMemorySystem 工厂首立 + 4 文件搬迁（dream + audit-events + system + index）+ N1 LLM 注入修复 / modules.md 27/27 应然 100% / 模块壳基础设施
- 2026-05-03 / phase412 cross-layer port 治理 + @module 注释修（main `2be01261`）/ TaskLifecyclePort 扩 +1 writePendingSubAgentTask method + AsyncTaskSystem 实装 thin wrapper + SubAgentTaskInfo 新 export + random-dream 改调 + @module L5 → L4 修 + 测试 mock 完整 TaskLifecyclePort（6 method）/ 候选 9 random-dream cross-layer 闭环 / 候选 1 部分闭环（业务实装 runDream / memory_search 推后续 design phase）/ 候选 4 dream 双重归属 ⚓ accepted-stable（同 l5_cron §A.1 / 不消解）/ Path #7 路径 γ 第 4 phase / 模块边界重构阶段第 4 phase / ~~port pattern 第 N+1 次复用~~ ⚠ STALE 2026-05-03 推翻：同层单向 over-engineering / 详 feedback_governance_workaround_smell
- 2026-05-03 / phase424 TaskLifecyclePort STALE 推翻（main `2bab8042`）/ 删 TaskLifecyclePort interface (runtime-ports.ts:83-94) + caller 5 处直 dep AsyncTaskSystem class（同层单向合 M#5）+ 测试 mock partial cast / port pattern reversal 第 2 例（phase422 第 1 / cluster 6 闭 2）/ feedback_governance_workaround_smell 真合规落地 / 对应 §B random-dream cross-layer → ✅ closed
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ 头 docblock 加 §10 声明 align own-tool 模块标准 / 加 §10 工具通道 stub 节 5 维度待 phase 落地填）
- 2026-05-04 / phase455 fsNative bypass 治理（main `f619b303`）/ random-dream + deep-dream 21 calls 全切 FS abstraction / 5+5 helper 加 fs 参 cascade / per-claw NodeFileSystem 实例化模式（cross-baseDir 显式）/ phase430 cross-baseDir hidden bug 教训复核
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l4_memory_system.md vs arch §23 + 表 1/2/3 + interfaces/l4.md MemorySystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D6/D8/D9 + Philosophy P1+P2+P3+P4 / P2 上下文工程核心驱动原则）/ 3 主能力 align arch 表 2（deep dream + random dream + 记忆查询）/ 6 dep + 资源「dream 状态持久化两类」align arch 表 1 / memory_search 工具 align arch 表 3 / phase318 模块化 + phase412 cross-layer + phase424 TaskLifecyclePort STALE 推翻 + phase455 bypass + 2026-05-04 cross-doc audit drift 修订多里程碑稳态保留 / 业务实装 stub（runDream / memory_search 业务 spec）推后续 design phase / design only / 0 src 改
- 2026-05-08 / phase 554 G fork r67 design only / 起草新 §B row「B.dream-prompt-trust-boundary」/ 0 src 改 / open 待用户拍板 / 候选 γ Philosophy trust boundary 显式登记 dominant 自决候选 + β ContractSystem owner 校验业务决策推 r68+ 独立 / dispatch 5 项 stale ratio 40%（r66+r67 累 N+1 实证）/ phase 545 G fork r66 design only 单 Step 模板第 N 实证累
- 2026-05-09 / phase 565 G fork r68 design only / **§B.dream-prompt-trust-boundary closed by γ ⚓ accepted-stable**（用户主动提议「看看原则能否指导决策」+ 提供 Philosophy + Design Principles + Module Logic Principles 全文 → 主会话原则严格 derive 后 γ Philosophy 4/4 + ML 8/11 + DP 7/11 dominant 自决 / phase 502 §A.invariant-3 anchor「SubAgent = caller 延伸」派生：dream sub-agent 由 motion 调度 → motion 延伸 → 写 motion contract = motion 自己写 / β（ContractSystem owner 校验）业务方向决策性 / 推 r69+ ContractSystem 独立 phase 含 contract creator 跨 caller 全核前置）/ **phase 554 起草 + phase 560 reaffirm + phase 565 close 三阶段闭环模板首发** / 「业务决策性 design-gap → 原则 derive → dominant 自决」累 N=9（520+521+522+531+537+542+545+554+565）/ 「Philosophy + Design Principle + Module Logic 三层 cross-check + phase 502 anchor 派生」组合 derive 模板
- 2026-05-09 / phase 560 G fork r68 design only / **reaffirm §B.dream-prompt-trust-boundary** still open / 待用户拍板 / Path #1 实测核 random-dream.ts:185-220 路径 phase 554 后未变（regex extractDreamOutputs + writePendingSubAgentTask 是 dream 输出 → contract 唯一 entry）/ contract.creator field 已存在（types/contract.ts）/ β 候选实施成本仍小 / dispatch 3 项 stale ratio 33%（§B.7 STALE 推翻 closed by phase 558 Step D / r66+r67+r68 累 N=6 实证 / 541+543+544+554+556+560）/ 副发现：contract creator 跨 caller 全核推 r69+（β 候选实施前置）/ **「phase N 起草 → phase N+M reaffirm」模板首发**（design only / 业务决策跨多 r 待拍板时主会话定期 reaffirm + 加深 cross-check 不重 derive）/ 「design closure phase 单 Step A 形态」累 N=5（503+505+545+554+560）
- 2026-05-09 / **phase 585 random-dream clawsSeen α 落地（B fork r70）**（main `2504262a`）/ phase 582 G.1 design ratify α dominant code phase 落地：random-dream.ts:147 内层循环 computeWeight 后加 `clawsSeen.add(clawId)` / 修 `clawsSeen` Set 永远空 → +30「新claw」bonus 退化为常态加成 → 跨 claw 多样性失效 真 logic bug / 行为差：每 claw 首契约获 +30 / 后续 0 bonus（design 锁 P2「上下文工程」+ P3「高效利用上下文窗口」+ D2 真生效）/ 注释 line 150「排序时更新」过时清 sharpen / firstSeenClaws hint display 独立 0 改 / NEW test 同 claw 多契约 hint 差异化 black-box（aHints.length === 1 invariant）/ 既有 tests 0 影响 / 0 NEW const / Path #1 dispatch 5/5 真 / **「直觉 bug → phantom」反命题第 4 实证累**（phase 557 4/4 + 564 5/5 + 578 4/4 + 585 5/5 / 升格独立 feedback 阈值远超）/ **「G fork ratify → r+1 code phase 落地」N+1 实证累**（phase 582 G.1 → 585）/ **真 logic bug 修复（注释 ack 实施 forget 模式）** / §B B.G1-r69 ✅ closed by phase 585
- 2026-05-10 / phase 609 G fork r74 code（main `710c1fb5`）/ **§A.caller-DIP-clawFsFactory ✅ closed**：DeepDreamOptions + MemorySystemOptions 各 +1 field `clawFsFactory: (clawDir: string) => FileSystem` / deep-dream.ts:303 改 `opts.clawFsFactory(clawDir)`（factory call 移入 try/catch 保 per-claw error isolation）/ 删 NodeFileSystem import / memory/system.ts cascade `runDeepDream` 调用传 factory / assembly wiring `(d) => new NodeFileSystem({ baseDir: d })` / 0 NEW const / 0 行为差 / α 6/6 dominant（vs β path 前缀重写 3/6 + γ 不动 2/6）/ 28 原则 derive: M#1+M#5+M#7+M#8+caller-DIP+YAGNI 全 align / Step 0 sweep `new NodeFileSystem` src 全文 31 site 分类核（业务模块内 2 真 violation 含 evolution-system/system.ts:192 / 余 28 全合规）/ runRandomDream 不入本 phase（grep 0 命中 / 推 r75+ sweep）/ 业务决策性 phase 但 28 原则 6/6 dominant 自决 / 不入 J fork ratify / **「caller DIP enforce N=6+ 实证累」**（phase 414b + 498 ×2 + 499 + 504 ×2 + 609 / Meta 41 升格阈值彻底过）/ **「业务模块内 dynamic L1 instantiation → factory injection」子模板首发** / **「per-claw 资源 factory 注入 vs path 前缀重写」选择判据首发** / 与 evolution-system §A.caller-DIP-clawFsFactory 同 phase cluster 闭
- 2026-05-10 / **phase 622 r74 J fork 5 ⚓ design ratify cluster（B fork r75 / single design phase / cross-cutting same-day）**（main `<sha 待 commit 后填>`）/ §B.random-dream-pulse-strategy ⚓11 phase 622 ratify refine / 业务方向决策性 / ⚓ pending user binary（默推 α audit + opts 暴露）/ 28 原则 derive：α D5 observability + caller 可控 + YAGNI + M#7 opts 加 field / β M#3 单实例精度 + 性能优 但 fs.watch 兼容性 risk + M#7 接口大改 / γ D2 软降级 + 自适应 但加 max 字段反 YAGNI + M#7 字段扩 / 主登记 l2_llm_orchestrator §B 3 row（⚓4+⚓5+⚓8 dead class closed）+ l5_runtime §B.outbox（⚓2 默推 α）+ l1_llm_provider 关联 ⚓8 / **「principle-derived ratify」N=3 实证升格阈值过线**（phase 599+603+622 / Meta 41 加成）/ **design only 单 Step 内联模板第 9 实证累**
- 2026-05-10 / **phase 633 J fork ⚓11 random-dream-pulse-strategy 真 α 落地**（C fork r77 / 三阶段链路第 4 实证 / main `92b99776` / merge `bc7128f7`）/ random-dream.ts: runRandomDream function jsdoc 加 design intent + waitForTaskResult sig 扩 `audit?: AuditLog` + `auditEnabled = false` 参数 + RandomDreamOptions 加 NEW 2 field（pulseIntervalMs? + pulseAuditEnabled?）+ memory/audit-events.ts NEW 1 const RANDOM_DREAM_PULSE / per-pulse audit opt-in（default false 防 audit noise）/ NEW 1 unit test cover 默认 + audit emission / **修正**：起步 Path #1 实测 ⚓11 既有覆盖 ~30%（waitForTaskResult pollIntervalMs 硬编码 + 0 per-pulse audit / 4 audit 是 per invocation 不是 per poll）/ 非 β reframe 场景 / **真 α 实施** / §B.random-dream-pulse-strategy closed by phase 633 / **「principle-derived ratify cluster 三阶段链路」N=4 实证累**（与 l5_runtime §B.outbox-error-response-strategy 双 row close 同 phase / ⚓2 β reframe + ⚓11 真 α 实施 / 双 fork 异质实施）/ **「dispatch claim 实测 100% reframe → phase 内修正」首发模板**（升 phase 自身 reframe 实证累 / per `feedback_dispatch_number_stale_path1_reframe` 元层应用）

### 7.E 关键决策映射

待编号。

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 待 phase 落地后回填）：

- dream 触发路径 / 去重 / 错误隔离
- memory_search 工具调用 / 索引查询
- 跨 claw memory 可见性
- dream 失败软失败

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile 准入+不变量）derive 自 architecture.md 表 3。
> MemorySystem own 的 agent 工具：memory_search（L4）。
> **设计中状态** — 业务 spec 待后续 design phase 落地 / 本节先承诺意图与边界 / 具体 schema + 文案待填。

### 10.1 memory_search

**【1. 用途】**

> **持久化记忆查询通道** — agent 检索过往会话经验提炼出的记忆条目（dream 输出）/ 跨 claw 可见 / 是上下文工程 P2 的核心机制（让 agent 不需重新发现已知经验）。

**设计意图**：
- caller 心智 = 「找以前 dream 出来的经验」
- read-only / 不改变记忆状态 / 安全调
- 默认走当前 claw 视角 + 跨 claw motion-scope 共享记忆（应然待 phase 决策）

**【2. 入参 schema（应然 silent on 字段集 / 待 phase 落地）】**

```
- query  (string, required)   关键词或自然语言查询
- (其他字段：时间窗 / claw 范围 / topK 等待 phase 决策)
```

**【3. 返回语义】**

```
ToolResult { success: boolean, content: string }
```

- 成功：记忆条目摘要列表（按相关度 / 时间排序 / 含来源 dream ID）
- 失败：success=false / content = error message
- 0 命中：success=true / content = 显式空结果文案（non-empty 返）

**【4. 副作用 + 跨通道影响】**

- **0 副作用**：read-only / 0 fs 写 / 0 inbox / 0 LLM 调
- **跨通道**：经 ToolRegistry 注册（phase416 物理迁后归 MemorySystem own register）/ 工具调用 audit 由 L2 Tools 框架 `tool_exec` 覆盖 + 业务级 `memory_search_invoked` / `memory_search_failed`（待 phase 落地）

**【5. profile 准入 + 不变量】**

profile 准入（应然待 phase 决策 / 当前应然意图）：
- ✓ `full`（motion + claw 主代理）含 memory_search
- ✗ `subagent` / `miner` / `verifier` / `dream` 不含（disposable / 不需自我记忆查询 / dream 自身在产生记忆 / 不消费）

不变量：
- **read-only**：execute 0 修改任何记忆 state / 0 触发 dream
- **跨 claw 可见**：motion-scope 共享记忆对所有 claw 可见（应然 D10「多 claw 不隔绝」）
- **失败软返**：单源（如某 claw memory 损坏）失败软降级 / 返 partial + warning（同 status_service collect 模式）

## phase 684 — Sub-B fan-out random-dream design row

### B-P2.3 random-dream load 失败 isolate vs DialogStore 不对称

- **业务决策**：是否对 random-dream state corrupt file 走 `.corrupt-{ts}` isolate（mirror DialogStore + watchdog-state 模板）
- **选项**：
  - α：补 isolate（与 DialogStore + watchdog-state 对称 / 取证可追溯）
  - β：**保现状**（dream state 是幂等推荐结果 / 0 数据资产 / 第一次 corrupt 后下次 save 直接覆盖 OK）
  - γ：load 端不变 + save 端加 schema validation throw（防写脏 / 但读端兜底 resilient）
- **28 原则核**：
  - M#1 fail-loud → 微偏 α（暴露 corrupt 状态）
  - D#资源每种唯一模块 / dream state 仅幂等推荐结果 → β acceptable
  - YAGNI（dream state 0 取证需求）→ β
- **主会话预期**：β 保现状（dream state 幂等可重生 / α gain ≈ 0 / β 维持简单）
- **决策状态**：**待 user 拍板**

### B-P2.13 DialogStore archive UUID 8 hex collision

- **claim**：archive filename `${ts}_${uuid8}.json` / 8 hex 32 bit / 同 ms 多 archive 概率近 0 / archive manual 频率低
- **状态**：C3 STALE phantom
- **结论**：closed by phase 684 / 0 实测 risk / Y2K38 前 OK / 不 land
