# Cron 接口契约

> 本契约描述 Cron 模块对其他模块的应然承诺。模块需遵循 Module Logic Principles。

## 1. 所有权

### 层级

L5 外壳与能力（与 Runtime / MemorySystem / ContractRetro 同层 / 「定时调度框架」业务语义独立可变 / **非智能体** / 系统级后台任务管道）。

### 职责

「定时任务调度与执行基础设施」—— runner 管理 CronJob 生命周期 + tick 调度 / jobs 模块承载具体业务逻辑（llm-stats / disk-monitor / dream 系列）。按时间表（daily / hourly / interval）触发任务处理器 / 同时窗内同任务仅触发一次 / 同任务不重叠执行 / 处理器异常隔离。

不做：
- 不做跨进程协调（runner 单进程 / jobs 串行 / 同 runner 内）
- 不持久化 job 调度状态（runner lastRunKey / running 重启重置 / D4 显式豁免）
- 不解析复杂 cron 表达式（仅 3 种 schedule 形态）
- 不调 LLM 主路径（LLM 仅 dream jobs 内部消费 / runner 不知）
- 不预设具体业务 jobs（CronJob 由装配方注入）

### 资源

| 资源 | 类别 | 持久化 |
|---|---|---|
| `lastRunKey: Map<string, string>` | 派生态 | ✗ runner.ts:37 / 重启重置 |
| `running: Set<string>` | 派生态 | ✗ runner.ts:38 / 防重叠 |
| `timer: setInterval` | 派生态 | ✗ start 创建 / stop 清 |
| `.clawforum/logs/llm-stats.jsonl` | jobs 内部状态 | ✓ llm-stats job 累积 |
| `.random-dream-state.json` | jobs 内部状态 | ✓ random-dream cooldown |
| `.deep-dream-state.json` | jobs 内部状态 | ✓ deep-dream cooldown |
| audit 事件 | 持久化 | ✓ 经 AuditWriter / 不独占 |

### 业务语义

- 「定时调度框架」L5 业务唯一发起点：tick 调度 / runKey 去重 / 同 job 防重叠 / job 异常隔离
- 进程形态：独立进程（`node cron-entry.js`）/ 由 Daemon spawn / SIGTERM 终止
- 状态：冻结期登记（phase227 / phase232）/ 结构补完不算解冻
- 物理位置双重归属：dream 系列物理在 `src/core/memory/` / 语义归属 cron 触发 + memory 业务（A.1 双重归属保留）

## 2. 接口

### 类型签名

```ts
import type { Audit } from '@/foundation/audit';

export type CronSchedule =
  | { type: 'daily'; time: string }       // "HH:MM" 每天固定时刻
  | { type: 'hourly' }                    // 每小时整点
  | { type: 'interval'; minutes: number }; // 每 N 分钟

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  handler: () => Promise<void>;
}

export class CronRunner {
  constructor(jobs: CronJob[], audit: Audit);
  start(tickIntervalMs?: number): void;   // default 1000ms
  stop(): void;
}

export function parseSchedule(s: string, audit?: Audit): CronSchedule;
// 格式：'hourly' | 'daily:HH:MM' | 'interval:Nm'
// 未知格式 → fallback hourly + audit `cron_parse_fallback`

// 工厂（应然）
export function createCronRunner(jobs: CronJob[], audit: Audit): CronRunner;

// jobs 接口（装配方注入）
export interface LlmStatsOptions { /* ... */ }
export function runLlmStats(opts: LlmStatsOptions): Promise<void>;

export interface DiskMonitorOptions { /* ... */ }
export function runDiskMonitor(opts: DiskMonitorOptions): Promise<void>;

// memory/ 模块（双重归属 / A.1）
export interface RandomDreamOptions { /* ... */ }
export function runRandomDream(opts: RandomDreamOptions): Promise<void>;

export interface DeepDreamOptions { /* ... */ }
export function runDeepDream(opts: DeepDreamOptions): Promise<void>;
```

### 前后置条件

- **runner 单线程 tick**：默认 1000ms tick / 每 tick 检查所有 job 是否到 runKey
- **runKey 去重**：同 schedule 同 runKey = 同周期 / 已跑过不再跑
- **job throw 不终止 runner**：catch + audit `cron_job_error` + 继续下一 job
- **dream LLM 内部并发**：可触发多 LLM 调用 / 但 runner 串行调度 jobs
- **CronJob[] 装配期固化**：构造期注入 / 运行期不变

### 失败分类

| 类别 | 形态 | 处置 |
|---|---|---|
| schedule 解析失败 | audit `cron_parse_fallback` + fallback hourly | 不抛 / β 双写 console.warn |
| job 单次失败 | catch + audit `cron_job_error` | 隔离不冒泡 / runner 继续 |
| dream LLM 失败 | catch + audit `*_error` | dream cooldown 触发 |
| disk-monitor 阈值超 | audit `cron_disk_monitor_threshold_exceeded` + InboxWriter 投 motion inbox | 双通道告警 |

## 3. 审计事件清单

> 事件常量集中定义于 `src/core/cron/audit-events.ts` `CRON_AUDIT_EVENTS`（runner + cron jobs / 模块自治）+ `src/core/memory/audit-events.ts` `MEMORY_AUDIT_EVENTS`（dream 系列双重归属 / phase345 H1 拆分）。

cron 模块（CRON_AUDIT_EVENTS / 7 events）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `cron_runner_started` | start | `jobs=N` |
| `cron_runner_stopped` | stop | `jobs=N` |
| `cron_llm_stats` | llm-stats job | `step` `date` summary fields |
| `cron_disk_monitor_check` | disk-monitor 每次检查 | `totalMB` `limitMB` |
| `cron_disk_monitor_threshold_exceeded` | 阈值触发 | 同上 |

字符串残留（B.p336-1 已闭环 / phase390）：

| 事件 type | 位置 | 状态 |
|---|---|---|
| ~~`cron_parse_fallback`~~ | runner.ts:24 | ✅ 已闭环 phase390（CRON_AUDIT_EVENTS.PARSE_FALLBACK）|
| ~~`cron_job_error`~~ | runner.ts:73 | ✅ 已闭环 phase390（CRON_AUDIT_EVENTS.JOB_ERROR）|

memory 模块双重归属事件（MEMORY_AUDIT_EVENTS / dream 系列）：

| 事件 type | 触发位置 | 关键载荷 |
|---|---|---|
| `cron_deep_dream_job` | deep-dream.ts step 标记 | `step`, `clawId`, counts |
| `cron_deep_dream_error` | deep-dream.ts catch | `step`, `clawId`, `file`, `reason` |
| `cron_random_dream_job` | random-dream.ts step 标记 | `step`, counts |
| `cron_random_dream_warning` | random-dream.ts warn | `reason` |
| `cron_disk_warning` | disk-monitor.ts → InboxWriter motion inbox | type-typed |

## 4. 层级声明

L5（外壳与能力）。下游 Daemon（L6a）spawn 独立进程 / SIGTERM 终止。

## 5. 上游依赖

| 依赖 | 层级 | 类型化 | 用途 |
|---|---|---|---|
| `Audit` | L2 | 接口注入 | runner + jobs 事件出口 |
| `FileSystem` | L1 | 接口注入 | jobs 内部读写 / dream 历史会话扫描 |
| `LLMService` | L1 | 接口注入 | 仅 deep-dream + random-dream 内部消费 / runner 不直接调 |
| `InboxWriter` | L2 / Messaging | 接口注入 | disk-monitor 越界告警投 motion inbox |
| `writePendingSubagentTaskFile` | L4 / TaskSystem | direct import | random-dream → task fire-and-forget（应然待 port 抽象 / 跨层潜在 drift）|

应然不依赖：
- 任何 L5+ 模块（Runtime / Daemon class / Watchdog / CLI internals）
- 直接 SubAgent class（仅经 task writer 间接）
- 任何 task 调度路径（仅 fire-and-forget）

## 6. 不可消除的耦合

| 耦合 | 方向 | 类型化 | 消除路径 / 放弃理由 |
|---|---|---|---|
| runner → AuditWriter | L5 → L2 | interface 注入 | 不消除（事件出口本质）|
| runner → CronJob[] handlers | 装配期注入 | interface | 不消除（runner 调度 jobs 是核心职责 / handler 异常 runner 隔离）|
| random-dream → `writePendingSubagentTaskFile`（L4 task）| 跨层值依赖 | direct import | 跨层潜在 drift / 推 r41+ port 抽象（参 verifier port pattern）|
| disk-monitor → InboxWriter motion inbox | L5 → L2 跨进程通信 | direct import | 不消除（cron 越界告警必投 motion inbox）|
| dream 系列 → LLMService | L5 → L1 | interface 注入 | 不消除（dream 业务核心）|
| 物理位置双重归属（cron/jobs vs memory/）| A.1 design-gap | — | 历史保留 / 不强行 mechanical |

## 7. 持久化

cron 模块 runner 无独占持久化资源 / jobs 内部 3 文件落盘：

| 信息 | 归属 | 落盘 |
|---|---|---|
| runner 运行时态（lastRunKey / running / timer）| Cron runner | ✗ 重启重置（D4 显式豁免）|
| llm-stats 累积 | llm-stats job | ✓ `.clawforum/logs/llm-stats.jsonl` |
| random-dream cooldown | random-dream | ✓ `.random-dream-state.json` |
| deep-dream cooldown | deep-dream | ✓ `.deep-dream-state.json` |
| audit 事件 | AuditWriter（L2）| ✓ |

**重建语义**：runner 重启 = 全部 job 状态重置 / 当前 tick 周期内重新触发（去重靠 lastRunKey 重新累积）。jobs 内部状态各自落盘恢复。

**D4 显式豁免**（runner 层面）：runner lastRunKey/running 不落盘 → 重启后上一周期已跑过的 job 会重跑。豁免理由：(a) jobs 设计为幂等（dream 重跑只是多生成一次输出 / llm-stats / disk-monitor 重跑无副作用）；(b) cron 是定时驱动 / 重启场景罕见；(c) 落盘 lastRunKey 引入 fs 依赖收益不抵成本。**Trade-off 显式登记 / 非 D4 静默违反**。

## 8. 应然 vs 实然差距登记

> 原则：本节只登记实然 ≠ 应然的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 8.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 random-dream / deep-dream 物理在 `src/core/memory/` 而非 `src/core/cron/jobs/` | design-gap / 双重归属 | open / 接受 | M#3 资源唯一归属灰度 / 双重归属保留（cron 触发 + memory 业务）/ 历史原因 / 不强行 mechanical 迁移 |

### 8.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~**B.p336-1 caller 字符串硬编码**~~ | ~~drift / 收敛中~~ | **✅ 闭环 phase390**（main `a82675a`）| phase336 α 方案：events.ts 9 死常量删 / phase345 cron + memory 双 audit-events.ts 模块自治建成 / phase390 治 runner.ts 2 处 leak（PARSE_FALLBACK + JOB_ERROR const 化）+ tests/runner.test.ts 同步改 const refs / B.p336-1 完全闭环 |
| ~~B.p344-2 应然 §6 「无独占持久化」错~~ | **✅ closed（应然修订 / phase389 status 同步）** | ~~应然滞后~~ → 本契约 §7 持久化表加 3 文件 / D4 豁免理由收窄至 runner lastRunKey |
| ~~B.p344-3 应然 §3+§4 漏 disk-monitor 经 InboxWriter 投 motion inbox~~ | **✅ closed（应然修订 / phase389 status 同步）** | ~~应然滞后~~ → 本契约 §5 加 InboxWriter 依赖 / §3 加 cron_disk_warning 投 motion inbox 路径 / §6 评估 cron → messaging 跨层耦合是否抽 port 推 r42+ |
| B.1 dream LLM 内部细节 audit 覆盖待核 | observability-debt / 低 | open / r43+ | dream 主路径有 audit ✓ / 内部 LLM 调用细节是否全 event 覆盖待核 / D5 部分违规 |

### 8.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：runner 调度与 jobs 业务独立 / runner 不知 job 业务语义
- M#2 业务语义归属：tick 调度由本模块发起 / jobs 业务归各 job
- M#3 资源唯一归属：A.1 双重归属保留（dream 物理 memory / 语义 cron）
- M#4 持久化：runner 派生态不落盘（D4 显式豁免）/ jobs 内部 3 状态文件各自落盘
- M#5 依赖单向：不反向依赖 Runtime / Daemon / 但 random-dream → L4 task writer 跨层（耦合 #3 / 推 r41+ 评估 port）
- M#6 依赖结构稳定：runner ctor 一次注入 / CronJob[] 装配期固化
- M#7 耦合界面稳定：CronJob interface 稳定 / 5 个 audit events const 稳定
- M#8 耦合界面最小：runner 接触面小 / B.p336-1 残留 2 处字符串硬编码（caller 风格统一收敛中）
- M#9 显式编译器可检：B.p336-1 残留 2 处字符串硬编码编译期不可查（待最后 leak 治理）
- M#10 不合理停下：jobs 可独立改不动 runner / phase227 冻结期 / 不强行重构
- M#11 边界对不上停下：A.1 双重归属与 B.p336-1 残留显式登记 / 不强行 mechanical

**Design Principles**

- D1 信息不丢失 / 可观察 / 可恢复 / 可审计：5+5 events 覆盖 / D4 显式豁免（runner lastRunKey 不落盘）
- D2 不丢弃 / 静默：parse_fallback / job_error 全 audit / β 双写
- D3 用户可观察：audit.tsv + runner stdout
- D4 中断恢复：runner 重启 lastRunKey 不落盘 / 上一周期已跑 job 会重跑 / 显式豁免（jobs 幂等 + 罕见场景 + 落盘成本不抵）
- D5 日志重建：runner 调度 / job 失败 / dream 主路径有 audit ✓ / dream 内部 LLM 细节待核（B.1）
- D6 子代理后不阻塞：random-dream 经 writePendingSubagentTaskFile fire-and-forget
- D7 系统可信路径：jobs 调用走 handler / 不走 CLI
- D8 事件驱动：**N/A（cron 是定时驱动 / 显式豁免）** / schedule 触发是定时模型 / D8 不适用
- D9 CLI 唯一外部入口：外部不直调 cron / 由 Daemon spawn
- D10 多 claw 信息不隔绝：dream 输出可跨 claw 读

**Philosophy**

- P4 系统为智能体服务：dream 系列为 claws 提供记忆整合基础设施
- 其他 P1/P2/P3 N/A（cron 是非智能体后台管道）

**Path Principles**

- Path #1 实然为唯一基准：phase336 扫描发现 9 死 const + 18 caller 字符串硬编码 / r48 audit 实测 caller 已大部分迁 const / 仅 2 leak
- Path #3 语义最小变更：phase336 死常量删 + phase345 模块自治拆分 / caller 风格统一并轨推后续治理
- Path #6 冲突立即中断：phase227 冻结期 / 不强行重构
- Path #8 总难度最低：α 方案选（events.ts 删 + 模块自治建 / caller 风格统一并轨独立 phase）

### 8.D 历史纪律

- 2026-04-23 / phase227 + phase232 cron 模块冻结登记（结构补完不算解冻）
- 2026-04-27 / phase336 H1 收官 / events.ts CRON_* 9 死常量删 + B.p336-1 登记（α 方案 / SHA `9d1bd83`）
- 2026-04-27 / phase345 caller 风格统一并轨第 1 次（cron/audit-events.ts + memory/audit-events.ts 双模块自治建成 / dream 系列迁 MEMORY_AUDIT_EVENTS / B.p336-1 大部分闭环）
- r48 实测：B.p336-1 残留 2 处字符串硬编码（runner.ts 内）/ 等 caller 风格统一并轨下次复用顺手治理
- 2026-04-28 / phase390 caller 风格并轨收尾（B.p336-1 完全闭环 / runner.ts 2 处 leak + tests 2 处断言改 const refs / SHA `a82675a`）

### 8.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号）| Cron 独立进程 / Daemon spawn | ✓（§1 进程形态）|
| KD（待编号）| dream 系列归属 cron 触发 + memory 业务 | A.1 双重归属保留 |

## 9. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **runner 生命周期**：start / stop / SIGTERM 终止 / tick 调度间隔
- **schedule 解析**：hourly / daily:HH:MM / interval:Nm 三形态 / 未知格式 fallback hourly + audit `cron_parse_fallback`
- **runKey 去重**：同 schedule 同 runKey 同周期不重跑
- **同 job 防重叠**：running Set 内不重复触发
- **job throw 隔离**：catch + audit `cron_job_error` / runner 不终止 / 继续下一 job
- **disk-monitor 双通道告警**：audit `cron_disk_monitor_threshold_exceeded` + InboxWriter 投 motion inbox
- **random-dream → task writer 联动**：fire-and-forget + audit `cron_random_dream_job`
- **deep-dream LLM 失败 catch**：audit `cron_deep_dream_error`
- **审计回链**：每个 §3 CRON_* + MEMORY_*_DREAM_* 事件触发时机 + 载荷断言（B.p336-1 治理后补 2 残留）
- **D4 重启幂等**：runner 重启 lastRunKey 重置 / 上一周期已跑 job 重跑 / jobs 幂等不副作用
