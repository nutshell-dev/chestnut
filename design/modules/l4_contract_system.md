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
- **验收判定（双轨）**：脚本路径走 ProcessExec / LLM 路径直 dep AsyncTaskSystem 调度 verifier 子代理（同层单向）
- **acceptance fire-and-forget**：`_runAcceptanceInBackground` 不 await / 结果走 inbox 异步通知 / D6 满足 / `isProgrammingBug` 检
- **失败状态机（feedback driven / phase 468 用户拍板）**：3 种失败（LLM judged failed / programming bug throw / subagent timeout）统一转 `'todo'` + retry_count++ + last_failed_feedback 记 / `'failed'` 终态在 fire-and-forget 路径 0 进入。**重点不在状态复杂化** / 重点在 agent 拿到的反馈信息引导其改进契约子项实施（D6 智能体决策主体 + Design Principle「智能体需要决策时交付相关信息」）。
- **last_failed_feedback 结构化**：`{ feedback: string; cause: 'llm_rejected' | 'programming_bug' | 'subagent_timeout' }` / cause 字段让 agent 区分三类失败语义但不引入新状态机 / feedback 主体 LLM 自解析。
- **三类失败 feedback 内容指南**：
  - `llm_rejected` → acceptance prompt 输出（含 reason + issues 数组 + 改进建议 / 已结构化 / `result.structured.reason` + `result.structured.issues`）
  - `programming_bug` → 错误类型 + 消息 + 提示「系统 bug / agent 修代码后再 retry」
  - `subagent_timeout` → timeout 时长 + 提示「资源 / 网络问题 / 重试可能修复」
- **重试 + escalation**：重试是 system 自治（机械重试 / 配置定义次数）/ escalation 通知（达 max_retries 阈值后投 inbox 通知 agent / 决策权归 agent / **escalation 后 subtask 仍 `'todo'`** / 不替代 agent 决策）
- **暂停 + 恢复 + 取消 + 归档**：状态迁移 / archive 终态不再回入

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) ContractSystem 节。具体实现细节（VerifierConfig / VerifierResult / collectContractEvents / getContractCreatedMs / handleReviewRequest 等）的存在依据是「契约生命周期 + acceptance fire-and-forget」原语 — 实然采纳的 method 集合差异等登记 §7.B。

### 不做

- **不 own SubAgent class 实现**（class 是 L3 原语 / ContractSystem 直 createSubAgent 走 sync path 合规 / per phase 502 invariant-3 anchor / async/sync path 分流判据：sync 验收 caller 直 createSubAgent 不绕 AsyncTaskSystem.spawn / verifier-job lifecycle dir = `tasks/sync/spawn/<agentId>/`）— derive 自 M#1 业务语义独立可变（async lifecycle vs sync exec）+ M#2 验收业务由 ContractSystem 自发起
- **不解析 LLM 响应内容**（verifier 返 `VerifierResult.passed` / contract 只看判定结果）— derive 自 M#1
- **不 own subagent class 内部生命周期**（class 实现归 L3 SubAgent / sync caller 持调用方 lifecycle dir 装配责任）— derive 自 M#1
- **不 own 单步 LLM 调用加 agent 循环**（LLM 验收 sync 路径直 SubAgent.run / 内部 AgentExecutor 循环归 L3）— derive 自 M#1
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
- pending acceptance 失败时 DialogStore.repair 注入 synthetic tool_result + subtask reset 'todo' + retry_count++（fire-and-forget 失败状态机已 closed by phase 468 / feedback driven / 详 §1.做 + §7.B closed row）

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/contract/audit-events.ts` `CONTRACT_AUDIT_EVENTS`（模块自治）。

17 个 CONTRACT_* 事件：

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

L4 agent 业务流程层（与 AsyncTaskSystem / EvolutionSystem / MemorySystem 同层 / 业务语义独立可变）。下游 Runtime（L5）+ CLI（L6）+ Assembly（L6）通过 `createContractSystem` 工厂消费。本模块下引 L1/L2（fs / audit / Messaging）+ L4 同层（直 dep AsyncTaskSystem）/ 不上引 L5+。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

> **⚓ invariant（phase 576 + 587 sharpen）**：lock 文件 / progress.json / contract.yaml 等 contract dir 内任 `JSON.parse(...) as T` / `yaml.load(...) as T` type assertion 必配 inline schema 校验（typeof + Number.isFinite + Array.isArray + 业务必需字段 / minimum viable required）/ 非法数据视同 corrupt：(a) lock 走 stale 路径 + audit `LOCK_SCHEMA_INVALID`（phase 576）/ (b) progress.json 走 throw 或 graceful continue + audit `PROGRESS_SCHEMA_INVALID`（phase 587）/ (c) contract.yaml 走 throw + audit `CONTRACT_YAML_SCHEMA_INVALID`（phase 587）/ 各子域独立 NEW const align M#1 业务语义归属 / 0 复用 PROGRESS_CORRUPTED 强行违 M#1 / 0 抽 helper（per phase 461 inline 反例 / 各 site 业务 schema 异 / 不真共享 spec）/ silent corrupt schema 违 D2 + D5。

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 直 import `core/tools/registry`（ToolRegistryImpl）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（L4 不应直 L2 实现）/ M#8（耦合界面最小）~~ → phase364 VerifierScheduler 内化 ToolRegistry / cross-layer import 5/5 全清 |
| ~~A.2 直 import `prompts/subagent`（CONTRACT_VERIFIER_SYSTEM_PROMPT）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（prompts 跨层）~~ → phase364 VerifierScheduler 内部持有 prompt / 同 A.1 phase |
| ~~**A.3 直 import `prompts/retrospective`（buildRetroPrompt）**~~ ~~⚠ STALE / phase364 错治理~~ | ~~drift / 中~~ | **✅ closed by phase 426**（main `762340d1`）/ 反向 design phase / DELETE retro-scheduler.ts + ContractManager.retroScheduler 字段 4 引用清 / `scheduleRetro` standalone function（业务 body 1:1 保留）/ EvolutionSystem 直调 / port pattern reversal cluster 第 3 例 / phase411 emit `contract_completed` event 后 retro 业务由 EvolutionSystem 订阅自治触发 / ContractSystem 0 知 retro 概念 + 0 知 EvolutionSystem / 详 feedback_governance_workaround_smell + project_phase426_retroscheduler_stale |
| ~~A.4 ContractVerifierScheduler port (phase340 + phase364 错治理)~~ | drift / 中 | **✅ closed**（phase427）| **phase340 + phase364 错治理反向 + 真合规落地**：删 ContractVerifierScheduler interface + 整 verifier-scheduler.ts 文件 (112 行) + 5 caller 同步：manager.ts inline `_runVerifierSubagent` 私有 method (50+ 行 wrapper logic) + index.ts 删 re-export + assemble.ts 删参 + tests 重构 / ContractSystem 直 dep createSubAgent (L4→L3) + ReportResultTool/NoopWriters (L4→L2) + CONTRACT_VERIFIER_SYSTEM_PROMPT (L4→L4) 全 downward / 完全合 M#5 / 同 phase422/424 单 commit 模板（port pattern reversal 第 4 例 / cluster 6 port 闭 4）/ feedback_governance_workaround_smell 真合规设计落地 |
| ~~A.5 直 import `core/skill`（createSkillRegistry）~~ | ~~drift / 中~~ | **✅ closed（phase364）** | ~~M#5（L4 → L2 跳层）~~ → phase364 Path #1 framing 修正 grouping 归 RetroScheduler / SkillRegistry deps 注入 |
| ~~A.6 契约完成通知 inbox 缺失~~ | drift | **已闭环（phase350）** | `assemble.ts:contractNotifyCallback` 内追加 `notifyInbox` / β 双链路保险 / D8 事件驱动 align |
| ~~A.7 ContractObserver CLI 调用路径错误~~ | drift | **已闭环（phase350）** | `contract-observer.ts` 删 execFile cli fork / 改 `collectContractEvents` 直调（抽函数 `event-collector.ts`）/ KD#29 工具归属 align |
| ~~A.8 execFile 静默 catch（同 A.7 根因）~~ | drift | **已闭环（phase350）** | catch 加 `OBSERVER_EVENT_FAILED` audit / Coding #5 失败暴露 / 同 phase342 UNEXPECTED_ASYNC_THROW 模式 |
| **A.naming-1 code class 名 `ContractManager` ↔ 应然 `ContractSystem`** | naming drift / 大 | **✅ closed**（phase416 / main `b053aa1f`）| 实施落地：class `ContractManager` → `ContractSystem` + `createContractManager` → `createContractSystem` factory + 21 file caller import cascade + 测试同步 / ShellTool→CommandTool 反向 rename 模板首次应用（phase378 反向）/ ContractManagerPort 维持 STALE 不动 |
| **A.spec-1 应然 `list/log/done` method 应然幻象** | spec drift / 中 | **closed**（phase414c L4 audit / interfaces/l4.md 删 3 method 应然幻象）| 历史 interfaces 写 `list(filter?: ContractFilter): Promise<Contract[]>` + `log(contractId): ContractLog` + `done(contractId, result: ContractResult)` / 实然 0 实施 / `done` 实然由 `doneTool` 完成 (builtins/done.ts / phase360 物理迁) 不在 ContractSystem class method / `list` / `log` 实然由 `loadActive()` / `loadPaused()` + audit log 替代 / phase414c interfaces/l4.md 修订删 3 应然幻象 method |
| **A.spec-2 应然 simple Contract spec/lifecycle ↔ 实然 multi-subtask model** | spec drift / 大 | **closed**（phase414c L4 audit / interfaces/l4.md align 实然 ContractYaml + ProgressData + AcceptanceResult 多 subtask model）| 历史 interfaces 写 `ContractSpec { intent, acceptance, retryLimit?, escalationThreshold?, payload? }` + simple Contract lifecycle / 实然 ContractYaml multi-subtask schema (44+) + ProgressData per-subtask + AcceptanceResult / 实然加多 method (`getProgress` / `completeSubtask` / `isComplete` / `loadActive` / `loadPaused`) 应然 silent / pause + cancel 必填多参 (checkpointNote / reason) / `setOnNotify` callback 注入应然 silent / phase414c interfaces/l4.md 修订 align 实然 multi-subtask model + 删 ContractSpec / AcceptanceCriteria / ContractResult / ContractFilter / ContractLog / ContractCompletedHandler / ContractLockError 7 应然幻象 type |
| **A.bypass-1 ContractSystem 全 dir 直 import `node:fs`** | M#5 弱违反 / 中 | **✅ closed**（phase434 + phase436 / main `61c2a51e` + `b8a6b8ed`）| **L4 ContractSystem 全 dir 直 import OS API 绕 FileSystem L1 / 13 fsNative calls 全清 / 2 phase 拆**：**phase434 (5 calls)**：(1) manager.ts 4 lock ops (acquireLock + releaseLock) `fsNative.promises.{mkdir,writeFile(wx),readFile,unlink}` → `this.fs.{ensureDir, writeExclusiveSync, read, delete}`（wx 排他写 sync 等价同 ProcessManager.acquireLock 模式）(2) utils.ts 1 sync `getContractCreatedMs` `fs.readdirSync(...,{withFileTypes:true})` → `fs.listSync(..., {includeDirs:true})` 加 `fs: FileSystem` 参 + caller cascade。**phase436 (8 calls / Step 0 漏列补救)**：(3) jobs/event-collector.ts 4 calls (readdirSync × 2 + readFileSync × 2) → `fs.{listSync, readSync}` + 加 `fs: FileSystem` 参 (4) jobs/contract-observer.ts 4 calls (readFileSync + readdirSync + mkdirSync + writeFileSync) → `fs.{readSync, listSync, ensureDirSync, writeAtomicSync}` 用已有 fs instance + 内部 collectContractEvents 加 fs 参传。行为 0 改 / 1366 测试 PASS / 同 phase397 cleanup bypass 治理模板 / phase434 Step 0 漏 jobs/ → phase436 补救 / **`feedback_plan_by_main_implement_by_user §7 Step 0 grep scope 完整性纪律` 首发实证** / **bypass cluster 第 2/3 闭**（ContractSystem 全清 / 余 ProcessManager + Watchdog child_process / phase 437+ A2）|
| ~~**A.r68-2 verifier-job.ts `as any` 类型 cast 残留**~~ | ~~type hygiene drift / 小~~ | **✅ closed (phase 568 / `6863ff24`)** | **应然**：M#9 显式编译器可检 / `as any` 旁路 tsc 应消除（除非真有不可消除耦合）。**实然漂移**：`src/core/contract/verifier-job.ts:37,48` 2 处 `config.fs as any`（noop type cast / `VerifierConfig.fs: FileSystem` → `createDialogStore.fs: FileSystem` 与 `SubAgentOptions.fs: FileSystem` 类型链全 align FileSystem / 历史 phase 480 抽出 verifier-job.ts 时引入 / phase 509+514+518 后类型链稳定 / cast 残留）。**dispatch 标 ⚠️ 推 r+1 复审 → 实测 VERIFIED 真问题 / 非 phantom**（dispatch ⚠️ 标 ≠ phantom prior 第 N 实证）。**phase 568 治理**：α 删 2 处 cast / β 加注释「historical artifact」保 / γ 重写 type chain / dominant α / 28 原则 derive 5/5（M#7+M#9+M#10+Path #4+Path #7）|
| **A.contract-dir-schema-sweep progress.json + contract.yaml + event-collector parse 4 site type assertion 逃逸 schema 校验** | drift / 中 / r70 D fork phase 587 derive（phase 576 模板 N=2 实证扩） | **closed by phase 587**（main `5a8fb22b` / merge `074c114d`）| 实然 4 真问题 site：(1) `manager.ts:362` getProgress JSON.parse `as ProgressData` 0 catch + 0 schema → corrupt progress.json silent 流入 subtask 状态机；(2) `persistence.ts:32` loadContractYaml yaml.load `as ContractYaml` 0 catch + 0 schema → 用户编辑 yaml corrupt silent 流入 caller 链；(3) `discovery.ts:38` 已 try/catch + PROGRESS_CORRUPTED audit / 但 type assertion 逃逸 silent（`{"foo":"bar"}` parse OK + `?? ''` 兜底 → latest 比较错乱）；(4) `event-collector.ts:23+42` 既 silent `/* 跳过 */` 0 audit + type assertion 逃逸 → contract 升级事件漏报 → motion observer 漏发 inbox。**dispatch sweep 8 site / Path #1 实测 2 STALE 推翻**：(STALE-1) `lock.ts:36` phase 576 已闭 / (STALE-2) `contract-observer.ts:28` `?? 0` 防御 + 1 字段 motion 内部 state 首启 silent OK / (out-of-scope) `verifier-job.ts:74` LLM 外部输出不属 contract dir state assumption / 推 r71+ 单独评估。**phase 587 决策（28 原则核 5/5 一致 dominant 自决 / 模板复用）**：α inline schema check（typeof + Array.isArray / minimum viable required = ProgressData {contract_id+status+subtasks} / ContractYaml {title+goal+subtasks}）+ ε NEW 2 const `PROGRESS_SCHEMA_INVALID` + `CONTRACT_YAML_SCHEMA_INVALID`（lock + progress + yaml 三子域独立 / M#1 align / 0 复用 PROGRESS_CORRUPTED）+ 处置策略：getProgress / loadContractYaml schema_invalid → throw 进 caller catch（mirror phase 576 throw 进既有路径模板）/ discovery + event-collector schema_invalid → audit + continue（保 graceful skip 业务语义 / 单 corrupt 不阻其他 contract scan）/ event-collector silent → audit 升级 D2 align（silent X cluster N+1 实证）。**0 抽 helper**（4 site 业务 schema 异 / phase 461 inline 反例 align / YAGNI）。**0 引入 zod / ajv**（YAGNI / inline typeof 即够）。8 files +484 -8 / NEW tests/core/contract/schema-sweep.test.ts 380 行 / 反向 3 项 PASS |
| **A.lock-schema-validation lock 文件 JSON.parse 无 schema 校验 / corrupt 数据 silent 流入 audit + stale path** | drift / 中 / r69 C fork phase 576 derive | **closed by phase 576**（main `4f78e258`）| 实然 `src/core/contract/lock.ts:36` `const { pid, time } = JSON.parse(raw) as { pid: number; time: number };` type assertion 逃逸 / 损坏文件 `{"pid":"abc","time":null}` JSON.parse 成功不抛 → destructure 出非法值 / 外层 catch line 54 不接（仅接 invalid JSON） → `isAlive("abc")` process-control.ts:48-51 catch 兜底返 false → 走 `!isAlive(pid)` 分支 audit 字符串拼 `stale_pid_abc` + unlinkStaleLock / 或走 timeout 分支 `Date.now() - null = 巨大数` → audit `LOCK_CLEARED pid=abc timeout=...` / **audit 数据脏 / D5 日志重建受损 + D2 silent corrupt schema** / **dispatch claim 「isAlive 后续操作崩溃」STALE**（外层 catch + isAlive 内部 catch 双兜底已防崩 / 真问题 = audit 数据脏不是崩溃）/ **phase 576 决策（28 原则核 5/5 一致 dominant 自决）**：α inline schema check (`typeof pid === 'number' && Number.isFinite(pid) && typeof time === 'number' && Number.isFinite(time)`) / fail → audit `LOCK_SCHEMA_INVALID` + throw 进外层 catch（与现 corrupt JSON 同一处理路径 / 0 路径分裂 / M#7 align）+ ε NEW const `LOCK_SCHEMA_INVALID = 'contract_lock_schema_invalid'`（lock 子域独立事件 / 与既有 lock_cleared / lock_unlink_failed 同模型 / M#1 业务语义归属 align / 复用 progress_corrupted 强行 ζ 违 M#1 reject）|
| ~~A.bypass-2 contract-observer handler runtime instantiate L1 fs + L2 messaging+audit~~ | ~~M#5 弱违反 / 中~~ | **✅ closed**（phase 542 / main `e4338db0` / merge `ca1ca1d0`）| 应然：cron job handler deps 装配方注入（cross-ref `l5_cron.md §7.A.invariant 第 1 条` / phase 455 llm-stats 范例 align）。~~实然 `src/core/contract/jobs/contract-observer.ts:2-4` runtime import `notifyInbox` + `NodeFileSystem` + `createSystemAudit` + `:18,38,58` handler 内 3 重 instantiate（fs + audit + notifyInbox）~~ → phase 542 Step B 实施：`ContractObserverOptions` +`fs: FileSystem` +`motionAudit: AuditLog` +`notifyInbox: NotifyInboxFn`（γ 决策 5/5 原则一致 / phase 296+533 工厂闭包模板 N+1 实证）/ assemble.ts 装配段预 build clawforumFs + motionAudit + notifyInbox closure 注入 / handler 内删 3 runtime import + 3 instantiate / vitest 1510/1510 PASS / 反向 3/3 PASS / **与 phase 434+436 A.bypass-1（fsNative direct OS API）不同型补完**：bypass-1 = OS API direct call / bypass-2 = L1/L2 高级抽象 runtime instantiation / 同根 M#5 弱违反 cluster |

A.1-A.5 修复路径（phase364 已合并实施 / phase427 反向）：
1. ~~ContractVerifierScheduler 默认实现内部持有 prompts + skillRegistry + ToolRegistry 构造（移出 ContractSystem ctor）~~ → phase427 STALE 推翻：删 port abstraction / wrapper logic inline 回 manager.ts `_runVerifierSubagent`
2. 抽象「retro 调度 port」：`EvolutionSystemScheduler.schedule(config)` 替代 writePendingSubagentTaskFile 直 import
3. ContractSystem ctor 仅 4 必传：clawDir / clawId / fs / audit + 1 可选 port（retroScheduler）/ verifierScheduler 参删（phase427 inline）
4. M#8 耦合界面最小达成：phase427 后 verifier 路径 0 port abstraction / 直 dep concrete

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~异步 catch 块吞 TypeError~~ | drift | **已闭环（phase342）** / `isProgrammingBug` 检 + audit `UNEXPECTED_ASYNC_THROW` + rethrow / Coding #5 合规 |
| ~~双 audit writer + 10+ hardcoded events~~ | drift | **已闭环（phase345）** / `this.auditWriter?` 6 sites 治理为 const 引用 / caller 风格统一并轨第 1 次 |
| ~~应然滞后批量修订~~ | drift | **已闭环（r47 §A.1）** / VerifierConfig / VerifierResult / scheduler 签名 / §3 events 表 / §head SHA 同步 |
| ~~H6 异步通道完整迁移~~ | design-gap | **撤销 / 释义闭环（r48 用户原则 derive）** / verifier-scheduler sync 实现合规（业务本质 = 子代理执行 + 结果收集一原子操作）/ async 退化 thin wrapper 违 M#1+M#7+M#8 / 不需 design phase / 与 ToolExecutorImpl.taskSystem 同模板族（释义闭环 vs 释义豁免第 3 实证）|
| **ContractManager 双 audit writer 设计冗余** | **closed** | **phase359 清零**（main `3d7415938b6dc647b70c876f7e2c419160f0b456`）| β 方案落地：ctor 9→8 参 / 删 field auditWriter? / 44 处 this.auditWriter?.write → this.audit.write / index.ts factory + assemble.ts:192 同步 / 行为契约扩（7 caller 漏写 → 正写 / D1d 修 bug 副作用）/ M#7+M#8+M#6+D1d 全合规 / Group A 收尾 |
| ~~fire-and-forget 失败时 subtask 状态机语义~~ | design-gap / 中 | **✅ closed by phase 468（design only / 用户拍板 2026-05-04）** | 用户决策原文：「调用 done 验收失败可以继续重试，重点是给智能体提供验收反馈信息，指导更好地完成契约子项」/ 候选 β 锁定：3 种失败（LLM judged failed / programming bug throw / subagent timeout）**统一转 `'todo'`** + retry_count++ + last_failed_feedback / agent 自治 retry / max_retries 触发 escalation 后 subtask 仍 'todo'（D6 align）/ **重点 = feedback driven**：last_failed_feedback 升级为结构化 `{ feedback: string; cause: 'llm_rejected' \| 'programming_bug' \| 'subagent_timeout' }` + inbox `acceptance_failed` 通知含 cause + retry_count + max_retries / SubtaskStatus 4 态保留 / `'failed'` 当前 0 进入路径（dead enum 预留 / 不在 fire-and-forget 路径触发）/ 推 r+1 phase 469+ code 实装（phase 468 §5 Step B 已写改动清单）|
| **L4.G1 (contract-system)** ctor 不显式列 ProcessExec / Messaging / SubAgent / Tools / ToolProtocol cross-module dep | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l4.md ContractSystem ctor 接 fs + audit + llm? / 缺 ProcessExec（脚本 acceptance 子进程）+ Messaging（escalation 通知 + 验收结果 inbox 反写）+ SubAgent（verifier 子代理 / phase 427 后内联 _runVerifierSubagent 直 dep `createSubAgent`）+ Tools（verifier 用工具）+ ToolProtocol（doneTool 实现）/ arch 表 1 依赖列详细列 7 个 / interfaces 仅暴露其中 3 / 4 dep 是模块内部直 import vs ctor inject 区分 | **业务决策性 / 用户拍板候选**：α interfaces ctor 加缺漏 4 dep inject / β 注释明确「ProcessExec/Messaging/SubAgent/Tools/ToolProtocol 为模块内部直 import / 不经 ctor inject」/ γ 保留现状（同 L4.G1 task-system 同型 / dep 区分 inject vs direct 是 implementation detail）|
| ~~done 工具应然归 ContractSystem~~ | drift | **✅ closed**（phase360 / main `e3285d0`）+ **dir 命名一致性 phase451（main `b970af5a`）** | ~~r48 新登记~~ → 物理迁实施：`src/core/tools/builtins/done.ts` → `src/core/contract/builtins/done.ts`（git mv 保 history）+ contract/index.ts 加 export + Assembly 显式 `toolRegistry.register(doneTool)` + tools/builtins/index.ts 删 doneTool import/re-export/register / KD#29 子任务 done 落地 / ~~port pattern 应用模板第 5 次复用~~ ⚠ STALE：done 物理迁本身合理（业务工具归业务模块 own / M#2+M#3 真合规）/ 但「port pattern 第 5 次复用」标错（done 不是 port pattern / 是 tool ownership 转移）/ 详 feedback_governance_workaround_smell / phase347 dispatch 物理迁模板第 2 次复用 / M#1+M#2+M#3+M#5+M#7+M#8 全合规 / **phase451 follow-through**：`src/core/contract/builtins/done.ts` → `src/core/contract/tools/done.ts`（git mv 保 history / 同 layer peer 全用 `tools/` 命名约定 / memory + task + messaging + skill-system 一致）|
| ~~**statusTool L2→L4 type-import drift（ContractManager）**~~ ~~⚠ STALE / phase369 错治理~~ | ~~drift~~ | **✅ closed by phase 446 + phase 458**（cluster 8/8 收官）| phase 446 (`5374a4a`+) statusTool 物理迁 L5 StatusService own（per phase 446 模板 / 同 done 工具 phase360 / memory_search phase416 / send phase440 / skill phase442）/ phase 458 (`03c0cb9a`) ContractStatusPort STALE 推翻：DELETE contract-status-port.ts + status-port-impl.ts 2 抽象层文件 / statusTool 改 ContractSystem 直 dep（contractSystem field 替代 contractStatus / loadActive + 内联计算）/ L4 → L5 反向 import 全清 / 净 -59 行 / port pattern 推翻 cluster 第 8 例 / `feedback_governance_workaround_smell §5 cluster` 累 8/8 全收官（phase 422-432 7 + phase 446 立 + phase 458 推翻）|
| ~~**B.r68-1 PROGRAMMING_BUG_TYPES 跨模块 DRY violation（contract / evolution-system 共用语义）**~~ | ~~DRY drift / 中~~ | **✅ closed (phase 568 / `6863ff24`)** | **应然**：M#7 耦合界面稳定 + M#3 资源唯一归属 / 同业务语义 const + helper 应单源 / Coding #5 phase 342 fail-fast 行为锁定后跨模块复用应 import shared。**实然漂移**：3 site byte-identical 复制：(1) `manager.ts:64-67` (caller line 334) (2) `acceptance.ts:23-26` (caller line 189) (3) `src/core/evolution-system/system.ts:48-51` (caller line 266)。3 site 注释皆「per Coding #5 / phase342 / r40 反向 3 教训」/ 同根 fail-fast 设计。**dispatch 仅标 evolution-system / Step 0 sweep 扩 contract 2 site**（per `feedback_plan_by_main_implement_by_user §7 Step 0 grep scope 完整性纪律` 第 N+1 实证）。**phase 568 治理**：α 抽 src/types/errors.ts shared export `PROGRAMMING_BUG_TYPES` + `isProgrammingBug` / β 抽 NEW foundation/errors dir / γ 保留 3 site 复制 / dominant α / 28 原则 derive 5/5（M#3+M#7+M#8+Path #7）/ 同型 phase 564 §B duplicate audit 删模板 N=2（候选 lint 规则推 r70+）|
| B.1 CLI 直操路径（仅脚本 acceptance）| design-gap / 低 | 未传 llm / verifierRegistry → LLM acceptance 不可用 / 仅脚本 acceptance 工作 / 升档：CLI 路径需 LLM 验收时 → 装配 llm + registry |
| **代码注释过时：`_runVerifierSubagent` 仍标 H6 design-gap** | **doc drift / 低** | **`src/core/contract/manager.ts:277` 注释「H6 异步化 = 独立 design-gap / 推 r+1 design 评估」与当前设计文档 §7.B「H6 撤销 / 释义闭环」矛盾** / verifier sync 实现已合规（业务本质 = 子代理执行 + 结果收集一原子操作）/ async 退化 thin wrapper 违 M#1+M#7+M#8 / 代码注释应同步更新为「H6 已撤销 / sync 实现合规 / 详见 design/modules/l4_contract_system.md §7.B」| 推 r+1 顺手清理：更新注释 + 删除过时 TODO |
| **B.r68-2 verifier-job.ts cleanup audit injection 缺口** | **drift / 中（D1d+D2 violation / 设计已知）** | ✅ **closed by phase 646（C fork r79 / commit main `40ff2f95` / merge `4f1ebb52`）** | **应然**：D1d 事后可审计 + D2 不丢弃/不静默。**phase 567 H fork B-P1.1 浮出**（main `10b58fb4`）/ 同根 phase 542 `§A.bypass-2` ContractObserverOptions inject 模板 + phase 541 silent X cluster 跨模块 N+1。**phase 646 实施（C fork r79）**：α VerifierConfig +`audit?: AuditLog` optional field + NEW const `VERIFIER_CLEANUP_FAILED: 'contract_verifier_cleanup_failed'` + verifier-job.ts:85-87 catch 加 `config.audit?.write(VERIFIER_CLEANUP_FAILED, agent, reason)` + acceptance.ts:503 caller cascade `audit: ctx.audit` / mirror phase 542 模板 / **r68 admit 升 r+1+ 经 r68→r70→r72→r74→r76→r78→r79 8 r 轮兑现** / **「audit injection α 模板」N+1 实证累**（phase 542+591+604+611+614+615+633+646）|
| **B.flaky-1 `contract_manager_llm.test.ts` LLM Acceptance `passed=true` 文件系统竞态** | **flaky test / 低** | **open / 2026-05-09 phase563 发现，phase597、phase660、phase683、phase712 再次复现** | `tests/core/contract_manager_llm.test.ts > ContractSystem Acceptance Flow > LLM Acceptance > should pass when LLM acceptance returns passed=true` 偶发 `ENOENT: no such file or directory, open .../contract/active/<id>/progress.json` / 根因：LLM acceptance 异步 fire-and-forget 流程中 progress.json writeAtomic 后 test 立即 read，文件系统竞态 / **与 phase563 修改无关**（phase563 只触及 llm-provider + snapshot，0 触及 contract_manager_llm）/ **phase597 全量运行时再次复现**（1594 tests 中 1 failed，单独运行 22/22 PASS）/ **phase660 全量运行时再次复现**（1676 tests 中 1 failed，第二次全量运行 1676/1676 PASS）/ **phase683 merge 后全量测试再次复现**（1676 tests 中 1 failed，单独运行 22/22 PASS）/ **phase712 全量测试再次复现**（1698 tests 中 1 failed，单独运行 22/22 PASS）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（mock fs 消除竞态 或 read 前加稳定 await）|
| **B.flaky-2 `contract_manager_llm.test.ts` LLM Acceptance `capturedResult` 收集竞态** | **flaky test / 低** | **open / 2026-05-10 phase646 发现** | `tests/core/contract_manager_llm.test.ts > ContractSystem Acceptance Flow > LLM Acceptance > should prefer capturedResult over text when report_result tool is called` 偶发 `expected [] to have a length of 1 but got +0` / 根因：report_result tool 调用后 capturedResult 数组收集竞态（异步 verifier 子代理写结果与 test 断言读数组时序不确定）/ 首次 `pnpm vitest run` 全量执行时失败，单独运行 `pnpm vitest run tests/core/contract_manager_llm.test.ts` 及第二次全量运行均 PASS / **与 phase646 修改无关**（phase646 只触及 verifier cleanup audit + injector context load，0 触及 contract_manager_llm capturedResult 逻辑）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（mock fs 消除竞态 或 read 前加稳定 await）|
| **B.flaky-3 `contract_manager_llm.test.ts` Script Acceptance `should pass when script acceptance succeeds` 竞态** | **flaky test / 低** | **open / 2026-05-10 phase655 发现，phase664、phase666 再次复现** | `tests/core/contract_manager_llm.test.ts > ContractSystem Acceptance Flow > Script Acceptance > should pass when script acceptance succeeds` 偶发 `expected 0 to be greater than 0` / 根因：脚本验收异步 fire-and-forget 流程中 test 断言与文件系统/进程状态竞态 / **与 phase655、phase664、phase666 修改无关**（phase655 只加 comment / phase664 只加 comment / phase666 只触及 Runtime test helper，0 触及 contract_manager_llm 逻辑）/ 单独运行 `pnpm vitest run tests/core/contract_manager_llm.test.ts` 22/22 PASS / 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（mock fs 消除竞态 或 read 前加稳定 await）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：契约生命周期独立业务域 / 不与 AsyncTaskSystem 共享 state
- **M#2 业务语义归属**：acceptance / state 迁移 / archive / retro 由本模块发起
- **M#3 资源唯一归属**：contract/active|paused|archive 三目录独占
- **M#4 持久化**：progress.json + contract.yaml + lock + acceptance scripts 全落盘
- **M#5 依赖单向**：L4 → L1 (FileSystem / ProcessExec 脚本 acceptance) + L2 (AuditLog / Messaging / ToolProtocol / ReportResultTool / NoopWriters) + L3 (createSubAgent / verifier 子代理 phase427 后直 dep / 同 file-level CONTRACT_VERIFIER_SYSTEM_PROMPT L4→L4) / 同层 emit `contract_completed` event callback (Assembly wire EvolutionSystem 订阅 / 不再 own retro 业务 phase411)（per arch §22 表 1）/ 不反向依赖 Runtime / Daemon / 5 直 import 跨层历史已闭环
- **M#6 依赖结构稳定**：ctor 一次注入 / 运行期不变
- **M#7 耦合界面稳定**：公共 7 方法形态稳定（create / done / pause / resume / cancel / list / log）/ phase340 0 改
- **M#8 耦合界面最小**：⚠ STALE「port pattern 已立」叙事 2026-05-03 推翻 / ctor 8 参（phase359 collapse 后 / 双 audit writer 设计冗余 closed）/ 真合规 = ContractSystem 直 dep AsyncTaskSystem + emit event / 详 §A.3+A.4 STALE + feedback_governance_workaround_smell
- **M#9 显式编译器可检**：port interface 类型化 / 注入参数显式 / phase345 caller 风格统一并轨后 17 events 全 const 引用
- **M#10 不合理停下**：phase340 H6 假设修正 → 推 r41+ design 评估 / 不 mechanical
- **M#11 边界对不上停下**：A.1-A.5 显式登记不静默 / phase364 闭环

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：17 events 覆盖 / phase342 异步 catch 修
- **D1b 状态可观察**：contract / progress / lock 文件 + audit events 可观察
- **D1c 中断可恢复**：progress.json 持久化 + lock 保护
- **D1d 事后可审计**：phase342 + phase350 双闭环
- **D2 不丢弃 / 静默**：phase342 异步 catch 吞 TypeError 修 / phase350 OBSERVER_EVENT_FAILED 修
- **D3 用户可观察**：contract / progress / lock 文件 + audit events 可观察
- **D4 LLM 调用恢复**：LLM 验收路径直 dep createSubAgent 调度 verifier 子代理 / verifier 失败可重试（phase427 后 verifier 路径不再经 port abstraction / 直 dep）
- **D5 日志重建**：17 events 覆盖主路径
- **D6 子代理后不阻塞**：acceptance fire-and-forget / done 工具立即返回 / 异步 inbox 通知
- **D7 系统可信路径**：acceptance 走 ProcessExec / verifier 经 createSubAgent (L3) 直 dep / 不绕过
- **D8 事件驱动**：inbox 消息 + audit 事件 / phase350 contractNotifyCallback inbox 链路打通 / phase411 emit contract_completed event 给 EvolutionSystem 订阅
- **D9 CLI 唯一外部入口**：N/A（contract CRUD CLI 命令属 L6 CLI / 本模块 L4 业务接口供 caller 调）
- **D10 多 claw 不隔绝**：contract 通知 inbox 跨 claw 路径打通（phase350 notifyInbox + onNotify callback β 双链路）
- **D11 motion 单向访问**：本模块不涉及 motion 边界

#### Philosophy（4 条）

- **P1 Agent 即目录**：contract/<id>/ 是 contract 单元目录 / contract.yaml + progress.json 是 contract claw 状态锚点
- **P2 上下文工程**：contract claw 通过 progress 文件管理上下文
- **P3 分多个智能体加分子任务**：verifier 子代理独立窗口 / 不污染 contract claw
- **P4 系统为智能体服务**：acceptance + retro 为 contract claw 决策提供信息

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：phase340 实测 5 残 import / 0 推翻 / 写入 §7.A（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：APPEND-only §7 / phase340 单 commit port 立 + 删 2 import 不附带 caller 风格统一 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 verifier 实现而不动 caller —— phase427 后直 dep ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：phase340 fork mechanical 异步化 → framing 修正 → 停 mechanical 推 design 评估（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase338 / phase340 / phase342 / phase345 / phase346 / phase350 / phase359 / phase360 / phase364 / phase369 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-27 / phase340 H6+H11 ContractVerifierScheduler port + 删 2 直 import（subagent + report-result）/ port pattern 第 3 次复用里程碑 / 反向 3/3 强 PASS / 暴露异步 catch 块吞 TypeError ⚠ STALE 2026-05-03 推翻：port pattern 是 design smell / 应然真合规 = ContractSystem 直 dep AsyncTaskSystem / 详 feedback_governance_workaround_smell
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
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Design Principles D4 verbatim「LLM 调用恢复」+ 加 D9 N/A + D10 跨 claw inbox 链路 align principles.md / M#5 phase427 后 stale 同步 = createSubAgent + ReportResultTool 直 dep + emit contract_completed event 给 EvolutionSystem 订阅 / audit events 23→17 计数 align phase383 后 RETRO_* 6 events 迁出）
- 2026-05-04 / **phase 458 ContractSystem 不再 provide ContractStatusPort impl**（`03c0cb9a`）/ DELETE status-port-impl.ts / L4 ContractSystem 0 反向 import L5 StatusService / statusTool 直 dep ContractSystem.loadActive + 内联 view 计算 / port pattern 推翻 cluster 第 8 例收官 / `feedback_governance_workaround_smell §5 cluster` 累 8/8 全收官（phase 422-432 7 + phase 446 立 + phase 458 推翻）
- 2026-05-04 / phase462 barrel hygiene Tier 1（main `aaa91f39`）/ contract/index.ts 加 `type ContractYaml` re-export + caller barrel-bypass 修正（runtime.ts:40 + cli/commands/start.ts:23 + cli/commands/contract.ts:10 + src/index.ts:29）/ M#7 耦合界面稳定 align / assembly 装配期 reach 内部不改（合规 pattern 同 phase360 模式）/ Tier 2（contract/utils.js + contract/jobs/event-collector.js helper barrel expand）推 r+1
- 2026-05-04 / phase463 barrel hygiene Tier 2（main `b52c1cca`）/ contract/index.ts 加 2 re-export（`getContractCreatedMs` from utils.js + `collectContractEvents` from jobs/event-collector.js）+ 4 caller barrel-bypass 修正（cli/chat-viewport.ts:14 + watchdog/watchdog.ts:24 + cli/commands/contract.ts:11）/ M#7 耦合界面稳定 align / **phase462+463 cluster 全闭**（barrel hygiene Tier 1 主类型 + Tier 2 helper 全收）/ assembly 装配期 reach 内部不改（合规 pattern）
- 2026-05-05 / **phase 480 ContractSystem 内部完整模块化拆分**（main `dbf9017a`）/ manager.ts 1358 → 482 行（净 -876）/ +7 NEW sub-module（types.ts 75 + lock.ts 111 + verifier-job.ts 69 + discovery.ts 85 + persistence.ts 100 + lifecycle.ts 108 + acceptance.ts 595）/ M#1 独立可变职责分离 align / public API 0 改 / disk path 0 改 / audit context 字符串契约 0 改 / 1369 tests PASS / **L4-L6 模块内重构阶段首发实证**（cross-module 边界重构全收官后 / 转模块内重构）/ ContractSystem class 保留为 thin orchestrator + 13 thin delegate（保 tests white-box spy 调用面 + cross-process audit 字符串契约）/ 实施期浮出 2 处计划遗漏：(1) LifecycleContext 漏 checkAllSubtasksCompleted 注入（agent 自补）/ (2) acceptance.ts withProgressLock 须经 ctx callback（spy 经 manager thin delegate 拦截 / 直调模块函数 spy 失效）→ 升格元判据「**sub-module 拆分跨调用必经 ctx callback / 不直调模块函数 / 保 tests spy 调用面**」 / `feedback_plan_by_main_implement_by_user §跨 sub-module 调用纪律` 候选
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l4_contract_system.md vs arch §22 + 表 1/2/3 + interfaces/l4.md ContractSystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a/b/c/d + D2-D11 + Philosophy P1-P4 + Path #1+#3+#6）/ 9 主能力 align arch 表 2 / 7 dep + caller list（含 EvolutionSystem 事件订阅方非 caller）align arch 表 1 / done 工具 5 维度承诺 align arch 表 3 / 修 §7.A A.3 ⚠ STALE → ✅ closed by phase 426（RetroScheduler STALE 推翻 main `762340d1`）+ §7.B statusTool L2→L4 ⚠ STALE → ✅ closed by phase 446+458（ContractStatusPort cluster 8/8 收官 main `03c0cb9a`）/ design only / 0 src 改
- 2026-05-08 / phase 542 §A.bypass-2 contract-observer handler runtime instantiate closed（main `e4338db0` / merge `ca1ca1d0` / r66 B fork / 起步 SHA `ad4c0320` / 主会话 Step A design + user Step B+C code）/ ContractObserverOptions +fs+motionAudit+notifyInbox / 装配方注入 / handler 内删 3 runtime import（NodeFileSystem + createSystemAudit + notifyInbox）+ 3 instantiate / 与 l5_cron §A.bypass-2 (disk-monitor 同型) 同 phase / vitest 1510/1510 PASS / 反向 3/3 PASS / **与 phase 434+436 A.bypass-1（fsNative direct OS API）同根 M#5 弱违反 cluster 不同型补完**：bypass-1 = OS API direct / bypass-2 = L1/L2 高级抽象 runtime instantiation / **「业务决策性 → 28 原则核 5/5 一致 → dominant 自决」第 N 实证累**（phase 520+521+522+531+537+542）
- 2026-05-10 / **phase 646 §B.r68-2 verifier-job cleanup audit injection 落地**（C fork r79 / commit main `40ff2f95` / merge `4f1ebb52` / 起步 SHA `06276037`）/ phase 567 H fork B-P1.1 浮出 → r68 admit 升 r+1+ 经 r68→r70→r72→r74→r76→r78→r79 8 r 轮兑现 / α VerifierConfig +`audit?: AuditLog` optional field + NEW const `VERIFIER_CLEANUP_FAILED: 'contract_verifier_cleanup_failed'` + verifier-job.ts:85-87 catch 加 `config.audit?.write(VERIFIER_CLEANUP_FAILED, agent, reason)` + acceptance.ts:503 caller cascade `audit: ctx.audit` / mirror phase 542 ContractObserverOptions 模板 / §B.r68-2 closed by phase 646 / **「audit injection α 模板」N+1 实证累**（phase 542+591+604+611+614+615+633+646）/ **「fan-out review → r+1 P1 cluster fix single phase」N=2 升格阈值达**（phase 636 + 646 / 推 r80+ 升格独立 feedback）/ **silent X cluster cross-module N+1 实证累**（与 dialog/injector context load 差异化同 phase 双 silent 修）
- 2026-05-09 / **phase 587 contract dir JSON.parse / YAML.parse schema 校验 sweep（D fork r70 / main `5a8fb22b` / merge `074c114d` / 起步 SHA `45ce8766`）**（code phase / 主会话 plan + 用户 code）/ phase 576 模板 N=2 实证扩 / sweep 8 site → 4 真问题 fix + 2 STALE 推翻 + 1 out-of-scope（dispatch stale ratio 29%）/ ε NEW 2 const（`PROGRESS_SCHEMA_INVALID` + `CONTRACT_YAML_SCHEMA_INVALID`）+ 4 site cluster fix（manager.ts:362 getProgress + persistence.ts:32 loadContractYaml + discovery.ts:38 + jobs/event-collector.ts:23+42）+ event-collector silent `/* 跳过 */` → audit 升级（silent X cluster N+1 实证）/ §A.contract-dir-schema-sweep closed by phase 587 + ⚓ invariant phase 576 sharpen 扩范围（lock + progress + yaml 三子域）/ 8 files +484 -8 / NEW tests/core/contract/schema-sweep.test.ts 380 行 / 反向 3 项 PASS / **「JSON.parse type assertion 逃逸 schema 校验」第 2 实证升格阈值达**（phase 576 首发 + 587 cluster fix = N=2 / 推 Meta 39+ 升格独立 feedback「inline schema check + 子域独立 NEW const + 0 抽 helper + 0 复用强行违 M#1」）/ **「review claim 实测四态分类」第 5 phase 实证**（phase 556+563+567+581+587 / 模板深度成熟）/ **silent X cluster 跨模块 第 9 实证累**（523+531+541+552+555+558+561+576+587）/ **「sweep cluster fix 多 site 单 phase」模板**（mirror phase 537 path safety + phase 552 cron + 587 contract dir）/ **「业务决策性 → 28 原则核 5/5 一致 → dominant 自决」第 12 实证累**（520+521+522+531+537+542+545+552+561+576+581+587）
- 2026-05-09 / **phase 567 H fork 深度复审 fan-out**（design only / 0 src 改 / r68 / 起步 SHA `10b58fb4`）/ contract 视角 sub-agent B 浮出 3 P0 + 3 P1 / 主会话 Path #1 spot-check 四态分类：(VERIFIED tight) B-P0.3 isProgrammingBug 跨 manager+acceptance 14 行 byte-identical 复制 → 与 I fork B.r68-1 cross-check 合并（同根 PROGRAMMING_BUG_TYPES 跨 contract+evolution-system 3 site / phase 568 治理 dominant α 抽 src/types/errors.ts）/ (VERIFIED 部分注释已知) B-P1.1 verifier-job.ts:83-88 cleanup audit injection 缺 → 升 §B.r68-2 NEW row（推 r69+ code phase / 0 业务决策 自决）/ (STALE 推翻) B-P1.2 L4.G1 ctor cross-module dep → §B 已登记业务决策性 / 同 phase 505 TaskSystem L4.G1 closed β dominant 「模块内部直 import 是合规模式」/ 跨模块同型 / B-P0.1+B-P0.2 (MOVE_ARCHIVE_FAILED + CREATED 双写) phase 564-stepa branch 已修待 merge / 不重新治理 / **「主会话代码审查 fan-out 模板」第 3 实证**（r65 + r67 + r68）+ **「review claim 实测四态分类」第 3 phase 实证**（phase 556 + 563 + 567）+ **design only 单 Step 内联模板第 5 实证**（503+505+545+554+567）+ **跨 fork sub-agent claim cross-check 第 1 实证**（H fork 独立浮出 isProgrammingBug DRY 与 I fork B.r68-1 同根 / 验证不同视角 sub-agent 独立产出可 converge）/ **「dispatch stale ratio P0+P1」N+1 实证**（H 视角 stale ratio 28% / framing refine + STALE 合 44% / r66+r67 教训 33-75% bracket 一致）
- 2026-05-09 / **phase 564 silent → audit cluster A（B fork r68）**（main `57daff7b`）/ 4 site silent → audit + 2 NEW dialog audit const + duplicate audit 删模板 N=2 实证：(P1.1) `acceptance.ts:141-144` 删第一条重复 MOVE_ARCHIVE_FAILED audit 保 line 145 完整 context+message+error superset / (spot-check) `manager.ts:362` 删第二条重复 CREATED audit 保 line 361 full（contractId+subtasks+title）/ 同根 duplicate audit 删模板第 2 实证累（candidate lint 规则推 r70+）/ Path #1 实证 dispatch claim 5/5 真（**「直觉 bug → phantom」反命题第 2 实证累** / phase 557 4/4 + phase 564 5/5 / 与 phase 539+541+544+556 stale 实证形成平衡 cluster）/ silent X cluster feedback N+1 实证累 / cross-cutting 同 phase：l2_dialog_store §A.archive-silent + l6_cli §A.viewport-task-events-default 同 closed

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#30 | ContractSystem LLM verifier 经 AsyncTaskSystem 调度 | **部分实施**（H11 完整：删 2 直 import + port 立 / H6 异步化推 r41+ design）|
| KD（待编号）| acceptance fire-and-forget D6 | ✓ phase342 异步 catch 修 |
| KD#29 | 工具归属 / collectContractEvents 抽函数 | ✓ phase350 align |
| KD#29 子任务 done | 工具归属 / done 工具物理迁 ContractSystem | ✅ 闭环（main `e3285d0f6ba9ff67b8238812bbf4956d1c84da0c`）+ phase451 dir rename（main `b970af5a`）| done 工具物理迁 `src/core/tools/builtins/done.ts` → `src/core/contract/builtins/done.ts` / contract/index.ts 加 export / Assembly 显式 register / registerBuiltinTools 函数语义边界规整（仅 L3 tools 不含 L4 业务工具）/ M2 反向测试通过 / 同 phase347 dispatch 模板第 2 次复用 / **phase451 follow-through**（main `b970af5a`）：dir 命名一致性 `builtins/` → `tools/` |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **CRUD**：create / loadActive / loadPaused / pause / resume / cancel / archive 全路径
- **acceptance 路径**：脚本路径走 ProcessExec / LLM 路径直 dep AsyncTaskSystem 调度 verifier 子代理（同层单向 / ⚠ 原「verifier port + port mock 测试」叙事 2026-05-03 STALE / 详 §A 系列 + feedback_governance_workaround_smell）
- **state machine**：active ↔ paused ↔ archive 三态迁移 + lock 防并发
- **acceptance fire-and-forget**：D6 不阻塞 done 工具返回 / 结果走 inbox 异步通知
- **isProgrammingBug 检**：`_runAcceptanceInBackground` catch 块识别编程 bug → audit `UNEXPECTED_ASYNC_THROW` + rethrow
- **lock 竞争**：LOCK_MAX_RETRIES + stale lock 清理
- **审计回链**：每个 §5 CONTRACT_* 事件触发时机 + 载荷断言（17 events 全覆盖）
- **port pattern 反向**：port 接口签名错 → tsc fail / port 调用契约破坏 → mock test 断言 fail / port 注入断裂 → contract test fail
- **collectContractEvents 抽函数**：observer + cli 共调 / 失败 catch 写 OBSERVER_EVENT_FAILED audit
- **ContractObserver L5 cron 视察**：直调 collectContractEvents（不 fork cli）
- ~~H6 异步通道 / fire-and-forget / 双 audit writer design-gap~~ — **r48 derive + phase 468 闭环**：H6 异步通道 撤销 / 双 audit writer 升 drift β 锁定 + phase359 清零 / fire-and-forget 失败 subtask 状态机语义 ✅ closed by phase 468（feedback driven / 候选 β + 结构化 LastFailedFeedback / 详 §7.B closed row）/ r48 derive 后剩唯一真 design-gap 全清

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile 准入+不变量）。失败语义留全工具集统一深度讨论。
> ContractSystem own 的 agent 工具：done（L4 / 物理迁自 AsyncTaskSystem / phase360）。
> **工具构造**：`createDoneTool(contractManager: ContractSystem): Tool` 工厂闭包（phase 533 / caller DIP enforce / 0 module-level mutable / deps 编译时必选）。

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
| 验收失败（LLM judged failed）| acceptance 失败 / cause `'llm_rejected'` / 含 reason + issues + 改进建议 / agent 改进 subtask 实施后重 done |
| 验收失败（programming bug throw）| acceptance 失败 / cause `'programming_bug'` / 含错误类型 + 消息 + 提示「系统 bug / 修代码后 retry」/ subtask reset 'todo' / retry_count++ |
| 验收失败（subagent timeout）| acceptance 失败 / cause `'subagent_timeout'` / 含 timeout 时长 + 提示「资源 / 网络问题 / 重试可能修复」/ subtask reset 'todo' / retry_count++ |
| 达 max_retries 触发 escalation | escalation 通知 / subtask 仍 'todo'（不强制状态机进 'failed' / D6 决策权归 agent）|

**关键承诺**：

- **done 不阻塞 acceptance**（fire-and-forget / D6 满足）
- **done 调用即返**（不等 acceptance 跑完）
- **acceptance 失败 inbox 投递必送达**（β 双链路：onNotify callback + notifyInbox / phase350）
- **isProgrammingBug 检**：acceptance fire-and-forget 内部 catch 块识别编程 bug → audit `contract_unexpected_async_throw` + rethrow（phase342）
- **失败 = 可重试（feedback driven / phase 468）**：done 调用 acceptance 失败 → subtask 自动 reset 'todo' + retry_count++ + last_failed_feedback 记 / agent 拿到结构化反馈（cause + feedback 主体 + retry_count + max_retries）后改进 subtask 实施 / 重调 done 触发新一轮 acceptance / 直至 passed 或 max_retries escalation
- **last_failed_feedback 结构化承诺**：`{ feedback: string; cause: 'llm_rejected' | 'programming_bug' | 'subagent_timeout' }` / cause 字段帮 agent 区分系统 bug vs 业务失败 / 不引入新 SubtaskStatus 进入路径
- **inbox `acceptance_failed` 通知 payload 承诺**：含 contract_id + subtask_id + cause + feedback + retry_count + max_retries / agent 决策上下文完整

**【4. 副作用 + 跨通道影响】**

- **fs 写**：`contract/active/<id>/progress.json` 更新（writeAtomic / lock 保护）
- **acceptance 触发**：`_runAcceptanceInBackground` fire-and-forget
  - 脚本 acceptance → 经 ProcessExec 跑 `acceptance.sh`
  - LLM acceptance → 直 dep AsyncTaskSystem 调度 verifier 子代理（同层单向 / ⚠ phase340 port 已 STALE / 详 §A 系列 + feedback_governance_workaround_smell）
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

## phase 684 — Sub-B fan-out contract lock + saveProgress design row

### B-P2.7 saveProgress lock scope ⚠️ unverified（已 closed by phase 679）

- **状态**：phase 679 §2 已 Path #1 实测 STALE
- **结论**：closed by phase 679 / 所有 saveProgress caller 均在 withProgressLock 内 / 锁 scope 正确

### B-P2.9 contract lock corrupt path 双 audit

- **claim**：schema invalid throw 后被 corrupt path bare catch 捕获 → 双 audit
- **状态**：C3 STALE phantom
- **结论**：closed by phase 684 / 双 audit 是 design intent（提供更多上下文 / fall-through 进 corrupt cleanup 是合理）/ 不 land

## phase 695 — r93 E fork V2-P1.1 contract YAML 跨 8 test file 内联 schema 抽 builder 业务决策 row

### V2-P1.1 跨 8 file 内联 YAML schema（builtins / done_tool / contract_manager / contract-concurrency / contract / schema-sweep / contract_manager_llm / retrospective）

- **claim**：src/core/contract 近 50 commit 中 15+ 涉及 schema / 8 file 内联完整 YAML（schema_version + deliverables + subtasks + acceptance + auth_level）/ 任一字段 rename → 8 file 同步漂移风险
- **业务决策**：抽 `makeContractYaml({ ... })` 共享 builder ROI
- **选项**：
  - α：抽 builder + 8 file 全迁移（独立 r94+ phase / 1-2 phase 工作量 / 防未来 schema 漂移）
  - β：保现状（churn 已 stabilize / phase 657 后 schema 改动放缓 / 内联 MVP）
  - γ：抽 builder 但 only high-churn file（5 个）/ 3 边缘 file 保现状
- **28 原则核**：
  - M#9 接口最小化 → α（共享 builder = 单点 schema 入口）
  - YAGNI（0 已知漂移 bug）→ β
  - 历史 churn 15+ commit → α 防御性 ROI 高
- **主会话预期**：α 抽 builder（作 r94+ 独立 phase）
- **决策状态**：**closed by phase 703**（r94 D-3 / α — NEW `tests/helpers/contract-yaml.ts` `makeContractYaml(Partial<ContractYaml>)` builder + 8 file 82 处 inline → builder call / 28 原则 derive：ML「不可消除耦合显式表达」+「编译器检查」+「单点耦合」推翻 β/γ / 用户确认 framework 后主会话自决 land）
