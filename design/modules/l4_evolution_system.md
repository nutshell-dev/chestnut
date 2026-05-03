# EvolutionSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) EvolutionSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §24「EvolutionSystem 本质：能力进化服务 / L4 agent 基础设施 ——『契约复盘』」加 M#1 / M#2 / M#3 / M#5 / Philosophy「各个 claw 的特长能力可以轻易复制过来」加 Design Principle「智能体是决策主体」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），EvolutionSystem 的单一职责 = **实现 Philosophy 「各个 claw 的特长能力可以轻易复制过来」的核心机制**：

- **订阅 contract 完成事件**：EvolutionSystem 是 subscriber / ContractSystem 是 publisher / 装配期 Assembly 显式订阅链 / 不工厂内静默
- **派 retro 子代理提炼能力**：经 TaskSystem 派 retro subagent / 不持 SubAgent 类引用 / 不 `new SubAgent`
- **去重协调**：同 contractId 已 retro 跳过（state 文件 `.evolution-system-state.json` 记录）
- **SkillSystem.reload 协调**：retro 子代理用 write 工具写到 L2 SkillSystem 管理的 system dir / 本模块只调 SkillSystem.reload 触发 rescan
- **错误隔离**：单契约 retro 失败不影响后续契约（try/catch + audit）

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) EvolutionSystem 节。具体实现细节（subscribeToContractCompleted / runRetroForContract / dedupeByContractId / triggerSkillSystemReload / EvolutionSystemOptions 等）的存在依据是「事件驱动 + retro 子代理派发 + 去重 + SkillSystem.reload 协调」原语 — 实然采纳的细节差异等登记 §7.B。

### 不做

- **不做 contract 生命周期管理**（归 ContractSystem）— derive 自 M#1 + M#2
- **不发布 contract_completed 事件**（EvolutionSystem 是 subscriber / ContractSystem 是 publisher）— derive 自 M#3
- **不直接 `new SubAgent`**（必须经 TaskSystem 派 retro subagent）— derive 自 M#1 + M#5
- **不构造 LLMOrchestrator**（归 Assembly 注入）— derive 自 M#5
- **不做技能装配**（dispatch 工具读 SkillSystem 加载 system skill 装配 / 本模块只负责触发加去重加 reload 协调）— derive 自 M#1
- **不强约束模板 schema**（提炼内容由 retro subagent 决定）— derive 自 M#2
- **不跨实例合并状态**（每个实例自有 stateDir 加 retro 状态文件 / 不预设全局合并；skill 资源跨实例合并归 SkillSystem）— derive 自 M#3
- **不 own skill 内容存储**（skill 资源 own 在 L2 SkillSystem，retro 子代理用 write 工具写到 SkillSystem 管理的 system dir）— derive 自 M#3
- **不 own skill 写入接口**（skill 写入由 agent 用 write 工具完成，本模块不暴露 writeSkill 接口）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），EvolutionSystem 的业务语义边界：

- **own**：「契约完成后能力沉淀」业务语义唯一发起点：retro 触发 / prompt 构造 / 派 retro subagent / 去重 / SkillSystem.reload 协调（skill 内容由 retro subagent 用 write 工具写到 SkillSystem 管理的 system dir，本模块不 own skill 资源加 skill 查询接口）
- **角色定位**：EvolutionSystem 是「**契约完成事件订阅者 + retro 子代理派发器**」非「**能力提炼器**」。能力提炼由 retro 子代理实际执行（agent 决策）/ 本模块只协调触发加去重加 reload。
- **装配「按需」**：不绑死 motion 独占 / 不绑死 claw 独占 / 一个 daemon 内可装多个实例（隔离不同来源 retro 触发逻辑）
- **事件驱动**：装配期由 Assembly 注册到 ContractSystem 的 `contract_completed` 事件订阅链 / 显式订阅（非工厂内静默）
- **单契约 retro 失败不影响后续契约**（错误隔离 / try/catch + audit）

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），EvolutionSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<stateDir>/.evolution-system-state.json` 已 retro 过 contractId 列表（去重用） | 持久化（独占） | ✓ |

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），EvolutionSystem 的持久化立场：stateDir 磁盘是权威 / 无长驻内存 / 事件回调按需读 state / 处理完写回 / retro subagent 调度后不阻塞等待结果（异步 / 由 TaskSystem watcher 拾起）/ skill 内容由 retro subagent 用 write 工具写到 L2 SkillSystem 管理的 system dir / 不通过本模块自有 dir。

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
- retro subagent 调度后不阻塞等待结果（异步 / 由 TaskSystem watcher 拾起）
- skill 资源持久化归 L2 SkillSystem own / 本模块仅在 retro 完成后调 SkillSystem.reload 触发 rescan

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/evolution-system/audit-events.ts` `RETRO_AUDIT_EVENTS`（模块自治）。

12 个 RETRO_* 事件：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `retro_subscribed` | subscribeToContractCompleted 完成 | — |
| `retro_triggered` | contract_completed 事件回调进入 | `contractId`, `sourceClawId` |
| `retro_skip_duplicate` | state 文件中已存 contractId | `contractId` |
| `retro_prompt_built` | retro prompt 构造完成 | `contractId` |
| `retro_subagent_dispatched` | 经 TaskSystem 派 retro subagent | `contractId`, `taskId` |
| `retro_extraction_started` | retro subagent 开始执行 | `contractId`, `taskId` |
| `skill_system_reload_triggered` | retro 子代理用 write 工具写完 skill 后本模块调 SkillSystem.reload | `contractId`, `reloadTriggered` |
| `retro_finished` | retro 流程正常收口 | `contractId` |
| `retro_subagent_timeout` | retro subagent 超时（软失败）| `contractId` |
| `retro_no_skill_output` | retro subagent 无 skill 写入输出（软失败）| `contractId` |
| `retro_reload_failed` | SkillSystem.reload 调用失败（软失败）| `contractId`, `reason` |
| `retro_error` | 硬错误（catch + 隔离）| `step`, `contractId`, `reason` |

## 6. 层级声明

L4 agent 业务流程层（与 TaskSystem / ContractSystem / MemorySystem 同层 / 「契约完成后能力沉淀」业务语义独立可变 / 与 MemorySystem 同属「经验整合」类业务：MemorySystem 整合会话经验 / EvolutionSystem 整合契约能力）。下游 Assembly（L6）通过 `createEvolutionSystem` 工厂消费 + 注入 deps + Assembly 触发 `subscribeToContractCompleted()`。skill 装配由 L2 SkillSystem own / 本模块只触发 SkillSystem.reload 后 dispatch 工具经 SkillSystem 入口加载装配给其他 claw。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

无（应然新模块 / 整 module 等代码 phase 落地 / 不在 §A 登记，归 §B 设计-gap 推代码 phase）。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

> **整体状态**：✅ **phase411 主体落地**（main `07bc7e9f` / 3 commit fast-forward merge）/ 整模块物理建 src/core/evolution-system/ + 拆 `ContractManager.handleReviewRequest` 6 步业务 → `EvolutionSystem.runRetroForContract` + ContractSystem +`onContractCompleted` callback decoupling + Assembly 装配 wire 订阅链 + dispatch-skills const 物理迁 evolution-system/ / 4 个 design-gap 候选闭环 + 候选 5 同 phase / 剩余 §B 候选（去重 state file / retroSubagentTimeoutMs 配置 / fire-and-forget catch isProgrammingBug）推后续 phase。

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~无独立模块 / 无工厂 `createEvolutionSystem` / 无装配端点~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ 物理建 src/core/evolution-system/ + createEvolutionSystem 工厂 + Assembly 装配（motion only）|
| ~~无事件订阅注册 / 实然 daemon 直调 `handleReviewRequest`~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ ContractManager +`onContractCompleted` callback + `_emitContractCompleted` / contract 完成路径 emit / Assembly wire `contract_completed` → `EvolutionSystem.runRetroForContract` / Daemon 不再直调 handleReviewRequest |
| audit 事件命名空间越界（RETRO_* 6 事件在 CONTRACT_AUDIT_EVENTS 而非 RETRO_AUDIT_EVENTS）| drift | ✅ phase383 清零 / SHA=fff1949 |
| ~~dispatch-skills 资源归属未落地~~ | ~~design-gap~~ | **✅ closed phase411（候选 5 同 phase 治理）**（main `07bc7e9f`）/ 物理迁 `DISPATCH_SKILLS_SUBDIR` + `DISPATCH_SKILLS_DIR` from `core/skill/skill-paths.ts` → `core/evolution-system/dispatch-skills-paths.ts` / caller (retro-scheduler / dispatch.ts / cli/commands/skill.ts) import 改 / 资源归属归 EvolutionSystem own |
| ~~缺 SkillTemplate 模型 + 持久化 + 索引 / retro subagent 输出仅由 prompt 指导 / 无解析 / 无持久化~~ | ~~design-gap / 高优~~ | ✅ closed by design reset（r60+ EvolutionSystem 不 own 模板库 / skill 内容由 retro subagent 用 write 工具写到 L2 SkillSystem 管理的 system dir / SkillTemplate 模型已不需要） |
| 缺去重状态文件 `.evolution-system-state.json` / 同 contractId 多次调可重复 retro | design-gap | 中 |
| 缺 `retroSubagentTimeoutMs` 配置参数 / timeout 硬编码 600 秒 / 无超时软失败 audit | drift | 中 |
| fire-and-forget catch 块缺 `isProgrammingBug` 检（manager.ts:1378-1395 + 1398-1403）/ phase342 模式未推广至 retro 路径 | drift（contract 异步 catch 同根扩展）| 中 |
| ~~缺 `listTemplates(filter?)` / `getTemplate(templateId)` 对外接口~~ | ~~design-gap / 高优~~ | ✅ closed by design reset（r60+ EvolutionSystem 不 own 模板查询接口 / skill 查询归 L2 SkillSystem） |
| ~~缺工厂 + 装配端点 / retro 逻辑硬绑 Motion daemon~~ | ~~design-gap~~ | **✅ closed phase411**（main `07bc7e9f`）/ createEvolutionSystem 工厂 + Assembly 装配（motion only / 按需）/ retro 逻辑迁 EvolutionSystem.runRetroForContract / Daemon 不再 own retro |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：「契约完成能力沉淀」业务语义独立 / 不与 ContractSystem（生命周期）/ MemorySystem（会话经验）共变
- **M#2 业务语义归属**：retro 触发 / prompt 构造 / 派 retro subagent / 去重 / SkillSystem.reload 协调由本模块发起
- **M#3 资源唯一归属**：state 文件独占 / skill 内容资源归 L2 SkillSystem own / 本模块不通过自有 dir 持久化 skill
- **M#4 持久化**：state 文件落盘 / skill 资源持久化归 L2 SkillSystem
- **M#5 依赖单向**：L4 → L4 (TaskSystem / ContractSystem) + L4 → L2 (SkillSystem.reload) + L4 → L1 (fs / audit) / 不上引 L6+
- **M#6 依赖结构稳定**：ctor 一次注入 / 运行期不变
- **M#7 耦合界面稳定**：3 公共方法 (start / stop / runRetroForContract) + 2 type (`EvolutionError` class / `RetroResult` interface 详 interfaces/l4.md) 设计稳定 / 本模块不暴露 listTemplates / getTemplate 等模板库接口
- **M#8 耦合界面最小**：retro 业务对外仅 start / stop / runRetroForContract / subscribeToContractCompleted
- **M#9 显式编译器可检**：所有签名 type-only / RETRO_AUDIT_EVENTS 模块自治应然
- **M#10 不合理停下**：phase342 isProgrammingBug 模式应推广至 retro 路径（fire-and-forget catch 治理）
- **M#11 边界对不上停下**：实然嵌 ContractManager.handleReviewRequest / 应然独立模块 / 显式登记治理

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：12 events 应然全覆盖
- **D1b 状态可观察**：state 文件可观察 / skill 资源可观察归 L2 SkillSystem
- **D1c 中断可恢复**：state 文件去重 / 重启可恢复（不重 retro 已处理 contractId）
- **D1d 事后可审计**：12 events 应然全覆盖
- **D2 不丢弃 / 静默**：retro 软失败 audit 留痕 / 硬错误 catch + audit 隔离
- **D3 用户可观察**：state 文件可观察 / skill 资源可观察归 L2 SkillSystem
- **D4 中断恢复**：state 文件去重 / 重启可恢复（不重 retro 已处理 contractId）
- **D5 日志重建**：12 events + state 文件 + L2 SkillSystem skill 文件足以重建
- **D6 子代理后不阻塞**：retro 经 TaskSystem fire-and-forget
- **D7 系统可信路径**：经 TaskSystem 派 retro subagent / 不绕路
- **D8 事件驱动**：subscribe contract_completed 事件 / 不轮询
- **D9 多 claw 不隔绝**：skill 跨 claw 复用（retro 子代理 write 至 SkillSystem system dir / dispatch 经 SkillSystem 加载装配给其他 claw / 实现 Philosophy）
- **D11 motion 单向访问**：EvolutionSystem 不绑 identity / 装配方决定

#### Philosophy（4 条）

- **P1 Agent 即目录**：retro 触发对应 contract 完成后的 skill 沉淀（落 SkillSystem 管理的 system dir）
- **P2 上下文工程**：retro 沉淀的 skill 是「跨 claw 上下文复用」的核心载体
- **P3 多 agent 利用**：核心驱动原则（实现 Philosophy 「特长能力可以轻易复制过来」）
- **P4 系统为智能体服务**：触发 retro 子代理沉淀能力到 L2 SkillSystem / 让 agent 间能力复用

#### Path Principles（6 条）

- **Path #1 实然为唯一基准**：r43 A audit fork 第 6 轮验证「实然 0 落地」/ 应然先于实然 design
- **Path #3 语义最小变更**：代码 phase 落地是单一意图 / 不附带其他 refactor
- **Path #6 冲突立即中断**：ContractSystem 三 design-gap 合并评估时机协调
- 反向测试：本模块可独立替换 TaskSystem 实现（mock）而不动 SkillSystem caller —— M#1 ✓

### 7.D 历史纪律

详 phase324+325 / phase383 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-26 / phase324+325 应然 framing 全推（modules.md §25 注册）
- 2026-04-27 / r43 A audit fork 第 6 轮验证「实然 0 落地」+ 治理候选清单确立（10 项）
- 2026-04-27 / phase383 audit 事件命名空间越界 清零（SHA=fff1949 / RETRO_* 6 事件物理迁 RETRO_AUDIT_EVENTS）
- 2026-05-03 / phase411 整模块拆出落地（main `07bc7e9f` / 3 commit fast-forward merge / 17 files / +372 / -309）/ Step A 物理新建 src/core/evolution-system/ + git mv retro-scheduler.ts + retro-audit-events.ts from contract/ + 新建 system.ts + index.ts + ContractRetroScheduler → RetroScheduler rename / Step B 拆 ContractManager.handleReviewRequest 6 步业务 → EvolutionSystem.runRetroForContract + ContractManager +onContractCompleted callback / contract_completed event 触发 + Assembly 装配 wire 订阅链 + Daemon 删直调 handleReviewRequest / Step C 物理迁 DISPATCH_SKILLS_SUBDIR + DISPATCH_SKILLS_DIR → evolution-system/dispatch-skills-paths.ts + caller import 改 / 4 个 design-gap 候选闭环 + 候选 5 同 phase / Path #7 路径 β 第 2 phase / 模块边界重构阶段第 3 phase / 整模块拆出模板首发
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / Philosophy P3 derive）| 各 claw 特长能力可轻易复制 / 经 EvolutionSystem 触发 retro 子代理 write 至 L2 SkillSystem + dispatch 经 SkillSystem 装配 | 应然契约一致 / 实然 0 落地 |
| KD（待编号）| EvolutionSystem 装配「按需」/ 不绑 identity | 应然契约一致 |
| KD（待编号）| skill 资源唯一归 L2 SkillSystem own / EvolutionSystem 不通过自有 dir 持久化 skill / 仅触发 SkillSystem.reload 协调 rescan | 应然契约一致 / dispatch-skills 资源归属未落地 治理候选（同 l2_skill_system「dispatch-skills 归属错配」） |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 代码 phase 落地后回填）：

- **工厂构造**：createEvolutionSystem + 必传 deps 注入断言
- **subscribeToContractCompleted**：Assembly 显式调 / 注册到 ContractSystem 事件订阅链 / 工厂内不静默订阅
- **事件回调路径**：contract_completed → retro_triggered audit → retro_prompt_built → 经 TaskSystem 派 retro subagent → retro_subagent_dispatched
- **去重**：同 contractId 第二次触发 → retro_skip_duplicate audit + 不派 subagent
- **能力提炼**：retro subagent 派出 + contract_completed 触发 / state 文件去重写回 / SkillSystem.reload 调用（skill 内容由 retro subagent 用 write 工具写到 SkillSystem system dir / 本模块不解析 / 不写 dir）
- **超时软失败**：retro subagent 超时 → retro_subagent_timeout audit + 不影响后续契约
- **无 skill 输出软失败**：retro subagent 无 skill 写入 → retro_no_skill_output audit + 跳过 reload
- **reload 软失败**：SkillSystem.reload 调用失败 → retro_reload_failed audit + 不影响后续契约
- **错误隔离**：单契约 retro 硬错误 catch → retro_error audit + 不冒泡
- **runRetroForContract** 测试触发路径：手动触发同事件驱动路径
- **state 文件容错**：读取失败 → 空初始状态 / 写入失败 → 调用方 catch + audit
- **审计回链**：每个 §5 RETRO_* 事件触发时机 + 载荷断言（12 events 全覆盖）
- **多实例隔离**：同 daemon 内 2 个 EvolutionSystem 实例（不同 stateDir）/ retro 状态不互通 / skill 资源跨实例合并归 SkillSystem
