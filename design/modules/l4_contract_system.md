# ContractSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（仅 own agent 工具的模块；5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) ContractSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §22「ContractSystem 本质：契约生命周期管理服务 / L4 agent 基础设施 ——『契约管理』」加 M#1 / M#2 / M#3 / M#5 / Design Principle「智能体是决策主体」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），ContractSystem 的单一职责 = **契约完整生命周期管理**：

- **CRUD + 状态追踪**：创建 / loadActive / loadPaused / pause / resume / cancel / archive 全路径 / contract.yaml + progress.json 持久化
- **subtask 状态机**：active ↔ paused ↔ archive 三态迁移 + lock 防并发（writeAtomic + LOCK_MAX_RETRIES + LOCK_STALE_TIMEOUT_MS / 自动清 stale lock）
- **验收判定（双轨）**：脚本路径走 ProcessExec / LLM 路径透过 TaskSystem 调度 verifier 子代理（同层单向 / ⚠ phase340 引入的 ContractVerifierScheduler port 是 design work-around / 真合规直 dep TaskSystem / 详 §A STALE + feedback_governance_workaround_smell）
- **acceptance fire-and-forget**：`_runAcceptanceInBackground` 不 await / 结果走 inbox 异步通知 / D6 满足 / `isProgrammingBug` 检（phase342）
- **重试 + escalation**：重试是 system 自治（机械重试 / 配置定义次数）/ escalation 通知（达阈值后投 inbox 通知 agent，决策权归 agent / 不替代 agent 决策）
- **暂停 + 恢复 + 取消 + 归档**：状态迁移 / archive 终态不再回入

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) ContractSystem 节。具体实现细节（VerifierConfig / VerifierResult / createSubAgentVerifierScheduler / collectContractEvents / getContractCreatedMs / handleReviewRequest 等）的存在依据是「契约生命周期 + acceptance fire-and-forget」原语 — 实然采纳的 method 集合差异等登记 §7.B。
>
> ⚠ STALE：原 docblock + §1.做 + §1.不做 提的 ContractVerifierScheduler port + RetroScheduler port「port 解耦」叙事 是 design work-around / 推 r61+ 反向 design phase 撤销 port + 用真合规设计（直 dep TaskSystem 同层单向 + emit contract_completed event 让 EvolutionSystem 订阅 / 单向）替换 / 详 feedback_governance_workaround_smell。

### 不做

- **不直接 `new SubAgent`**（应然 verifier 子代理实例化由 TaskSystem own / ⚠ phase340 引入的 verifier-scheduler port 是 design work-around / 真合规 = ContractSystem 直 dep TaskSystem.schedule + 同层单向）— derive 自 M#1 + M#5
- **不解析 LLM 响应内容**（verifier 返 `VerifierResult.passed` / contract 只看判定结果）— derive 自 M#1
- **不管 verifier subagent 内部生命周期**（TaskSystem own）— derive 自 M#1
- **不 own 单步 LLM 调用加 agent 循环**（LLM 验收透过 TaskSystem 派 verifier 子代理）— derive 自 M#1
- **不 own 跨 agent 通信**（escalation 通知加验收结果回传透过 Messaging）— derive 自 M#1
- **不 own 契约业务策略**（重试次数加 escalation 阈值加验收脚本内容是装配期配置）— derive 自 M#2
- **不 own agent 决策替代**（escalation 后 agent 决策怎么应对，本模块不替代）— derive 自 Design Principle「智能体是决策主体」
- **不 own 契约模板提炼**（归 L4 EvolutionSystem 订阅 contract_completed 事件）— derive 自 M#1 + M#3

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），ContractSystem 的业务语义边界：

- **own**：「契约生命周期」L4 业务域唯一发起点：CRUD / 状态迁移 / acceptance / archive / retro 触发
- **角色定位**：ContractSystem 是「**契约生命周期业务流程框架**」非「**LLM 验收执行器**」。verifier 子代理实际执行验收 / 本模块只判定 + 协调 + 回传结果。
- **acceptance 异步 fire-and-forget**：`_runAcceptanceInBackground` 不 await / 结果走 inbox 异步通知 / D6 满足
- **锁文件防并发**：LOCK_MAX_RETRIES + LOCK_STALE_TIMEOUT_MS / 自动清理 stale lock

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），ContractSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `contract/active/<id>/contract.yaml` | 契约定义（独占）| ✓ |
| `contract/active/<id>/progress.json` | subtask 状态机（独占）| ✓ |
| `contract/paused/<id>/*` | 暂停态（独占）| ✓ |
| `contract/archive/<id>/*` | 归档（独占 / 终态）| ✓ |
| `contract/active/<id>/.lock` | 防并发文件锁 | ✓ stale 自动清 |
| `acceptance.sh` / acceptance prompts | 用户提供 | ✓ |
| `verifierScheduler` 字段 | port 注入 / 默认 fallback | 派生 |

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），ContractSystem 的持久化立场：contract/* 三目录磁盘是权威 / progress.json + contract.yaml + lock + acceptance scripts 全落盘 / 重启后从 progress.json 恢复 subtask 状态机。

### 磁盘布局

```
contract/
├── active/<id>/
│   ├── contract.yaml      ← 契约定义 / 单一权威
│   ├── progress.json      ← subtask 状态机 / writeAtomic
│   ├── .lock              ← 防并发 / stale 自动清
│   ├── acceptance.sh      ← 用户提供（可选）
│   └── prompts/           ← LLM acceptance 提示词
├── paused/<id>/*          ← 暂停态 / resume 时迁回 active
└── archive/<id>/*         ← 终态 / 不再回入
```

### 文件格式

- `contract.yaml`：契约定义 / subtask + acceptance + retry 配置 / 用户编辑入口
- `progress.json`：subtask 状态机（`subtaskId → status` map / status ∈ { todo, in_progress, in_review, done, error }）/ writeAtomic 写入
- `.lock`：防并发 / 内含 PID + timestamp / stale 自动清（LOCK_STALE_TIMEOUT_MS）
- `acceptance.sh`：用户提供 acceptance 脚本（可选）
- `prompts/`：LLM acceptance 提示词目录（用户提供）

### 重建语义

- contract / progress 经 loadActive / loadPaused 解析
- subtask 状态机重启从 progress.json 恢复
- pending acceptance 失败时 DialogStore.repair 注入 synthetic tool_result（fire-and-forget design-gap 待 r42+ 评估 / fire-and-forget 失败 subtask 状态机语义）

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/contract/audit-events.ts` `CONTRACT_AUDIT_EVENTS`（模块自治 / phase338 H1 拆分）。

17 个 CONTRACT_* 事件（phase342 + UNEXPECTED_ASYNC_THROW / phase350 + OBSERVER_EVENT_FAILED / phase383 evolution_system_* 6 events 物理迁 RETRO_AUDIT_EVENTS）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `contract_created` | create 成功 | `contractId` |
| `contract_updated` | progress.json 更新 | `contractId`, `subtaskId`, `status` |
| `contract_acceptance_started` | LLM acceptance 启动 | `contractId`, `subtaskId` |
| `contract_acceptance_script_started` | 脚本 acceptance 启动 | 同上 |
| `contract_acceptance_inbox_failed` | 结果回 inbox 失败 | `contractId`, `error` |
| `contract_acceptance_reset_failed` | acceptance 重置失败 | 同上 |
| `contract_archive_started` | archive 流程启动 | `contractId` |
| `contract_lock_cleared` | stale lock 清理 | `contractId` |
| `contract_lock_unlink_failed` | lock 删除失败 | `contractId`, `error` |
| `contract_progress_corrupted` | progress.json 解析失败 | `contractId`, `error`, `context` |
| `contract_rollback_failed` | rollback 失败 | `contractId`, `error` |
| `contract_notify_failed` | onNotify callback throw | `type`, `error` |
| `contract_move_archive_failed` | archive 目录迁移失败 | `contractId`, `error` |
| `contract_subtask_duplicate_done` | done 重复触发 | `contractId`, `subtaskId` |
| `contract_subtask_already_completed` | 已 done 又 done | 同上 |
| `contract_unexpected_async_throw` | `_runAcceptanceInBackground` catch 块识别编程 bug | `error_type`, `message`, `stack` |
| `contract_observer_event_failed` | ContractObserver `collectContractEvents` 失败 | `clawId`, `error` |

## 6. 层级声明

L4 agent 业务流程层（与 TaskSystem / EvolutionSystem / MemorySystem 同层 / 业务语义独立可变）。下游 Runtime（L5）+ CLI（L6）+ Assembly（L6）通过 `createContractSystem` 工厂消费 + 注入 verifier scheduler。上游 L1/L2 + L3 port / 不上引 L5+。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 直 import `core/tools/registry`（ToolRegistryImpl）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（L4 不应直 L2 实现）/ M#8（耦合界面最小）~~ → phase364 VerifierScheduler 内化 ToolRegistry / cross-layer import 5/5 全清 |
| ~~A.2 直 import `prompts/subagent`（CONTRACT_VERIFIER_SYSTEM_PROMPT）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（prompts 跨层）~~ → phase364 VerifierScheduler 内部持有 prompt / 同 A.1 phase |
| **A.3 直 import `prompts/retrospective`（buildRetroPrompt）** ⚠ STALE / phase364 错治理 | drift / 中 | **⚠ 推 r61+ 反向 design phase**（phase364 RetroScheduler port 是 design work-around / 真合规 = event subscription / 详 feedback_governance_workaround_smell）| 应然真合规判定：ContractSystem emit `contract_completed` event 单向 / EvolutionSystem 订阅 + 自治 retro 触发（含 prompt 构造）/ ContractSystem 完全 0 知 retro 概念 + 0 知 EvolutionSystem / port pattern 第 X 次「复用」叙事推翻 |
| **A.4 直 import `task/tools/_pending-task-writer`（writePendingSubagentTaskFile）** ⚠ STALE / phase364 错治理 | drift / 中 | **⚠ 推 r61+ 反向 design phase**（同 §A.3 / RetroScheduler port 是 design work-around / 真合规 = event subscription）| 应然真合规判定：phase364 RetroScheduler port + verifier port pattern「复用」叙事整套推翻 / 真合规 = ContractSystem emit `contract_completed` event 单向 / EvolutionSystem 订阅自治 retro 触发 / 0 跨层 port abstraction / 详 feedback_governance_workaround_smell |
| ~~A.5 直 import `core/skill`（createSkillRegistry）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（L4 → L2 跳层）~~ → phase364 Path #1 framing 修正 grouping 归 RetroScheduler / SkillRegistry deps 注入 |
| ~~A.6 契约完成通知 inbox 缺失~~ | drift | **已闭环（phase350）** | `assemble.ts:contractNotifyCallback` 内追加 `notifyInbox` / β 双链路保险 / D8 事件驱动 align |
| ~~A.7 ContractObserver CLI 调用路径错误~~ | drift | **已闭环（phase350）** | `contract-observer.ts` 删 execFile cli fork / 改 `collectContractEvents` 直调（抽函数 `event-collector.ts`）/ KD#29 工具归属 align |
| ~~A.8 execFile 静默 catch（同 A.7 根因）~~ | drift | **已闭环（phase350）** | catch 加 `OBSERVER_EVENT_FAILED` audit / Coding #5 失败暴露 / 同 phase342 UNEXPECTED_ASYNC_THROW 模式 |
| **A.naming-1 code class 名 `ContractManager` ↔ 应然 `ContractSystem`** | naming drift / 大 | **✅ closed**（phase416 / main `b053aa1f`）| 实施落地：class `ContractManager` → `ContractSystem` + `createContractManager` → `createContractSystem` factory + 21 file caller import cascade + 测试同步 / ShellTool→CommandTool 反向 rename 模板首次应用（phase378 反向）/ ContractManagerPort 维持 STALE 不动 |
| **A.spec-1 应然 `list/log/done` method 应然幻象** | spec drift / 中 | **closed**（phase414c L4 audit / interfaces/l4.md 删 3 method 应然幻象）| 历史 interfaces 写 `list(filter?: ContractFilter): Promise<Contract[]>` + `log(contractId): ContractLog` + `done(contractId, result: ContractResult)` / 实然 0 实施 / `done` 实然由 `doneTool` 完成 (builtins/done.ts / phase360 物理迁) 不在 ContractSystem class method / `list` / `log` 实然由 `loadActive()` / `loadPaused()` + audit log 替代 / phase414c interfaces/l4.md 修订删 3 应然幻象 method |
| **A.spec-2 应然 simple Contract spec/lifecycle ↔ 实然 multi-subtask model** | spec drift / 大 | **closed**（phase414c L4 audit / interfaces/l4.md align 实然 ContractYaml + ProgressData + AcceptanceResult 多 subtask model）| 历史 interfaces 写 `ContractSpec { intent, acceptance, retryLimit?, escalationThreshold?, payload? }` + simple Contract lifecycle / 实然 ContractYaml multi-subtask schema (44+) + ProgressData per-subtask + AcceptanceResult / 实然加多 method (`getProgress` / `completeSubtask` / `isComplete` / `loadActive` / `loadPaused`) 应然 silent / pause + cancel 必填多参 (checkpointNote / reason) / `setOnNotify` callback 注入应然 silent / phase414c interfaces/l4.md 修订 align 实然 multi-subtask model + 删 ContractSpec / AcceptanceCriteria / ContractResult / ContractFilter / ContractLog / ContractCompletedHandler / ContractLockError 7 应然幻象 type |

A.1-A.5 修复路径（phase364 已合并实施 / 历史登记）：
1. ContractVerifierScheduler 默认实现内部持有 prompts + skillRegistry + ToolRegistry 构造（移出 ContractSystem ctor）
2. 抽象「retro 调度 port」：`EvolutionSystemScheduler.schedule(config)` 替代 writePendingSubagentTaskFile 直 import
3. ContractSystem ctor 仅 4 必传：clawDir / clawId / fs / audit + 2 可选 port（verifierScheduler / retroScheduler）
4. M#8 耦合界面最小达成

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~异步 catch 块吞 TypeError~~ | drift | **已闭环（phase342）** / `isProgrammingBug` 检 + audit `UNEXPECTED_ASYNC_THROW` + rethrow / Coding #5 合规 |
| ~~双 audit writer + 10+ hardcoded events~~ | drift | **已闭环（phase345）** / `this.auditWriter?` 6 sites 治理为 const 引用 / caller 风格统一并轨第 1 次 |
| ~~应然滞后批量修订~~ | drift | **已闭环（r47 §A.1）** / VerifierConfig / VerifierResult / scheduler 签名 / §3 events 表 / §head SHA 同步 |
| ~~H6 异步通道完整迁移~~ | design-gap | **撤销 / 释义闭环（r48 用户原则 derive）** / verifier-scheduler sync 实现合规（业务本质 = 子代理执行 + 结果收集一原子操作）/ async 退化 thin wrapper 违 M#1+M#7+M#8 / 不需 design phase / 与 ToolExecutorImpl.taskSystem 同模板族（释义闭环 vs 释义豁免第 3 实证）|
| **ContractManager 双 audit writer 设计冗余** | **closed** | **phase359 清零**（main `3d7415938b6dc647b70c876f7e2c419160f0b456`）| β 方案落地：ctor 9→8 参 / 删 field auditWriter? / 44 处 this.auditWriter?.write → this.audit.write / index.ts factory + assemble.ts:192 同步 / 行为契约扩（7 caller 漏写 → 正写 / D1d 修 bug 副作用）/ M#7+M#8+M#6+D1d 全合规 / Group A 收尾 |
| fire-and-forget 失败时 subtask 状态机语义 | design-gap / 中 | **真 design-gap**（r48 derive 后剩唯一真 design-gap）/ 业务决策：LLM 判定 failed / 编程 bug throw / subagent timeout 三种失败 subtask 应 transition error / todo / 还是 in_progress / 推 r48+ design phase |
| ~~done 工具应然归 ContractSystem~~ | drift | **✅ closed**（phase360 / main `e3285d0`）| ~~r48 新登记~~ → 物理迁实施：`src/core/tools/builtins/done.ts` → `src/core/contract/builtins/done.ts`（git mv 保 history）+ contract/index.ts 加 export + Assembly 显式 `toolRegistry.register(doneTool)` + tools/builtins/index.ts 删 doneTool import/re-export/register / KD#29 子任务 done 落地 / ~~port pattern 应用模板第 5 次复用~~ ⚠ STALE：done 物理迁本身合理（业务工具归业务模块 own / M#2+M#3 真合规）/ 但「port pattern 第 5 次复用」标错（done 不是 port pattern / 是 tool ownership 转移）/ 详 feedback_governance_workaround_smell / phase347 dispatch 物理迁模板第 2 次复用 / M#1+M#2+M#3+M#5+M#7+M#8 全合规 |
| **statusTool L2→L4 type-import drift（ContractManager）** ⚠ STALE / phase369 错治理 | drift | **⚠ 推 r61+ 反向 design phase**（ContractStatusPort 是 design work-around / 真合规 = statusTool 直 dep ContractSystem 顺向 / 详 feedback_governance_workaround_smell）| 应然真合规判定：phase369 ContractStatusPort port pattern 第 7 次「复用」叙事整套推翻 / statusTool L2 → ContractSystem L4 是 cross-layer-up / 真合规 = statusTool 物理迁 L4 ContractSystem own（同 done 工具 phase360 模板）/ 不是用 port 解 cross-layer-up |
| B.1 CLI 直操路径（仅脚本 acceptance）| design-gap / 低 | 未传 llm / verifierRegistry → LLM acceptance 不可用 / 仅脚本 acceptance 工作 / 升档：CLI 路径需 LLM 验收时 → 装配 llm + registry |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：契约生命周期独立业务域 / 不与 TaskSystem 共享 state
- **M#2 业务语义归属**：acceptance / state 迁移 / archive / retro 由本模块发起
- **M#3 资源唯一归属**：contract/active|paused|archive 三目录独占
- **M#4 持久化**：progress.json + contract.yaml + lock + acceptance scripts 全落盘
- **M#5 依赖单向**：不反向依赖 Runtime / Daemon / 5 直 import 跨层 phase364 已闭环（A.1-A.5）
- **M#6 依赖结构稳定**：ctor 一次注入 / 运行期不变
- **M#7 耦合界面稳定**：公共 7 方法形态稳定（create / done / pause / resume / cancel / list / log）/ phase340 0 改
- **M#8 耦合界面最小**：⚠ STALE「port pattern 已立」叙事 2026-05-03 推翻 / ctor 8 参（phase359 collapse 后 / 双 audit writer 设计冗余 closed）/ 真合规 = ContractSystem 直 dep TaskSystem + emit event / 详 §A.3+A.4 STALE + feedback_governance_workaround_smell
- **M#9 显式编译器可检**：port interface 类型化 / 注入参数显式 / phase345 caller 风格统一并轨后 23 events 全 const 引用
- **M#10 不合理停下**：phase340 H6 假设修正 → 推 r41+ design 评估 / 不 mechanical
- **M#11 边界对不上停下**：A.1-A.5 显式登记不静默 / phase364 闭环

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：23 events 覆盖 / phase342 异步 catch 修
- **D1b 状态可观察**：contract / progress / lock 文件 + audit events 可观察
- **D1c 中断可恢复**：progress.json 持久化 + lock 保护
- **D1d 事后可审计**：phase342 + phase350 双闭环
- **D2 不丢弃 / 静默**：phase342 异步 catch 吞 TypeError 修 / phase350 OBSERVER_EVENT_FAILED 修
- **D3 用户可观察**：contract / progress / lock 文件 + audit events 可观察
- **D4 中断恢复**：acceptance 路径走 verifier-scheduler / verifier 失败可重试（H6 异步通道完整迁移 异步化下重试模式待评估）
- **D5 日志重建**：23 events 覆盖主路径
- **D6 子代理后不阻塞**：acceptance fire-and-forget / done 工具立即返回 / 异步 inbox 通知
- **D7 系统可信路径**：acceptance 走 ProcessExec / verifier 走 port / 不绕过
- **D8 事件驱动**：inbox 消息 + audit 事件 / phase350 contractNotifyCallback inbox 链路打通
- **D11 motion 单向访问**：本模块不涉及 motion 边界

#### Philosophy（4 条）

- **P1 Agent 即目录**：contract/<id>/ 是 contract 单元目录 / contract.yaml + progress.json 是 contract claw 状态锚点
- **P2 上下文工程**：contract claw 通过 progress 文件管理上下文
- **P3 多 agent 利用**：verifier 子代理独立窗口 / 不污染 contract claw
- **P4 系统为智能体服务**：acceptance + retro 为 contract claw 决策提供信息

#### Path Principles（6 条）

- **Path #1 实然为唯一基准**：phase340 实测 5 残 import / 0 推翻 / 写入 §7.A
- **Path #3 语义最小变更单元**：APPEND-only §7 / phase340 单 commit port 立 + 删 2 import 不附带 caller 风格统一
- **Path #6 冲突立即中断**：phase340 fork mechanical 异步化 → framing 修正 → 停 mechanical 推 design 评估
- 反向测试：本模块可独立替换 verifier 实现而不动 caller —— port pattern ✓

### 7.D 历史纪律

详 phase338 / phase340 / phase342 / phase345 / phase346 / phase350 / phase359 / phase360 / phase364 / phase369 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-27 / phase340 H6+H11 ContractVerifierScheduler port + 删 2 直 import（subagent + report-result）/ port pattern 第 3 次复用里程碑 / 反向 3/3 强 PASS / 暴露异步 catch 块吞 TypeError ⚠ STALE 2026-05-03 推翻：port pattern 是 design smell / 应然真合规 = ContractSystem 直 dep TaskSystem / 详 feedback_governance_workaround_smell
- 2026-04-27 / phase342 异步 catch 块吞 TypeError 闭环（`isProgrammingBug` 检 + audit `UNEXPECTED_ASYNC_THROW` + rethrow / Coding #5 合规）
- 2026-04-27 / phase345 双 audit writer + hardcoded events 闭环（caller 风格统一并轨第 1 次 / 6 sites const 治理）
- 2026-04-27 / phase350 A.6+A.7+A.8 同根 drift 合并治理（contractNotifyCallback inbox + collectContractEvents 抽函数 + OBSERVER_EVENT_FAILED audit / β 双链路保险 / D8 align / 同根 drift 合并治理首发模式）
- 2026-04-27 / phase338 H1 audit-events.ts 模块自治拆分（CONTRACT_AUDIT_EVENTS 物理迁出全局 events.ts）
- 2026-04-27 / phase346 utils.ts 从 watchdog-utils 迁出（getContractCreatedMs 归 contract 模块 own）
- 2026-04-27 / phase359 双 audit writer 设计冗余 清零（ctor 9→8 参 / 44 处 this.auditWriter?.write → this.audit.write / Group A 收尾）
- 2026-04-27 / phase360 done 工具物理迁 ContractSystem（KD#29 子任务）
- 2026-04-27 / phase364 A.1-A.5 全清零（VerifierScheduler 内化 ToolRegistry + RetroScheduler 立）
- 2026-04-27 / phase369 statusTool L2→L4 type-import 清零（ContractStatusPort 立）⚠ STALE 2026-05-03 推翻：port 是 design work-around / 真合规 = statusTool 物理迁 L4 ContractSystem own（同 done phase360 模板）/ 详 §B STALE + feedback_governance_workaround_smell
- 2026-05-03 / phase411 handleReviewRequest 业务体物理迁 EvolutionSystem.runRetroForContract（main `07bc7e9f`）/ ContractSystem +onContractCompleted callback + _emitContractCompleted / contract 完成路径 emit / Assembly wire contract_completed → EvolutionSystem / ContractSystem 不再 own retro 业务 / decoupling 通过 callback / 同 phase 与 l2_skill_system dispatch-skills 资源归属移交（候选 5 同 phase 治理）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#30 | ContractSystem LLM verifier 经 TaskSystem 调度 | **部分实施**（H11 完整：删 2 直 import + port 立 / H6 异步化推 r41+ design）|
| KD（待编号）| acceptance fire-and-forget D6 | ✓ phase342 异步 catch 修 |
| KD#29 | 工具归属 / collectContractEvents 抽函数 | ✓ phase350 align |
| KD#29 子任务 done | 工具归属 / done 工具物理迁 ContractSystem | ✅ 闭环（main `e3285d0f6ba9ff67b8238812bbf4956d1c84da0c`）| done 工具物理迁 `src/core/tools/builtins/done.ts` → `src/core/contract/builtins/done.ts` / contract/index.ts 加 export / Assembly 显式 register / registerBuiltinTools 函数语义边界规整（仅 L3 tools 不含 L4 业务工具）/ M2 反向测试通过 / 同 phase347 dispatch 模板第 2 次复用 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **CRUD**：create / loadActive / loadPaused / pause / resume / cancel / archive 全路径
- **acceptance 路径**：脚本路径走 ProcessExec / LLM 路径直 dep TaskSystem 调度 verifier 子代理（同层单向 / ⚠ 原「verifier port + port mock 测试」叙事 2026-05-03 STALE / 详 §A 系列 + feedback_governance_workaround_smell）
- **state machine**：active ↔ paused ↔ archive 三态迁移 + lock 防并发
- **acceptance fire-and-forget**：D6 不阻塞 done 工具返回 / 结果走 inbox 异步通知
- **isProgrammingBug 检**：`_runAcceptanceInBackground` catch 块识别编程 bug → audit `UNEXPECTED_ASYNC_THROW` + rethrow
- **lock 竞争**：LOCK_MAX_RETRIES + stale lock 清理
- **审计回链**：每个 §5 CONTRACT_* 事件触发时机 + 载荷断言（23 events 全覆盖）
- **port pattern 反向**：port 接口签名错 → tsc fail / port 调用契约破坏 → mock test 断言 fail / port 注入断裂 → contract test fail
- **collectContractEvents 抽函数**：observer + cli 共调 / 失败 catch 写 OBSERVER_EVENT_FAILED audit
- **ContractObserver L5 cron 视察**：直调 collectContractEvents（不 fork cli）
- ~~H6 异步通道 / fire-and-forget / 双 audit writer design-gap~~ — **r48 derive 后状态更新**：H6 异步通道 撤销 / 双 audit writer 升 drift β 锁定 / 仅 fire-and-forget 失败 subtask 状态机语义 真 design-gap 待 r48+ 决策

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile 准入+不变量）。失败语义留全工具集统一深度讨论。
> ContractSystem own 的 agent 工具：done（L4 / 物理迁自 TaskSystem / phase360）。

### 10.1 done

**【1. 用途】**

> **subtask 完成信号通道** —— claw 主代理在完成 contract subtask 工作后调 done，通知 ContractSystem 该 subtask 进入 acceptance 验收流程。

**设计意图**：

- done 是 contract 状态机的「subtask 进入 in_review」唯一外部触发口
- caller 心智 = 「我搞完了 / 接下来交给系统验收」
- done 不感知 acceptance 类型（脚本 vs LLM verifier）/ 不阻塞等待验收结果
- 验收结果异步经 inbox 回传 / D6 满足
- 不替代 agent 决策：done 只是「我认为完成了」的声明 / 验收通过与否由 acceptance 流程判定

**【2. 入参 schema】**

```
- subtaskId  (string, required)   待标记完成的 subtask ID（contract.yaml 中定义）
```

**关键决策**：

- **极简 1 字段**：done 不接 result / summary / artifact 等字段（验收读 disk + dialog / 不靠 done 入参传载荷）
- contractId 隐式：从 caller claw 当前活跃 contract 推（不暴露给 agent / 防误传）

**【3. 返回语义】**

```
ToolResult { success: boolean, content: string }
```

**两阶段返回**：

**阶段 1 / 立即返**（done 调用即返）：

| 场景 | success | content |
|---|---|---|
| 标记成功 | true | `Subtask <subtaskId> marked done. Acceptance running in background.` |
| subtaskId 未知 | false | `Unknown subtaskId: <subtaskId>` |
| subtask 已 done（重复触发）| true | `Subtask already completed`（幂等 / audit `contract_subtask_already_completed` / `contract_subtask_duplicate_done`）|
| progress.json 写失败 | false | error message |

**阶段 2 / 验收完成异步投递**（经 inbox / 不在 done 返回路径）：

| 场景 | inbox 消息形态 |
|---|---|
| 验收通过 | acceptance 通过 / contract 进入下一 subtask 或 archive |
| 验收失败 | acceptance 失败 / agent 收到反馈决策续做 |
| acceptance 超时 / 编程 bug | audit + inbox 通知（D2 不丢弃 / 不静默）|

**关键承诺**：

- **done 不阻塞 acceptance**（fire-and-forget / D6 满足）
- **done 调用即返**（不等 acceptance 跑完）
- **acceptance 失败 inbox 投递必送达**（β 双链路：onNotify callback + notifyInbox / phase350）
- **isProgrammingBug 检**：acceptance fire-and-forget 内部 catch 块识别编程 bug → audit `contract_unexpected_async_throw` + rethrow（phase342）

**【4. 副作用 + 跨通道影响】**

- **fs 写**：`contract/active/<id>/progress.json` 更新（writeAtomic / lock 保护）
- **acceptance 触发**：`_runAcceptanceInBackground` fire-and-forget
  - 脚本 acceptance → 经 ProcessExec 跑 `acceptance.sh`
  - LLM acceptance → 直 dep TaskSystem 调度 verifier 子代理（同层单向 / ⚠ phase340 port 已 STALE / 详 §A 系列 + feedback_governance_workaround_smell）
- **跨通道**：acceptance 结果经 inbox（L2 Messaging）回 caller claw
- **audit**：`contract_updated`（subtaskId / status=done）+ acceptance 路径 audit 链（详 §5）
- **claw 重启**：progress.json 持久化保 done 状态 / acceptance 状态归 contract 自身 recovery 路径

**【5. profile 准入 + 不变量】**

profile 准入：

- ✓ `full`（claw 主代理 / contract 执行者）含 done
- ✗ `subagent` 不含 done（subagent 是 disposable / 不直接 own contract subtask）
- ✗ `miner` / `dream` / `verifier` 不含 done（验收角色不能自标 done）

不变量：

- **done 仅 contract 跑动期可调**：caller claw 当前必有活跃 contract / 否则 unknown subtaskId
- **同 subtaskId 多次 done 幂等**：第二次起 audit `contract_subtask_duplicate_done` / 不再触发 acceptance
- **done 不替代 acceptance**：done = 「我认为完成」/ acceptance = 「系统判定通过」/ 两者分离
- **acceptance 失败 retry 决策权归 agent**：达 retry 阈值后 escalation 投 inbox / agent 决策（不 system 自决）
