# L5 Cron

**应然**：定时任务调度与执行基础设施。runner 管理 CronJob 生命周期 + tick 调度；jobs 模块承载具体业务逻辑。**非智能体** / 系统级后台任务管道。

**实然**：落地 `src/core/cron/runner.ts`（CronRunner class + parseSchedule + CronJob interface）+ `src/core/cron/jobs/llm-stats.ts` + `src/core/cron/jobs/disk-monitor.ts` + `src/core/memory/random-dream.ts` + `src/core/memory/deep-dream.ts`（memory/ 物理位置 / cron 语义归属 / A1 drift）。

**归属**：L5 定时任务 — 后台管道（**非智能体**）。

- **应然依赖**：FileSystem（L1）、AuditWriter（L2）、LLMService（L1 / 仅 deep-dream + random-dream 内部消费）
- **实然依赖**：同上 + audit event 字符串硬编码（B.p336-1 / 18 use sites）

> **状态**：冻结登记（phase227 / phase232）/ 结构补完不算解冻

---

## 1. 所有权

### 归属层

L5 定时任务 — **后台管道**（非智能体）。

### 物理位置

- `src/core/cron/runner.ts`：runner 生命周期 + schedule 解析
- `src/core/cron/jobs/`：llm-stats.ts / disk-monitor.ts
- `src/core/memory/`：random-dream.ts / deep-dream.ts（**§7.A A1**：物理在 memory/ / 语义归属 cron / 历史原因 / 双重归属保留）

### 进程形态

独立进程（`node cron-entry.js`）/ 由 Daemon spawn / SIGTERM 终止。

### 职责（做）

1. **CronRunner 生命周期**：start / stop / tick 调度
2. **schedule 解析**：`hourly` / `daily:HH:MM` / `interval:N` 三种形态
3. **去重防重叠**：lastRunKey + running Set 防同 job 多重触发
4. **job 失败兜底**：单 job throw 不终止 runner / 走 audit
5. **业务 jobs**：LLM stats 汇总 / disk 监控 / random-dream（高频自由联想）/ deep-dream（深度记忆整合）

### 不做

- 不做跨进程协调（runner 单进程 / jobs 串行 / 同 runner 内）
- 不持久化 job 状态（除 audit 日志外）
- 不解析复杂 cron 表达式（仅 3 种 schedule 形态）

### 资源

| 资源 | 类别 | 归属位置 |
|---|---|---|
| `lastRunKey` Map | 运行时派生 | runner.ts:37 / 不落盘 / 重启重置 |
| `running` Set | 运行时派生 | runner.ts:38 / 防重叠 |
| `timer` setInterval | 运行时派生 | runner.ts:36 / start 创建 / stop 清 |
| audit.tsv 事件 | 持久化 | 经 AuditWriter / 不独占 |

---

## 2. 接口

### 类型签名

```ts
// src/core/cron/runner.ts
export type CronSchedule =
  | { type: 'daily'; time: string }
  | { type: 'hourly' }
  | { type: 'interval'; minutes: number };

export function parseSchedule(s: string, audit?: Audit): CronSchedule;

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  handler: () => Promise<void>;
}

export class CronRunner {
  constructor(jobs: CronJob[], audit: Audit);
  start(tickIntervalMs?: number): void;  // default 1000
  stop(): void;
  tick(): void;
}

// src/core/cron/jobs/llm-stats.ts
export interface LlmStatsOptions {...}
export async function runLlmStats(opts: LlmStatsOptions): Promise<void>;

// src/core/cron/jobs/disk-monitor.ts
export interface DiskMonitorOptions {...}
export async function runDiskMonitor(opts: DiskMonitorOptions): Promise<void>;

// src/core/memory/random-dream.ts
export interface RandomDreamOptions {...}
export async function runRandomDream(opts: RandomDreamOptions): Promise<void>;

// src/core/memory/deep-dream.ts
export interface DeepDreamOptions {...}
export async function runDeepDream(opts: DeepDreamOptions): Promise<void>;
```

### 关键约定

- **runner 单线程 tick**：默认 1000ms tick / 每 tick 检查所有 job 是否到 runKey
- **runKey 去重**：同 schedule 同 runKey = 同周期 / 已跑过不再跑
- **job throw 不终止 runner**：catch + audit `cron_job_error` + 继续下一 job
- **deep/random-dream 内部 LLM 并发**：可触发多 LLM 调用 / 但 runner 串行调度 jobs

### 失败分类

| 类别 | 形态 | 例子 |
|---|---|---|
| schedule 解析失败 | audit + fallback hourly | parseSchedule 未知格式 / runner.ts:23 |
| job 单次失败 | catch + audit `cron_job_error` | runner.ts:72 |
| dream LLM 失败 | catch + audit `*_error` | deep-dream.ts:197/216/279 / random-dream warning |

---

## 3. 审计事件

事件物理位置：**字符串硬编码 caller**（B.p336-1 drift / 5 src files / 18 use sites / 待 r41+ 治理为 module-owned const）

| 事件名 | 触发位置 | 关键载荷 |
|---|---|---|
| `cron_runner_started` | runner.ts:49 | `jobs=N` |
| `cron_runner_stopped` | runner.ts:56 | `jobs=N` |
| `cron_parse_fallback` | runner.ts:23 | `input`, `fallback=hourly` |
| `cron_job_error` | runner.ts:72 | `job`, `reason` |
| `cron_disk_monitor_check` | disk-monitor.ts:41 | `totalMB`, `limitMB` |
| `cron_disk_monitor_threshold_exceeded` | disk-monitor.ts:45 | 同上 |
| `cron_disk_warning` | disk-monitor.ts:49 | type-typed |
| `cron_llm_stats` | llm-stats.ts:55/68 | `step`, `date`, summary fields |
| `cron_deep_dream_job` | deep-dream.ts:158/162/255 | `step`, `clawId`, counts |
| `cron_deep_dream_error` | deep-dream.ts:197/216/279 | `step`, `clawId`, `file`, `reason` |
| `cron_random_dream_job` | random-dream.ts:232/236/252/270 | `step`, counts |
| `cron_random_dream_warning` | random-dream.ts:257/265 | `reason` |

合计 **12 unique event names** / 18 use sites。

---

## 4. 上游依赖

| 依赖契约 | 消费面 |
|---|---|
| `l1_filesystem.md`（FileSystem）| jobs 内读写 / dream 历史会话扫描 |
| `l2_audit_log.md`（AuditWriter）| runner + 全 jobs 事件出口 / **字符串硬编码 / B.p336-1** |
| `l1_llm_service.md`（LLMService）| 仅 deep-dream + random-dream 内部消费 / runner 不直接调 |
| `l1_process_exec.md`（间接）| disk-monitor 走 du / df 子进程（待核） |

---

## 5. 不可消除的耦合

**应然**：耦合面向 AuditWriter（事件出口）+ FileSystem（job 状态读）+ LLMService（dream 业务）。**不应**对 TaskSystem / SubAgent / Runtime 反向依赖。

| # | 方向 | 是否类型化 | 消除路径 / 放弃理由 |
|---|---|---|---|
| 1 | runner → AuditWriter | 类型化 | 放弃消除：事件出口必经 audit |
| 2 | runner → CronJob[] handlers | 类型化（CronJob interface）| 放弃消除：runner 调度 jobs 是核心职责 |
| 3 | random-dream → `writePendingSubagentTaskFile`（L4 task）| 值依赖 | **跨层潜在 drift**：cron job 调 task 写入器 / 应 r41+ 评估 port 抽象（参 verifier port pattern）|
| 4 | deep-dream / random-dream → LLMService | 类型化 | 放弃消除：dream 业务核心 |
| 5 | caller → audit event 字符串硬编码 | **非类型化**（string literal）| **B.p336-1**：应通过 module-owned const / 推 r41+ |

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：耦合 #3 random-dream → task 写入器是潜在范本。

---

## 6. 持久化

cron 模块**无独占持久化资源**。

- runner 运行时派生态（lastRunKey / running / timer）→ 重启重置 / 不落盘
- audit 事件经 AuditWriter（归属 L2 AuditLog）
- jobs 内部读 src/core/memory/ 历史会话 / 写 dream 输出 → 归属 memory 模块（待界定）

**重建语义**：runner 重启 = 全部 job 状态重置 / 当前 tick 周期内重新触发（去重靠 lastRunKey 重新累积）。

**D4 显式豁免**：runner lastRunKey/running 运行时态不落盘 → 重启后上一周期已跑过的 job 会**重跑**。豁免理由：(a) jobs 设计为幂等（dream 重跑只是多生成一次输出；llm-stats / disk-monitor 重跑无副作用）；(b) cron 是定时驱动 / 重启场景罕见；(c) 落盘 lastRunKey 引入 fs 依赖收益不抵成本。**Trade-off 显式登记 / 非 D4 静默违反**。

---

## 7. 与实然的差距

### 7.A 必修违规（drift type）

| # | 违规 | 位置 | 违原则 | 修复方向 | owner | 计划 phase |
|---|---|---|---|---|---|---|
| A1 | random-dream / deep-dream 物理在 `src/core/memory/` 而非 `src/core/cron/jobs/` | 文件位置 | M3（资源唯一归属 / 双重归属歧义） | **不修复**（历史原因 / 语义双重归属 / cron 触发 + memory 业务） | Cron + Memory | **保留** / 接受双重归属 |

### 7.B 偏差登记（drift / design-gap）

#### B.p336-1 — CRON 模块 caller 字符串硬编码（drift type）

**触发**：phase336 r39 B 收官 / Step 1 扫描 events.ts 残 CRON_* 9 const 是死常量 / 0 caller 通过 AUDIT_EVENTS 引用 / 全 caller 直 `audit.write('cron_xxx', ...)` 字符串硬编码。

**实然**（5 src files / 18 use sites + 2 tests）：
- `cron/runner.ts`（4 use）
- `cron/jobs/llm-stats.ts`（2 use）
- `cron/jobs/disk-monitor.ts`（3 use）
- `memory/random-dream.ts`（6 use）
- `memory/deep-dream.ts`（5 use）
- tests：assemble.test.ts + cron/runner.test.ts

**应然**（与 phase334+338+336 H1 模式一致）：caller 通过 module-owned const 引用 / 不字符串硬编码。

**phase336 处置**：α 方案 / events.ts 9 CRON 死常量删 / **caller 字符串硬编码维持**（不在 H1 解耦 scope / H1 = 中央注册表违反 M2/M3 / 字符串硬编码 = caller 编码风格 drift）。

**owner**：Cron 模块（src/core/cron/）+ Memory 模块（src/core/memory/）

**计划 phase**：r41+ 独立 phase / scope = 创建 cron/audit-events.ts + memory/audit-events.ts + 改 5 src + 2 tests caller / 风格统一 const 引用

**type**：drift（caller 编码风格 / 应然有 module-owned event 模式 / 实然偏离）/ 与 design-gap framing 不同型

**合入 SHA**：`9d1bd83`（phase336 caller 维持原态）

**use sites 实测修正**（2026-04-27 audit）：18 → **20**（runner 4 + llm-stats 2 + disk-monitor 2 + random-dream 6 + deep-dream 6）

---

#### B.p344-2 — 应然 §6「无独占持久化」错（drift type / 推 r42）

**触发**：r41 主会话 audit fork 发现（2026-04-27）。

**实然**（3 持久化文件 / 应然漏登）：
- `src/core/cron/jobs/llm-stats.ts:66` `fs.appendFileSync('.clawforum/logs/llm-stats.jsonl', ...)`
- `src/core/memory/random-dream.ts:54` `fs.writeFileSync('.random-dream-state.json', ...)`
- `src/core/memory/deep-dream.ts:82` `fs.writeFileSync('.deep-dream-state.json', ...)`

**应然 §6 现状**：「cron 模块无独占持久化资源」← **错** / 至少 3 文件落盘。

**应然 §7.A A1 D4 显式豁免理由**「无持久状态」← **部分错** / lastRunKey 不落盘 ✓ / 但 jobs 内部状态（dream cooldown / llm-stats 累积）落盘。

**修正方向**（推 r42 / 不本 phase 改）：
1. §6 持久化表加 3 文件 + 各 owner（llm-stats / random-dream / deep-dream）
2. §7.A A1 D4 豁免理由收窄至「runner lastRunKey」/ jobs 内状态另议
3. 评估：dream state 文件归 cron 还是 memory（A1 双重归属问题外延）

---

#### B.p344-3 — 应然 §3+§4 漏 disk-monitor 经 InboxWriter 投 motion inbox（drift type / 推 r42）

**触发**：r41 主会话 audit fork 发现。

**实然**：`disk-monitor.ts:48-55` `cron_disk_warning` 事件**同时**经 audit.write + InboxWriter 投 motion inbox。

**应然 §3 描述**：仅「audit.write」/ 漏 inbox 路径。
**应然 §4 依赖**：漏 messaging InboxWriter。

**修正方向**（推 r42）：
- §3 cron_disk_warning 加「+ motion inbox 通知」路径
- §4 加 InboxWriter 依赖
- §5 评估：cron → messaging 跨层耦合 / 是否应抽 port

### 7.C 原则对照（Philosophy 4 + Design 11 + Module 11 + Path 6 = 32 条 / 深度按需）

> Path 6 authoritative list 待核 / 后续轮 fork ack 时补完。

#### Philosophy（4）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| P1 | Agent 即目录 | N/A | cron 是非智能体后台管道 |
| P2 | clawforum 本质上下文工程 | N/A | cron 不参与上下文 |
| P3 | 分智能体目的 | N/A | 同上 |
| P4 | 系统为智能体服务 | 合规 | dream 系列为 claws 提供记忆整合基础设施 |

#### Design Principles（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| D1 | 信息不丢失 / 可观察 / 可恢复 / 可审计 | **部分违规** | 12 events 覆盖 ✓；但 lastRunKey/running 运行时态不落盘 → 重启 ↓ D4 |
| D2 | 信息未经显式设计不得静默忽略 | 合规 | parse_fallback / job_error 全 audit / `cron_parse_fallback` console.warn 是 β 双写 |
| D3 | 用户可观察所有状态 | 合规 | audit.tsv 可观察 / runner stdout |
| D4 | 中断即从最后完整 LLM 调用恢复 | **显式豁免（待登记）** | runner 重启 lastRunKey 不落盘 / 上一周期已跑 job 会重跑 / 接受「无持久状态」立场 / 但应明确登记豁免理由（待 §6 补）|
| D5 | 事后仅凭日志重建决策链路 | **部分违规** | runner 调度 / job 失败 / dream 主路径有 audit ✓；但 dream 内部 LLM 调用细节是否全 event 覆盖待核 |
| D6 | 子代理后不阻塞 / 异步返回 | 合规 | random-dream 经 `writePendingSubagentTaskFile` fire-and-forget |
| D7 | 系统内部走可信路径 | 合规 | jobs 调用走 handler / 不走 CLI |
| D8 | 事件驱动 / 恰好需要时交付 | **N/A**（cron 是定时驱动 / 非事件驱动 / 设计本质如此 / 显式豁免）| schedule 触发是定时模型 / D8 不适用 |
| D9 | CLI 唯一外部入口 | 合规 | 外部不直调 cron / 由 Daemon spawn |
| D10 | 多 claw 信息不隔绝 | 合规 | dream 输出可跨 claw 读 |
| D11 | motion 单向访问 | N/A | cron 不参与 motion 边界 |

#### Module Logic（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| M1 | 一组独立可变职责 | 合规 | runner 调度与 jobs 业务独立 |
| M2 | 业务语义自发起 | 合规 | tick 调度由本模块发起 |
| M3 | 资源唯一归属 | **A1 双重归属保留** | random/deep-dream 物理在 memory / 语义在 cron / §7.A 显式 |
| M4 | 持久化一切信息 | **部分豁免** | 无独占持久化 / lastRunKey 重启重置（D4 豁免）|
| M5 | 依赖单向 | **部分违规** | 不反向依赖 Runtime ✓；但 random-dream → L4 task writer 跨层（耦合 #3）|
| M6 | 依赖结构稳定 | 合规 | runner ctor 一次注入 |
| M7 | 耦合界面稳定 | 合规 | CronJob interface 稳定 |
| M8 | 耦合界面最小 | **部分违规** | runner 接触面小 ✓；caller 字符串硬编码 audit event = 隐式耦合（B.p336-1）|
| M9 | 编译器优先 | **违规** | 字符串硬编码 audit event = 编译期不可查（B.p336-1）|
| M10 | 发现不合理停下 | 合规 | jobs 可独立改不动 runner |
| M11 | 边界与依赖对不上停下 | 合规 | A1 双重归属与 B.p336-1 显式登记 / 不强行 mechanical |

#### Path Principles（6 待核）

> 参 l4_contract_system §7.C / 同型登记。

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase336 扫描发现 9 死 const + 18 caller 字符串硬编码 |
| Path #3 | 语义原子最小变更 | 合规 | phase336 死常量删 / caller 风格统一推 r41+ 独立 phase |
| Path #6 | 冲突停 | 合规 | cron 冻结期 / 不强行重构 |
| Path #8 | 总难度最低 | 合规 | α 方案选（events.ts 删 + caller 维持）|

### 7.D 关键决策映射表

| KD | modules.md 描述 | 本契约引用 | 一致性 |
|---|---|---|---|
| （待确认）| Cron 独立进程 / Daemon spawn | §1 进程形态 | ✓ 一致 |
| （待确认）| dream 系列归属 cron 触发 + memory 业务 | §1 物理位置 / §7.A A1 | 双重归属保留 |

### 7.Phase 执行纪律

#### phase227 / phase232 — 冻结登记（2026-04-23 前后）

cron 模块进入**冻结期**：除 B.p336-1 等已登记治理项外 / 不主动重构。Path #6 决策：风险高 / 等用户补 design 决策再解冻。

#### phase336 — H1 收官 / CRON 9 死常量删 + B.p336-1 登记（r39 B / 2026-04-27 / SHA `9d1bd83`）

events.ts CRON_* 9 死常量物理删 / caller 字符串硬编码维持 / B.p336-1 推 r41+ 独立治理。

---

## 8. 测试覆盖

| 文件 | 类型 | 覆盖点 |
|---|---|---|
| `tests/core/cron/runner.test.ts` | unit | runner 生命周期 / SIGTERM / tick 调度 / schedule 去重 |
| `tests/core/cron/random-dream.test.ts` | integration | random-dream → task writer 联动 |
| `tests/assembly/assemble.test.ts` | integration | 集成级 cron 事件断言（**字符串硬编码** / B.p336-1）|

**§3 事件回链缺口**：12 unique event names 当前未全条 §8 回链 / B.p336-1 治理时一并补。
