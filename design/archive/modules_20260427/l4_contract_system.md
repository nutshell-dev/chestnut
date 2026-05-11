# L4 ContractSystem

**应然**：契约生命周期管理 — 加载 / 进度跟踪 / acceptance（脚本 + LLM verifier 子代理）/ 状态迁移 / 归档。L4 不直接持有 L2/L3 内部模块引用 / 通过 port 接口（如 `ContractVerifierScheduler`）调度子代理执行 verifier。

**实然**：落地 `src/core/contract/manager.ts`（1386 行 / `ContractManager` class）+ `src/core/contract/verifier-scheduler.ts`（117 行 / port + default impl）+ `src/core/contract/audit-events.ts`（22 events）+ `src/core/contract/utils.ts`（`getContractCreatedMs` / phase346 从 watchdog-utils 迁出）+ `src/core/contract/jobs/contract-observer.ts`（L5 cron 视察 job / 物理同目录 / 语义独立）。verifier 路径同步 sync 实现（B.p340-1 design-gap 推 r41+ 评估）。

**归属**：L4 业务域 — 契约生命周期。

- **应然依赖**：FileSystem（L1）、LLMService（L1）、AuditWriter（L2）、Messaging InboxWriter（L2）、ProcessExec（L1 / acceptance script 执行）、ContractVerifierScheduler port（消费方 own / phase340 立）
- **实然额外耦合**（§7.A drift）：直 import L2/L3 内部 5 处（tools/registry / prompts/subagent / prompts/retrospective / task/tools/_pending-task-writer / skill）

---

## 1. 所有权

### 归属层

L4 业务域。被谁调用：
- **CLI**：`contract create / pause / resume / cancel / status` 等命令直 new ContractManager 或经工厂
- **Assembly**（`src/assembly/assemble.ts`）：构造点 / 注入 verifierScheduler default impl + verifierRegistry（profile filter）
- **TaskSystem**（间接）：done 工具触发 subtask completion / 经 ContractManager 内部持有引用调 `completeSubtask`

### 职责（做）

1. **契约 CRUD**：create / loadActive / loadPaused / pause / resume / cancel / archive
2. **进度跟踪**：progress.json 读写 / subtask 状态机（todo / in_progress / done）
3. **acceptance 调度**：脚本路径走 ProcessExec / LLM 路径**走 port**（`ContractVerifierScheduler.schedule`）
4. **state machine**：active ↔ paused ↔ archive 三态迁移 + lock 文件防并发
5. **审计**：22 events 全程发出 / 独占 `CONTRACT_AUDIT_EVENTS` 命名空间
6. **retro 触发**：contract 完结时调 `writePendingSubagentTaskFile` 触发 retro subagent task

### 不做

- **不直接 new SubAgent**（phase340 已通过 verifier-scheduler port 解耦 / 删 2 直 import）
- **不调用 TaskSystem.scheduleSubAgent**（retro 路径走 `writePendingSubagentTaskFile` 直写 fs / 与 SubAgent spawn 同模式 / phase163 立）
- **不解析 LLM 响应内容**（verifier port 返 `VerifierResult.passed` / contract 只看判定结果）
- **不管 verifier subagent 内部生命周期**（port 抽象内）

### 资源

| 资源 | 类别 | 归属位置 |
|---|---|---|
| `contract/active/<id>/contract.yaml` | 持久化（独占） | ContractManager 独占 / `activeDir = 'contract/active'` @ manager.ts:110 |
| `contract/active/<id>/progress.json` | 持久化（独占） | 同上 |
| `contract/paused/<id>/*` | 持久化（独占） | `pausedDir = 'contract/paused'` @ manager.ts:111 |
| `contract/archive/<id>/*` | 持久化（独占） | `archiveDir = 'contract/archive'` @ manager.ts:112 |
| `contract/active/<id>/.lock` | 持久化（独占） | LOCK_MAX_RETRIES + LOCK_STALE_TIMEOUT_MS 防并发 |
| `acceptance.sh` / acceptance prompts | 持久化（独占） | contract dir 内 |
| `verifierScheduler` 字段 | 运行时派生 | port 注入 / 默认 fallback `createSubAgentVerifierScheduler()` |

---

## 2. 接口

### 类型签名

```ts
// src/core/contract/manager.ts
export class ContractManager {
  constructor(
    clawDir: string,
    clawId: string,
    fs: FileSystem,
    audit: AuditWriter,
    llm?: LLMService,
    verifierRegistry?: ToolRegistryImpl,
    auditWriter?: AuditWriter,
    verifierScheduler?: ContractVerifierScheduler,  // phase340 新增 / port 注入
  );
  setOnNotify(cb: (type: string, data: Record<string, unknown>) => void): void;
  async loadActive(): Promise<Contract | null>;
  async loadPaused(): Promise<Contract | null>;
  async create(contractYaml: ContractYaml): Promise<string>;
  async getProgress(contractId: string): Promise<ProgressData>;
  async completeSubtask(params: {...}): Promise<void>;
  async pause(contractId: string, checkpointNote: string): Promise<void>;
  async resume(contractId: string): Promise<Contract>;
  async cancel(contractId: string, reason: string): Promise<void>;
  async isComplete(contractId: string): Promise<boolean>;
  async handleReviewRequest(...): Promise<...>;
}

// src/core/contract/verifier-scheduler.ts (phase340 立 / 消费方 own port)
export interface ContractVerifierScheduler {
  schedule(input: {
    agentId: string;       // 必前缀 'verifier-' / 测试 mock 用此判
    systemPrompt: string;
    userPrompt: string;
    maxSteps: number;
    registry: ToolRegistryImpl;
    auditWriter: AuditWriter;
    fs: FileSystem;
  }): Promise<VerifierResult>;
}

export interface VerifierResult {
  passed: boolean;
  reason: string;
}

export function createSubAgentVerifierScheduler(llm: LLMService): ContractVerifierScheduler;

// src/core/contract/utils.ts (phase346 新增 / 从 watchdog-utils 迁出)
export function getContractCreatedMs(clawDir: string): number | null;

// src/core/contract/index.ts
export function createContractManager(
  clawDir, clawId, fs, audit,
  llm?, verifierRegistry?, auditWriter?, verifierScheduler?,
): ContractManager;
```

### 关键约定

- **可选参数能力降级**：未传 llm / verifierRegistry → LLM acceptance 路径不可用 / 仅脚本 acceptance 工作（CLI 直操路径 B.1）
- **verifierScheduler 默认 fallback**：未传 → ctor 内 `?? createSubAgentVerifierScheduler(llm)` / 行为 0 改 / phase340 测试覆盖
- **lock 文件防并发**：LOCK_MAX_RETRIES + LOCK_RETRY_DELAY_MS + LOCK_STALE_TIMEOUT_MS / 自动清理 stale lock
- **acceptance 异步 fire-and-forget**：`_runAcceptanceInBackground` 不 await / 结果走 inbox 异步通知 / D6 满足（不阻塞 done 工具返回）

### 失败分类

| 类别 | 形态 | 例子 |
|---|---|---|
| 同步输入拒绝 | throw | contract 不存在 / yaml 解析失败 |
| 异步执行失败 | catch + audit | acceptance script 超时（CONTRACT_SCRIPT_TIMEOUT_MS）/ verifier port throw |
| 静默吞 TypeError 🔥 | **B.p340-2 候选** | `_runAcceptanceInBackground` 异步 catch 块当前吞所有 throw（含编程 bug 类 TypeError）/ Coding #5 违反候选 / phase340 反向 3 暴露 / 推 r41+ 独立治理 |
| 锁竞争 | retry 后 throw | LOCK_MAX_RETRIES 耗尽 |

---

## 3. 审计事件

事件物理位置：`src/core/contract/audit-events.ts`（per-module / phase338 H1 α 决策）

`CONTRACT_AUDIT_EVENTS` 共 **22 events**：

| 事件名 | 触发时机 | 关键载荷 |
|---|---|---|
| `contract_created` | create 成功 | `contractId` |
| `contract_updated` | progress.json 更新 | `contractId`, `subtaskId`, `status` |
| `contract_acceptance_started` | LLM acceptance 启动 | `contractId`, `subtaskId` |
| `contract_acceptance_script_started` | 脚本 acceptance 启动 | 同上 |
| `contract_acceptance_inbox_failed` | acceptance 结果回 inbox 失败 | `contractId`, `error` |
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
| `contract_retro_*`（6 events）| retro 触发各失败路径 | `contractId`, `error` |

**缺失事件**（潜在 §7.A 候选）：
- 异步 catch 块吞 TypeError 时无 audit（**B.p340-2 候选** / 见 §7.B）

---

## 4. 上游依赖

| 依赖契约 | 消费面 |
|---|---|
| `l1_filesystem.md`（FileSystem）| ctor 注入 / contract dir 读写 / lock 文件 |
| `l1_llm_service.md`（LLMService）| 可选 / verifier 路径透传 / 默认 verifier-scheduler 调 createSubAgent 时传入 |
| `l2_audit_log.md`（AuditWriter）| ctor 必传 / 22 events 出口 |
| `l2_messaging.md`（InboxWriter）| acceptance 结果回 inbox / retro 通知 |
| `l1_process_exec.md`（exec / execFile）| 脚本 acceptance 子进程 |
| **port: ContractVerifierScheduler** | **消费方 own**（src/core/contract/verifier-scheduler.ts）/ verifier 子代理调度 / 默认 sync 实现 |

---

## 5. 不可消除的耦合

**应然**：耦合面向 LLMService（verifier 业务逻辑）+ FileSystem（contract 文件）+ AuditWriter（事件出口）+ ContractVerifierScheduler port（verifier 调度抽象）。**不应**直接 import L2/L3 内部（subagent / tools / prompts / task / skill）。

| # | 方向 | 是否类型化 | 消除路径 / 放弃理由 |
|---|---|---|---|
| 1 | ContractManager → ContractVerifierScheduler | 类型化（port interface） | **消除路径已立**：phase340 port pattern 第 3 次复用 / 消费方 own / 默认 fallback / 行为 0 改 |
| 2 | ContractManager → InboxWriter（acceptance 结果回传） | 类型化 | 放弃消除：跨模块通知唯一通道 |
| 3 | ContractManager → ProcessExec（脚本 acceptance）| 类型化 | 放弃消除：脚本 acceptance 必子进程 |
| 4 | ContractManager → ToolRegistryImpl（**直 import L2 实现**）| 值依赖 | **§7.A drift**：应通过 port 透传或 ToolRegistry interface / 推 r41+ |
| 5 | ContractManager → prompts/subagent + prompts/retrospective（**直 import 跨层**）| 值依赖 | **§7.A drift**：应通过依赖注入 / 推 r41+ |
| 6 | ContractManager → task/tools/_pending-task-writer（**直 import L4 task 内部**）| 值依赖 | **§7.A drift**：retro 触发应抽象 port（参 verifier port pattern）/ 推 r41+ |
| 7 | ContractManager → skill/createSkillRegistry（**直 import L2**）| 值依赖 | **§7.A drift**：verifier-scheduler 内构造 / ContractManager 不应直 import / 推 r41+ |

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入。phase340 已实证（耦合 #1 范本）/ §7.A drift（#4-7）应同模式治理。

---

## 6. 持久化

| 信息 | 落盘位置 | 重建语义 |
|---|---|---|
| contract YAML | `contract/active/<id>/contract.yaml` | 单一权威 / loadActive 解析 |
| 进度数据 | `contract/active/<id>/progress.json` | subtask 状态机 / writeAtomic |
| 暂停态 | `contract/paused/<id>/*` | resume 时迁回 active |
| 归档 | `contract/archive/<id>/*` | 终态 / 不再回入 |
| lock 文件 | `contract/active/<id>/.lock` | 防并发 / stale 自动清 |
| acceptance 脚本 / prompts | contract dir 内 | 用户提供 |

---

## 7. 与实然的差距

### 7.A 必修违规（drift type）

| # | 违规 | 位置 | 违原则 | 修复方向 |
|---|---|---|---|---|
| A.1 | 直 import `core/tools/registry`（ToolRegistryImpl）| manager.ts:21 | M2（L4 不应直 L2 实现）/ M8（耦合界面最小）| 应通过 port 透传或 interface / 推 r41+ design phase 评估 |
| A.2 | 直 import `prompts/subagent`（CONTRACT_VERIFIER_SYSTEM_PROMPT）| manager.ts:19 | M5（依赖单向 / prompts 跨层）| 应通过 verifier-scheduler 内部持有 / ContractManager 不应直引 / 推 r41+ |
| A.3 | 直 import `prompts/retrospective`（buildRetroPrompt）| manager.ts:22 | 同 A.2 | 应通过 retro port 或 retro 模块 own / 推 r41+ |
| A.4 | 直 import `task/tools/_pending-task-writer`（writePendingSubagentTaskFile）| manager.ts:23 | M2（L4 ContractSystem 直入 L4 TaskSystem 内部 tools/）/ M8 | 抽象「retro 调度 port」（参 verifier port pattern）/ 推 r41+ |
| A.5 | 直 import `core/skill`（createSkillRegistry）| manager.ts:28 | M2（L4 → L2 跳层）| 应通过 verifier-scheduler 内部构造或 deps 注入 / 推 r41+ |

**phase340 已清零**：
- ~~直 import `core/subagent`~~（已删 / 走 verifier port）
- ~~直 import `tools/report-result`~~（已删 / 走 verifier port）

### 7.B 偏差登记（design-gap / 待 design 评估）

#### B.p340-1 — H6 异步通道完整迁移（design-gap）

详见前版本 / phase340 实施期 fork mechanical 假设修正 / 推 r41+ design phase 评估 acceptance state machine sync vs async 业务语义。

**实然现状**（main `736991b`）：
- ContractVerifierScheduler port 立 ✓ / 默认 sync 实现 / verifier 路径同步语义保留 / acceptance state machine 不动

**design-gap 待评估问题**：
1. acceptance state machine 同步反馈 vs 异步 fire-and-forget 业务语义
2. verifier 失败重试模式（同步可立即重试 / 异步需 daemon poll）
3. user-facing latency
4. 测试 fixture 复杂度

**owner**：ContractSystem + acceptance state machine
**计划 phase**：r41+ design phase
**type**：design-gap（**非** drift / 不应误归 §7.A）

#### B.p340-2 — 异步 catch 块吞 TypeError（drift type / Coding #5 违反候选）✅ phase342 已实施

**消化证据**（main `2994632` / phase342 step 2）：
- `src/core/contract/manager.ts:52` `isProgrammingBug(err)` 检
- `src/core/contract/audit-events.ts:29` `UNEXPECTED_ASYNC_THROW = 'contract_unexpected_async_throw'`
- manager.ts:548 `_runAcceptanceInBackground` catch 块识别编程 bug → audit + rethrow
- CONTRACT_AUDIT_EVENTS 总数 22（含本事件）

---

#### B.p340-2-history — 异步 catch 块吞 TypeError（原始登记 / 已消化保留供溯源）🔥

**触发**：phase340 反向验证 3 实施期暴露。

**实然**：`_runAcceptanceInBackground` 异步 catch 块吞所有 throw / 编程 bug 类（TypeError / ReferenceError）也被当 best-effort 失败静默 / 调用方看到 subtask 状态停留 todo / 不知有 bug。

**违原则**：Coding #5「预期失败显式处理 / 不可预期失败暴露而非吞没」/ TypeError 是编程 bug 不应被异步 catch 当 best-effort 吞。

**修复方向**：catch 中区分 `instanceof TypeError / ReferenceError / SyntaxError` 等编程 bug → rethrow 或 audit 后 rethrow / 业务 throw → 走 best-effort 路径。

**owner**：ContractSystem + 全 src 异步 fire-and-forget catch 点（顺藤摸瓜）
**计划 phase**：r41 B 起 phase342（高优 / 升格独立治理 phase 候选）
**type**：drift（应然 Coding #5 / 实然违反 / 修法明确）

---

#### B.p344-1 — 双 audit writer + 10+ hardcoded 事件未在 const 注册（drift type / 推 r42 治理 phase）🔥

**触发**：r41 主会话 audit fork 发现（2026-04-27）。

**实然**：ContractManager 持双 audit writer：
- `this.audit`（ctor 第 4 参 / 必传 / 用 CONTRACT_AUDIT_EVENTS const）
- `this.auditWriter`（ctor 第 7 参 / 可选 / **41 处 `this.auditWriter?.write(...)` 调用 / 至少 10 处硬编码字符串**）

**硬编码事件清单**（未在 audit-events.ts CONTRACT_AUDIT_EVENTS 注册）：
- L242 `'contract_lock_cleanup_failed'`
- L470 `'contract_created'`（与 const CREATED 重值 / 但用 string literal）
- L742 `'subtask_completed'`
- L749 `'acceptance_passed'`
- L799 `'acceptance_failed'`
- L996 `'contract_paused'`
- L1019 `'contract_resumed'`
- L1041 `'contract_cancelled'`
- L1117 `'contract_completed'`
- L1211 `'acceptance_timeout'`

**违原则**：M9（编译器优先 / 字符串硬编码 audit event = 编译期不可查）/ M3（资源唯一归属 / audit event 名 = 资源 / 应在 const 唯一注册）/ M8（耦合界面最小 / 双 writer 接触面冗余）

**应然**：
- 单一 audit 出口（参 phase297 monitor 废止模式）
- 全事件经 const 注册 / caller 经 const 引用 / 0 字符串硬编码
- 双 writer 收敛单一（this.audit 或 this.auditWriter / 不双持）

**owner**：ContractSystem
**计划 phase**：r42 治理 phase（建议同 B.p336-1 cron 字符串硬编码并轨 / 模式相同）
**type**：drift（caller 编码风格 + writer 双持冗余）

**额外应然 drift**（同次审计发现 / 推 r42 同步修订）：
- §2 VerifierConfig 实际签名：`prompt`（非应然写的 userPrompt）/ 含 `clawDir` / `llm` / `idleTimeoutMs` / `onIdleTimeout` / 缺 `auditWriter`
- §2 VerifierResult 实际：`feedback`（非 reason）+ 可选 `structured`
- §2 `createSubAgentVerifierScheduler()` 无参（per-call config 含 llm）
- §3 22 events 表漏列 UNEXPECTED_ASYNC_THROW
- 应然契约 main HEAD 引用 `736991b` → 实测已前进 `2994632`（phase342 / 343 / 344）

#### B.p342-1 — fire-and-forget 失败时 subtask 状态机语义（design-gap / 推 r42+ design 评估）

**触发**：phase342 r41 B / r40 phase340 反向 3 教训消化期发现 / `_writeAcceptanceError` 仅写 inbox 通知 user / **不改 subtask 状态** / 调用方仅看 subtask 状态停留 in_progress / 调试体验差。

**实然现状**（main `29946325e3bfdd3cd27f9ec8293d1c55576677ce`）：
- ContractVerifierScheduler port 立 + 默认同步实现（phase340 / 736991b）
- `_runAcceptanceInBackground` catch 块**已加** isProgrammingBug 检 + audit `UNEXPECTED_ASYNC_THROW`（phase342 / Coding #5 部分合规）
- `_writeAcceptanceError` 写 inbox 通知 user / **subtask 状态不动**（仍是 in_progress / 失败时未 transition）

**design-gap**（vs §7.B drift type）：
- **不是** 应然有但实然偏离（drift type）
- **是** 应然 silent / 没明确 fire-and-forget 失败时 subtask 应 transition 到 error 还是停留 in_progress / 还是别的语义
- 按 `feedback_design_gap_when_yingran_silent`：design 评估优先于 mechanical 实施
- 与 phase340 B.p340-1 H6 design-gap 同框架（fire-and-forget 异步路径设计语义评估推 r42+）

**待 r42+ design phase**（评估问题）：
1. fire-and-forget 失败时 subtask 状态 transition 语义（in_progress → error 还是 todo？）
2. inbox 通知 + 状态机 transition 双轨 vs 单轨
3. 调用方观察途径（直查 subtask 状态 vs poll inbox）
4. 与 phase340 B.p340-1 H6 异步化评估**合并 design phase 候选**（同 fire-and-forget framing）

**owner**：ContractSystem + acceptance state machine

**计划 phase 编号**：r42+ design phase（评估后 derive 实施方案 / 视情独立代码 phase）/ 与 B.p340-1 合并评估候选

**drift type 标记**：design-gap（**非** B drift / **非** §7.A 必修 / 与 B.p340-1 同框架）

---

**phase342 实施 SHA**：`29946325e3bfdd3cd27f9ec8293d1c55576677ce`

#### B.p345-1 — ContractManager 双 audit writer 设计冗余（design-gap / 推 r43+ design 评估）

**触发**：phase345 r42 B / r41 末主会话 audit fork（B.p344-1）发现 ContractManager 双 writer：`this.audit`（必传 / 16 sites / 全 const ✓）+ `this.auditWriter?`（可选 / 6 sites / 全 hardcoded → phase345 治理为 const）/ 双 writer 设计是否真双语义 vs 设计冗余 / 应然 silent。

**实然现状**（main `<MERGE_SHA>`）：
- `this.audit`（必传）：16 sites 全 CONTRACT_AUDIT_EVENTS const（合规）
- `this.auditWriter?`（可选）：6 sites 已治理为 const 引用（phase345 / 5 新 + 1 复用）
- **双 writer 字段保留**（α 方案 / 不动设计冗余 / phase345 scope 收敛）

**design-gap**（vs §7.B drift type / 与 B.p340-1 + B.p342-1 同框架）：
- **不是** 应然有但实然偏离（drift type）
- **是** 应然 silent / 双 writer 是否真双语义（如 motion-aware vs claw-local）vs 设计冗余（同 AuditWriter instance fallback）
- 按 `feedback_design_gap_when_yingran_silent`：design 评估优先于 mechanical 实施

**待 r43+ design phase**（评估问题 / 与 B.p340-1 + B.p342-1 合并候选）：
1. 双 writer 装配实然（13 caller 是否都传同 AuditWriter / 有无 motion-aware 差异）
2. 双 writer 是否真有不同 audit.tsv 写入路径
3. collapse 双 writer 的行为契约影响（β 方案 / M8 完整合规）
4. 与 H6 + 状态机 design-gap 合并 design phase 评估

**owner**：ContractSystem + acceptance state machine

**计划 phase 编号**：r43+ design phase（与 B.p340-1 + B.p342-1 合并评估候选 / 三 design-gap 同 ContractSystem 内部）

**drift type 标记**：design-gap（**非** B drift / **非** §7.A 必修 / 与 B.p340-1 + B.p342-1 同框架）

---

**phase345 实施 SHA**：`83ef019`

### 7.C 原则对照（Philosophy 4 + Design 11 + Module 11 + Path 6 = 32 条 / 深度按需）

> Path 6 authoritative list 待核（feedback 引用「Path 6」/ 本地未见明确枚举源）/ 后续轮 fork ack 时补完。

#### Philosophy（4）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| P1 | Agent 即目录 | N/A | 模块设计层 / 不直接对应 |
| P2 | clawforum 本质上下文工程 | 合规 | contract.yaml + progress.json 是 contract claw 的上下文锚点 |
| P3 | 分智能体目的高效利用上下文窗口 | 合规 | verifier 子代理独立窗口 / 不污染 contract claw |
| P4 | 系统为智能体服务 | 合规 | acceptance + retro 是为 contract claw 决策提供信息 |

#### Design Principles（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| D1 | 信息不丢失 / 可观察 / 可恢复 / 可审计 | **部分违规** | 22 events 覆盖大部分 ✓；但 B.p340-2 异步 catch 吞 TypeError = 信息丢失 |
| D2 | 信息未经显式设计不得静默忽略 | **违规** | B.p340-2：`_runAcceptanceInBackground` 异步 catch 吞所有 throw 含编程 bug = 未经设计的静默 |
| D3 | 用户可观察所有状态 | 合规 | contract / progress / lock 文件 + audit events 可观察 |
| D4 | 中断即从最后完整 LLM 调用恢复 | 合规 | acceptance 路径走 verifier-scheduler / verifier 失败可重试（B.p340-1 异步化下重试模式待 design 评估）|
| D5 | 事后仅凭日志重建决策链路 | **部分违规** | 22 events 覆盖主路径 ✓；但 acceptance state machine 部分迁移点缺 audit / B.p340-2 吞 TypeError 时无 audit 痕迹 |
| D6 | 子代理后不阻塞 / 异步返回 | 合规 | `_runAcceptanceInBackground` fire-and-forget / done 工具立即返回 / acceptance 结果走 inbox 异步通知 |
| D7 | 系统内部走可信路径 | 合规 | acceptance 走 ProcessExec / verifier 走 port / 不绕过 |
| D8 | 事件驱动 / 恰好需要时交付 | 合规 | inbox 消息 + audit 事件 / 不主动推 |
| D9 | CLI 唯一外部入口 | 合规 | contract 操作经 CLI commands |
| D10 | 多 claw 信息不隔绝 | 合规 | contract dir 跨 claw 可见（FileSystem 共享）|
| D11 | motion 单向访问 | N/A | 本模块不涉及 motion 边界 |

#### Module Logic（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| M1 | 一组独立可变职责 | 合规 | 契约生命周期是独立业务域 / 不与 TaskSystem 共享 state |
| M2 | 业务语义自发起 | 合规 | acceptance / state 迁移 / archive / retro 由本模块发起 |
| M3 | 资源唯一归属 | 合规 | contract/active|paused|archive 三目录独占 |
| M4 | 持久化一切信息 | 合规 | progress.json + contract.yaml + lock + acceptance scripts 全落盘 |
| M5 | 依赖单向 / 不预设上层 | **违规** | 不反向依赖 Runtime / Daemon ✓；但直 import L2/L3 内部 5 处（A.1-A.5）= 单向边界破 / 跨层依赖 |
| M6 | 依赖结构稳定 | 合规 | ctor 一次注入 / 运行期不变 |
| M7 | 耦合界面稳定 | 合规 | 公共 API 11 方法 phase340 0 改 |
| M8 | 耦合界面最小 | **部分违规** | port pattern 已立（耦合 #1）✓；但 5 直 import = 接触面大 |
| M9 | 编译器优先 | 合规 | port interface 类型化 / 注入参数显式 |
| M10 | 发现不合理停下 | 合规 | phase340 H6 假设修正 → 推 r41+ design 评估 / 不 mechanical |
| M11 | 边界与依赖对不上停下 | 合规 | A.1-A.5 显式登记不静默 / 推 r41+ 治理 |

#### Path Principles（6 待核）

> authoritative 源未读 / 暂列已知 4 + 待补 2

| # | 原则（已知）| 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase340 实测 5 残 import / 0 推翻 / 写入 §7.A |
| Path #3 | 语义原子最小变更单元 | 合规 | phase340 单 commit port 立 + 删 2 import / 不附带 caller 风格统一 |
| Path #6 | 冲突停 / 不绕过 | 合规 | phase340 fork mechanical 异步化 → 用户 framing 修正 → 停 mechanical 推 design 评估 |
| Path #8 | 总难度最低 | 合规 | β 方案选 + δ 推 r41+ |
| Path #?-1 | 待核 | - | - |
| Path #?-2 | 待核 | - | - |

### 7.D 关键决策映射表（modules.md 引用）

| KD | modules.md 描述 | 本契约引用位置 | 一致性 |
|---|---|---|---|
| KD#30 | ContractSystem LLM verifier 经 TaskSystem 调度 | §1 不做 / §5 #1 / §7 B.p340-1 | **部分实施**（H11 完整：删 2 直 import + port 立 / H6 异步化推 r41+ design）|
| KD（待编号）| acceptance fire-and-forget D6 | §2 关键约定 / §7 B.p340-2 | 满足 D6 / 但异步 catch 吞 TypeError 违 Coding #5 |

### 7.Phase 执行纪律

#### phase340 纪律 — H6+H11 ContractVerifierScheduler port + 删 L2/L3 直 import（r40 B / 2026-04-27）

- **Scope**：port 立 + 删 2 直 import（subagent + report-result）+ assembly 注入 + 1 mock test
- **行为契约 0 改**：vitest 1351/1351 / 既有 1350 全保留
- **反向验证 3/3 强 PASS**（vs phase336 弱反向 / phase338 教训应用）
- **重大发现**：反向 3 暴露异步 catch 吞 TypeError → B.p340-2
- **port pattern 第 3 次复用里程碑**（phase337+335+340）→ 升格独立 feedback 候选 / Meta 30 评估
- **「fork 推荐 ≠ 终方案」N 次实证**：fork 推选 B / 实施期回归选 A
- **B+C 弱冲串行实证**：Squash 基线 9d1bd83 + rebase to 7480218 / 0 冲突
- **SHA**：`736991b236a542472aebb98cd3ea53c47848d46e`

---

## 8. 测试覆盖

| 文件 | case 数 | 类型 | 覆盖点 |
|---|---|---|---|
| `tests/core/contract_manager_llm.test.ts` | （phase340 +1 mock scheduler）| integration | LLM acceptance + script acceptance + verifier port 调用契约 |
| `tests/core/contract.test.ts`（若存在）| - | unit | CRUD 基础路径 |

**§3 事件回链缺口**：22 events 当前未全条 §8 回链 / phase 治理 candidate。

**反向验证（phase340 强 PASS）**：
- 反向 1：port 调用契约破坏 → mock test 断言 fail
- 反向 2：port 接口签名错 → tsc fail
- 反向 3：port 注入断裂 → contract test fail（**附带暴露 B.p340-2 异步 catch 吞**）

---

## 8. 已知问题（2026-04-27 记录）

### 8.1 契约完成通知机制失效

**问题描述**：
- 契约完成后，Motion 没有收到完成通知
- inbox（motion/inbox/pending/）为空
- 但契约实际已完成归档，产出文件正确

**根因分析**：

#### A. 即时通知路径（contractNotifyCallback）
```typescript
// src/assembly/assemble.ts:324
const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
  streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
};
```
- 只写入 stream（实时观察窗口），**不写入 inbox**
- 用户无法通过 inbox 收到通知

#### B. 定时检查路径（contract-observer cron job）
```typescript
// src/core/contract/jobs/contract-observer.ts:42
await execFile(
  'node', [process.argv[1], 'contract', 'events', clawId, '--since', String(lastCheckTs)],
  { cwd: clawforumDir, timeout: 10000 }
);
```
- `process.argv[1]` 在 daemon 进程中是 `daemon-entry.js`，**不是 CLI 入口**
- CLI 调用失败被静默捕获（`catch { /* 跳过 */ }`）
- 导致 contract-observer 无法检测契约完成事件

**验证结果**：
- 手动执行 `clawforum contract events mining-test --since 0` → 正常返回 `[contract_completed]`
- 但 contract-observer 执行时 CLI 调用失败 → 无事件产出 → 不写 inbox

**修复建议**：

1. **即时通知**：修改 `contractNotifyCallback`，同时写入 inbox 和 stream
   ```typescript
   const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
     streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
     // 追加：写入 motion inbox
     notifyInbox(fs, {
       inboxDir: motionInboxDir,
       type: 'contract_events',
       source: 'system',
       priority: 'high',
       body: JSON.stringify({ type, ...data }),
     }, auditWriter);
   };
   ```

2. **定时检查**：contract-observer 不应通过 CLI 间接调用
   - 方案 A：直接调用 ContractManager API（推荐）
   - 方案 B：正确找到 cli.js 路径（如 `path.join(clawforumDir, '..', 'dist', 'cli.js')`）
   - 方案 C：添加配置项指定 CLI 路径

**优先级**：高（影响核心用户体验）

---

## 9. 模块实现状态（2026-04-27 更新）

| 组件 | 状态 | 代码位置 | 备注 |
|------|------|----------|------|
| ContractManager | ✅ 已实现 | `src/core/contract/manager.ts` | 1406 行，核心逻辑完整 |
| VerifierScheduler port | ✅ 已实现 | `src/core/contract/verifier-scheduler.ts` | 117 行，port + default impl |
| AuditEvents | ✅ 已实现 | `src/core/contract/audit-events.ts` | 22 events |
| ContractObserver | ⚠️ 有 bug | `src/core/contract/jobs/contract-observer.ts` | CLI 调用路径错误 |

### 8.2 ContractObserver CLI 调用路径错误

**问题描述**：
- contract-observer cron job 执行时 CLI 调用失败
- 错误被静默捕获，导致无事件检测、无 inbox 通知

**根因**：
```typescript
// src/core/contract/jobs/contract-observer.ts:42
await execFile(
  'node', [process.argv[1], 'contract', 'events', clawId, '--since', String(lastCheckTs)],
  { cwd: clawforumDir, timeout: 10000 }
);
```
- `process.argv[1]` 在 daemon 进程中是 `daemon-entry.js`
- 实际需要的是 `cli.js` 或 `clawforum` 命令
- 调用失败被 `catch { /* 跳过 */ }` 静默吞掉

**验证**：
- 手动执行 `clawforum contract events mining-test --since 0` → 正常
- contract-observer 执行时 → CLI 调用失败 → 无产出

**修复建议**：
- 方案 A：直接调用 ContractManager API，不通过 CLI
- 方案 B：正确推导 cli.js 路径（`path.join(clawforumDir, '..', 'dist', 'cli.js')`）
- 方案 C：添加配置项指定 CLI 路径

**优先级**：高

### 8.3 ContractNotifyCallback 只写 Stream 不写 Inbox

**问题描述**：
- 契约完成时的即时通知只写入 stream
- 用户无法通过 inbox 收到通知

**根因**：
```typescript
// src/assembly/assemble.ts:324
const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
  streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
};
```
- 只调用了 `streamWriter.write()`
- 没有调用 `notifyInbox()` 写入 motion inbox

**影响**：
- 契约完成后 Motion 收不到即时通知
- 必须依赖 contract-observer 定时检查（但 contract-observer 也有 bug）

**修复建议**：
```typescript
const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
  // 现有：写入 stream
  streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
  
  // 追加：写入 inbox
  notifyInbox(fs, {
    inboxDir: motionInboxDir,
    type: 'contract_events',
    source: 'system',
    priority: 'high',
    body: JSON.stringify({ type, ...data }),
    filenameTag: 'contract_notify',
  }, auditWriter);
};
```

**优先级**：高
