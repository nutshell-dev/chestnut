# Cron 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) Cron 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §26「Cron 本质：定时调度服务 / L5 服务 ——『定时调度』」加 M#1 / M#2 / M#5「底层模块不预设上层模块语义」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Cron 的单一职责 = **定时调度框架**：

- **runner 单线程 tick 调度**：默认 1000ms tick / 每 tick 检查所有 job 是否到 runKey
- **runKey 去重**：同 schedule 同 runKey = 同周期 / 已跑过不再跑（lastRunKey Map）
- **同 job 防重叠**：running Set 内不重复触发（handler 进出 add/delete）
- **job 异常隔离**：handler throw 不终止 runner / catch + audit `cron_job_error` + 继续下一 job
- **schedule 解析**：3 形态（daily:HH:MM / hourly / interval:Nm）/ 未知格式 fallback hourly + audit `cron_parse_fallback`
- **CronJob[] 装配期注入**：构造期注入 / 运行期不变（runner 不知 job 业务语义）
- **进程形态**：独立进程（`node cron-entry.js`）/ 由 Daemon spawn / SIGTERM 终止

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) Cron 节。具体实现细节（CronRunner 类 + lastRunKey Map + running Set + tick interval timer + parseSchedule helper + jobs handler 由 caller 注入如 llm-stats / disk-monitor / dream-trigger 等）的存在依据是「定时调度框架」原语 — 实然采纳的细节差异等登记 §7。

### 不做

- **不做业务任务语义**（具体 cron job 业务逻辑：dream-trigger / disk-monitor / llm-stats），归各业务模块自己 own / Cron 只 own 触发机制 — derive 自 M#5「底层模块不预设上层模块语义」
- **不做跨进程协调**（per-runner instance 不预设跨 daemon 协调）— derive 自 M#1
- **不持久化任务历史**（Cron runtime ephemeral / 去重时窗状态重启 reset / D4 显式豁免）— derive 自 M#3 + M#4
- **不解析复杂 cron 表达式**（仅 3 形态 daily / hourly / interval）— derive 自 M#8 耦合界面最小
- **不调 LLM 主路径**（LLM 仅 dream jobs 内部消费 / runner 不知）— derive 自 M#1
- **不预设具体业务 jobs**（CronJob 由装配方注入）— derive 自 M#5
- **不做异步任务派发**（具体 cron job 内部若需派子代理走 L4 AsyncTaskSystem）— derive 自 M#1
- **不做跨进程通信**（disk-monitor 投 motion inbox 走 L2 Messaging InboxWriter）— derive 自 M#5
- **不做任务结果回传**（Cron 仅触发处理器 / 处理器内部业务归处理器 caller）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Cron 的业务语义边界：

- **own**：「定时调度框架」业务语义唯一发起点 — tick 调度 / runKey 去重 / 同 job 防重叠 / job 异常隔离。这些是 Cron runner 唯一懂的「业务」（调度框架级）。
- **角色定位**：Cron 是「**generic 调度 primitive**」非「**业务任务执行器**」。jobs 业务由装配方注入 / runner 不知 job 业务语义。
- **非智能体**：系统级后台任务管道 / 不参与 agent 决策。
- **jobs 业务归各业务模块**：dream jobs 物理 + 业务 own 归 L4 MemorySystem / Cron 仅按 schedule 触发 handler / 不 own jobs 业务 state（M#5「底层模块不预设上层模块语义」derive）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），分两块清晰边界：

**Cron runner own（调度框架资源）**：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `lastRunKey: Map<string, string>` | 派生态 | ✗ 重启重置（runKey 去重）|
| `running: Set<string>` | 派生态 | ✗ 防重叠 |
| `timer: setInterval` | 派生态 | ✗ start 创建 / stop 清 |

**jobs 内部资源（非 Cron own / cron runner 仅触发 handler / state 归各业务模块）**：

| 资源 | 业务 own | 持久化 |
|---|---|---|
| `.clawforum/logs/llm-stats.jsonl` | llm-stats job (caller 注入) | ✓ 累积写 |
| `.random-dream-state.json` | MemorySystem (L4) | ✓ cooldown |
| `.deep-dream-state.json` | MemorySystem (L4) | ✓ cooldown |

> jobs 业务 state 全归各业务模块 own / Cron runner 不感知 / 仅按 schedule 触发 handler / handler 内部 read/write 各自 state 文件归各业务模块。

audit 事件经 L2 AuditWriter / 不独占（事件类型清单见 §5）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Cron 自身的持久化立场：runner 派生态不落盘（D4 显式豁免）/ jobs 内部 3 状态文件各自落盘。

| 信息 | 归属 | 落盘 |
|---|---|---|
| runner 运行时态（lastRunKey / running / timer）| Cron runner | ✗ 重启重置（D4 显式豁免）|
| llm-stats 累积 | llm-stats job | ✓ `.clawforum/logs/llm-stats.jsonl` |
| random-dream cooldown | random-dream | ✓ `.random-dream-state.json` |
| deep-dream cooldown | deep-dream | ✓ `.deep-dream-state.json` |
| audit 事件 | AuditWriter（L2）| ✓ |

**重建语义**：runner 重启 = 全部 job 状态重置 / 当前 tick 周期内重新触发（去重靠 lastRunKey 重新累积）。jobs 内部状态各自落盘恢复。

**D4 显式豁免**（runner 层面）：runner lastRunKey/running 不落盘 → 重启后上一周期已跑过的 job 会重跑。豁免理由：(a) jobs 设计为幂等（dream 重跑只是多生成一次输出 / llm-stats / disk-monitor 重跑无副作用）；(b) cron 是定时驱动 / 重启场景罕见；(c) 落盘 lastRunKey 引入 fs 依赖收益不抵成本。**Trade-off 显式登记 / 非 D4 静默违反**。

## 5. 审计事件清单

> 事件常量集中定义于 `src/core/cron/audit-events.ts` `CRON_AUDIT_EVENTS`（runner own / 模块自治）。dream 系列 cron-triggered events 归 MemorySystem 命名空间（业务 own / 详 modules/l4_memory_system.md §5）。

cron 模块（CRON_AUDIT_EVENTS / 7 events）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `cron_runner_started` | start | `jobs=N` |
| `cron_runner_stopped` | stop | `jobs=N` |
| `cron_parse_fallback` | parseSchedule 未知格式 | `input` |
| `cron_job_error` | job handler throw catch | `name` `reason` |
| `cron_llm_stats` | llm-stats job | `step` `date` summary fields |
| `cron_disk_monitor_check` | disk-monitor 每次检查 | `totalMB` `limitMB` |
| `cron_disk_monitor_threshold_exceeded` | 阈值触发 | 同上 |

cron-triggered MemorySystem events（归 MemorySystem own / Cron 仅触发 handler / 命名空间归业务模块）：

| 事件 type | 触发位置 | 关键载荷 |
|---|---|---|
| `cron_deep_dream_job` | deep-dream.ts step 标记 | `step`, `clawId`, counts |
| `cron_deep_dream_error` | deep-dream.ts catch | `step`, `clawId`, `file`, `reason` |
| `cron_random_dream_job` | random-dream.ts step 标记 | `step`, counts |
| `cron_random_dream_warning` | random-dream.ts warn | `reason` |
| `cron_disk_warning` | disk-monitor.ts → InboxWriter motion inbox | type-typed |

## 6. 层级声明

L5 服务（与 Runtime / Gateway 同层 / 「定时调度框架」业务语义独立可变 / **非智能体** / 系统级后台任务管道）。下游 Daemon（L6）spawn 独立进程 / SIGTERM 终止。详见 [architecture.md](../architecture.md) 加 [interfaces/l5.md](../interfaces/l5.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A.invariant 模块级硬约束（phase 542 sharpen）

> cron job handler 与装配方的依赖契约（M#5 单向依赖派生纪律）。

1. **cron job handler 必接受装配方预解析的 L1/L2 实例 via opts**：handler 函数（典型签名 `runXxx(opts: XxxOptions): Promise<void>`）的 `opts` 必含完整 deps（`FileSystem` / `AuditLog` / `InboxWriter` / messaging callback closures 等）/ **handler 内部不得 runtime instantiate L1 `NodeFileSystem` / L2 `createXxxAudit` / L2 `InboxWriter` / L2 `notifyInbox` 等业务实例**（应由装配方 `assemble.ts` 装配段预 build / 经 closure 注入 handler）/ 应然范例 = `runLlmStats`（phase 455 落地）/ 反例 = disk-monitor + contract-observer（phase 542 治理）。
2. **type-only 导入合规**：`import type { FileSystem }` / `import type { AuditLog }` 等 type-only 导入不构成 runtime 耦合 / 不视作 M#5 违反 / 仅用于 opts shape 声明 / 编译期擦除。
3. **timeout 后 race 防御 + late error audit 必**（phase 552 sharpen / 接力 phase 540 timeout escalation）：runner 处理 `timeoutMs` per-job 配置时 / timeout 触发后**不仅清 running 让下 tick 重试**（phase 540 落地）/ 还**必防御**「原 handler 仍未 settle 期间下 tick 不再重起该 job」/ 且**原 handler 真 settle 后**（无论 fulfill / reject / 多久后）/ reject 路径**必 audit**（不得因 race 已 resolve 'timeout' 而 silent 丢）。**应然立场**：handler 永挂常因 fs lock / LLM hang / 第二 instance 极可能同因 timeout → 资源指数堆积违 M#10 不合理停下 / late error silent 违 D2「不丢弃静默」+ D5「日志重建」/ 二者必同时治理（race 防御 + late error audit）/ 单修一项不闭环。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 random-dream / deep-dream 物理位置「双重归属」framing~~ | ~~design-gap / framing~~ | **✅ closed (framing 推翻)** | **应然真合规**：dream jobs 物理 + 业务 own 全归 L4 MemorySystem / Cron 仅按 schedule 触发 handler / 不存在「双重归属」/ 是清晰的「caller 注入 jobs handler」pattern（per arch §26 表 1 deps「业务依赖由 caller 注入 jobs handler 自持」）。framing 已推翻 / 应然立场清晰 |
| **A.bypass-1 Cron jobs/llm-stats.ts 直 import `node:fs`** | M#5 弱违反 / 中 | **✅ closed**（phase455 / main `f619b303`）| L5 Cron jobs/llm-stats.ts 直 import OS API 绕 FileSystem L1 / 6 fsNative calls 全清（mkdirSync / appendFileSync / existsSync × 2 / readdirSync / readFileSync）→ `fs.{ensureDirSync, appendSync, existsSync, listSync, readSync}` + `LlmStatsOptions` 加 `clawforumFs`+`motionFs` 字段 + caller cascade 装配期注入 / 行为 0 改 / 同 phase434+436 bypass cluster 模板 / 用户实施期顺手治（虽起初按 L5 排在 phase455 scope 外）|
| **A.handler-timeout-escalation runner 必有 per-job timeout 防 handler 永挂** | drift / 中 / r66 D fork derive 浮出 / r67 C fork race + late error 缺口 | **closed by phase 552**（main `4ed925f2`）/ phase 540 主线（commit `c4e9d657`）+ phase 552 race + late error 缺口双闭环 | 实然 `runner.ts:39+66+70+80` running Set 防同 job 重叠 / handler 永挂时（fs lock / 死循环 / 永不 settle promise）`finally` 永不触发 → running 永远含该 job → 后续 tick 全跳过 → job 静默死锁 / 无 escalate 路径 / 违 M#10 不合理停下 + D2 软降级 + D1「运行中所有信息不丢失，状态可观察」（job 死锁无可观察事件）/ **phase 540 落地态**：per-job `timeoutMs` 字段加（`CronJob` interface +`timeoutMs?: number`）+ runner Promise.race(handler, timeoutPromise) + timeout audit `cron_handler_timeout` + 强制 `running.delete(job.name)` 让下 tick 重试（commit `c4e9d657`）/ **phase 540 残留缺口**（r67 C fork Path #1 实测核 / 2/2 真 P0）：(1) **race 不彻底**：`runner.ts:103` timeout 清 running 后下 tick `running.has` false → re-fire / 原 handler 真没 settle（仍持 fs lock / LLM hang）/ 第二 instance 同因 timeout → 资源指数堆积 / M#10 边缘违反；(2) **silent late error**：`runner.ts:114` `if (result === 'timeout') return` 早退 / 原 `handlerPromise` 真 reject 时 P1 settle 为 `{err}` / 但 race 已 resolve 'timeout' / `.then(result => ...)` 不再触发 → reject 信息丢 / 违 D2+D5 / **phase 552 决策（28 原则核 5/5 一致 dominant 自决）**：γ NEW `cancelling: Set<string>` 二态（running = 在跑 / cancelling = 已 timeout 仍未 settle）/ tick 跳过条件 `running.has \|\| cancelling.has` / handler 真 settle 后清 cancelling 允下下 tick retry / + ζ 复用 `JOB_ERROR` const + 多参 `context=late_after_timeout`（0 NEW const / phase 541 silent X cluster 模板 align M#7+M#8 收益）/ **半业务残留**：各 job 默认 timeoutMs 值业务决策（phase 540 用户合入定 llm-stats/disk-monitor 60s / dream 30min / contract-observer 5min）|
| ~~A.bypass-2 disk-monitor handler runtime instantiate L2 messaging+audit~~ | ~~M#5 弱违反 / 中~~ | **✅ closed**（phase 542 / main `e4338db0` / merge `ca1ca1d0`）| 应然：cron job handler deps 装配方注入（§7.A.invariant 第 1 条 / phase 455 llm-stats 范例 align）。~~实然 `src/core/cron/jobs/disk-monitor.ts:5-6` runtime import `InboxWriter` + `createAuditWriter` + `:49-50` handler 内 `new InboxWriter(opts.fs, ...)` + `createAuditWriter(opts.fs, ...)` instantiate L2~~ → phase 542 Step B 实施：`DiskMonitorOptions` +`motionAudit: AuditLog` +`motionInbox: InboxWriter`（γ 决策 5/5 原则一致 / phase 296+533 工厂闭包模板 N+1 实证）/ assemble.ts 装配段预 build 注入 / handler 内删 runtime import + instantiate / vitest 1510/1510 PASS / 反向 3/3 PASS / 与 l4_contract_system §A.bypass-2（contract-observer 同型）同 phase / 与 phase 455 A.bypass-1（fsNative direct OS）同根 M#5 弱违反 cluster 不同型补完 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~**caller 字符串硬编码**~~ | ~~drift / 收敛中~~ | **✅ 闭环 phase390**（main `a82675a`）| phase336 α 方案：events.ts 9 死常量删 / phase345 cron + memory 双 audit-events.ts 模块自治建成 / phase390 治 runner.ts 2 处 leak（PARSE_FALLBACK + JOB_ERROR const 化）+ tests/runner.test.ts 同步改 const refs / caller 字符串硬编码 完全闭环 |
| ~~应然 §6 「无独占持久化」错~~ | **✅ closed（应然修订 / phase389 status 同步）** | ~~应然滞后~~ → 本契约 §4 持久化表加 3 文件 / D4 豁免理由收窄至 runner lastRunKey |
| ~~应然 §3+§4 漏 disk-monitor 经 InboxWriter 投 motion inbox~~ | **✅ closed（应然修订 / phase389 status 同步 + cron→messaging port closure phase 545）** | ~~应然滞后~~ → interfaces/l5.md 加 InboxWriter 依赖 / §5 加 cron_disk_warning 投 motion inbox 路径 / ~~评估 cron → messaging 跨层耦合是否抽 port 推 r42+~~ → **closure by phase 545 + phase 542**：phase 542 γ 装配方注入 closure（DiskMonitorOptions +`motionInbox: InboxWriter`）+ §7.A.invariant 第 2 条「type-only 导入合规」明确 disk-monitor.ts `import type InboxWriter` 不构成 runtime 耦合 / formal NotifyPort interface (α) 增 NEW 抽象层 0 收益（M#7+M#8+YAGNI 全 reject）/ 5/5 原则一致 γ / **「业务决策性 → 28 原则核 5/5 一致 → dominant 自决」第 7 实证累** |
| B.1 dream LLM 内部细节 audit 覆盖待核 | observability-debt / 低 | open / r43+ | dream 主路径有 audit ✓ / 内部 LLM 调用细节是否全 event 覆盖待核 / D5 部分违规 |
| **B.flaky-1 `tests/core/cron/random-dream.test.ts` EINVAL cleanup stderr** | **flaky test / 低** | **open / 2026-05-10 phase619 发现** | 全量运行时在 stderr 中偶发 `[test cleanup] Failed to remove ... EINVAL: invalid argument, rmdir '.../motion/tasks/queues/results/<uuid>'` / 测试本身 PASS（cleanup 阶段失败不影响断言结果）/ 根因：test teardown 与 random-dream 内部 subagent 异步 cleanup 时序竞态 / macOS 临时目录递归删除时子目录未清空导致 EINVAL / **与 phase619 修改无关**（phase619 只触及 `src/core/evolution-system/` + `src/core/async-task-system/stream-events.ts`，0 触及 cron/memory 模块）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test teardown 前置强制 cleanup 或加 await 稳定轮询）|
| ~~`random-dream → writePendingSubagentTaskFile` 跨层值依赖~~ | drift / 中 | **✅ closed phase424**（cross-ref l4_memory_system §7.B / TaskLifecyclePort 删 + random-dream 直 dep AsyncTaskSystem class）| 真合规落地：random-dream 物理在 memory L4 / 直 dep AsyncTaskSystem L4 同层单向 / 0 port abstraction / port pattern reversal 第 2 例 / 详 feedback_governance_workaround_smell |
| ~~**B.handler-stuck-watchdog** handler 真永挂 → cancelling 永不清 → cron job 永久 silent dead~~ | drift / 中 / r74 H boundary fork phase 615 derive | **✅ closed by phase 615**（commit `6776e339` / merge `fc08cdd9`）| **触发**：r74 fan-out 浮 P1.14 / Path #1 实测 cron/runner.ts:110 `cancelling.add` / line 116-132 唯一清路径 = handlerPromise.then-callback / **handler 真永挂（never resolves/rejects）→ then-callback 永不 fire → cancelling 永不清 → tick 顶部 line 69 永久 skip 该 job → cron job 永久 silent dead** / 无 watchdog audit / 无 dead-letter / 违 D1c 中断可恢复 + D2 不静默 + D5 冗余防御。**phase 615 决策（28 原则核 7/7 dominant α vs β Promise cancel 不可行 3/7 + γ 不动 1/7）**：α NEW const `CRON_AUDIT_EVENTS.HANDLER_STUCK = 'cron_handler_stuck'` + class field `cancellingTicks: Map<string, number>` + module-level const `CANCELLING_STUCK_TICKS = 10` + tick() 顶部遍历 cancelling 增计数 / 阈值后 audit + 强清 cancelling + cancellingTicks（让下 tick 自然重试 / D1c 中断可恢复 + handler 幂等假设）+ timeout 入 cancelling 时 cancellingTicks.set 0 + late-settle then-callback 同步清 cancellingTicks（幂等）/ **known limitation**：JS Promise 不可真 cancel / 异步泄漏可接受（同既有 timeoutMs 模板 R2）/ 真 cancellation 推 r75+ 业务决策 / 模板：phase 540 cron timeout race + 615 stuck watchdog 同根 cluster 第 N+1 实证 / 与 l2_audit_log §B.fallback-buffer-origin-tag 同 phase 双 P1 cluster fix / **phase 649 r80 B fork deeper review 双维度 STALE 推翻**：(维度 1) timer 资源原 sub-agent P1.4 claim「leak」实然已 line 161 race chain `clearTimeout(timer)` 完整清 / 0 leak / framing 错位 / (维度 2) handlerPromise.then subscriber + 闭包 inherent JS limitation 维持 phase 615 known limitation accept 立场（不重复登记）/ 真 cancellation 升级（α 维持 vs γ AbortSignal handler API 重构）推 r80+ 业务方需求驱动（如出现「handler 永挂内存累积致 OOM」实证）|

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：runner 调度与 jobs 业务独立 / runner 不知 job 业务语义
- M#2 业务语义归属：tick 调度由本模块发起 / jobs 业务归各 job
- M#3 资源唯一归属：runner own 调度框架资源 / jobs 业务 state 归各业务模块（dream 归 L4 MemorySystem / A.1 双重归属 framing 已推翻 closed）
- M#4 持久化：runner 派生态不落盘（D4 显式豁免）/ jobs 内部 3 状态文件各自落盘
- M#5 依赖单向：不反向依赖 Runtime / Daemon / random-dream 物理 L4 memory → 直 dep AsyncTaskSystem L4 同层单向（phase424 后真合规 / 详 §7.B closed row）
- M#6 依赖结构稳定：runner ctor 一次注入 / CronJob[] 装配期固化
- M#7 耦合界面稳定：CronJob interface 稳定 / 7 个 audit events const 稳定
- M#8 耦合界面最小：runner 接触面小 / phase390 caller 字符串硬编码完全闭环
- M#9 显式编译器可检：phase390 后 caller 全 const refs / 编译期可查
- M#10 不合理停下：jobs 可独立改不动 runner / phase227 冻结期 / 不强行重构
- M#11 边界对不上停下：A.1 双重归属 framing 推翻 closed / random-dream 跨层值依赖 phase424 closed / 实然 align 真合规

**Design Principles**

- D1 信息不丢失 / 可观察 / 可恢复 / 可审计：7 CRON_* + 5 MEMORY_* dream events 覆盖 / D4 显式豁免（runner lastRunKey 不落盘）
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

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：phase336 扫描发现 9 死 const + 18 caller 字符串硬编码 / r48 audit 实测 caller 已大部分迁 const / 仅 2 leak / phase390 完全闭环（治理动作要 grep 实然代码佐证）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：phase336 死常量删 + phase345 模块自治拆分 / phase390 caller 风格统一并轨收尾 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：phase227 冻结期 / 不强行重构（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）/ α 方案选（events.ts 删 + 模块自治建 / caller 风格统一并轨独立 phase）

> 注：原 §7.C「Path #8 总难度最低」是 Path #7 mis-numbered（canonical Path Principles 7 条 / 第 8 条不存在）/ 已修订为 Path #7「总难度路径」verbatim + 保留 α 方案 derive 注。

### 7.D 历史纪律

- 2026-04-23 / phase227 + phase232 cron 模块冻结登记（结构补完不算解冻）
- 2026-04-27 / phase336 H1 收官 / events.ts CRON_* 9 死常量删 + caller 字符串硬编码登记（α 方案 / SHA `9d1bd83`）
- 2026-04-27 / phase345 caller 风格统一并轨第 1 次（cron/audit-events.ts + memory/audit-events.ts 双模块自治建成 / dream 系列迁 MEMORY_AUDIT_EVENTS / caller 字符串硬编码大部分闭环）
- r48 实测：caller 字符串硬编码残留 2 处（runner.ts 内）/ 等 caller 风格统一并轨下次复用顺手治理
- 2026-04-28 / phase390 caller 风格并轨收尾（caller 字符串硬编码完全闭环 / runner.ts 2 处 leak + tests 2 处断言改 const refs / SHA `a82675a`）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l5.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）
- 2026-05-04 / phase455 fsNative bypass 治理（main `f619b303`）/ jobs/llm-stats.ts 6 calls 全切 FS abstraction / LlmStatsOptions 加 clawforumFs+motionFs 字段 / caller cascade 装配期注入 / 用户实施期顺手治（起初按 L5 scope 排在 phase455 外 / 用户实施时一并治）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l5_cron.md vs arch §26 + 表 1/2 + interfaces/l5.md Cron 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1-D10 + D8 显式豁免 + Philosophy P4 + Path #1+#3+#6+#8）/ 3 主能力 align arch 表 2（调度启停 + tick 触发 + schedule 解析）/ 资源派生态 + jobs 业务 own 边界清晰（A.1 双重归属 framing 推翻闭环保留）/ phase227 冻结 + phase336+345+390+455 多次治理后 settled / design only / 0 src 改
- 2026-05-08 / phase 542 §7.A.invariant + §A.bypass-2 cron job handler deps 装配方注入 closed（main `e4338db0` / merge `ca1ca1d0` / r66 B fork / 起步 SHA `ad4c0320` / 主会话 Step A design + user Step B+C code）/ §7.A.invariant 加 2 行硬约束（handler 不 runtime instantiate L1/L2 + type-only 合规）+ §7.A 加 A.bypass-2 disk-monitor handler runtime instantiate L2 messaging+audit（γ 决策 5/5 原则一致 / 同 phase 455 llm-stats 范例 / phase 296+533 工厂闭包模板 N+1 实证）/ 与 l4_contract_system §A.bypass-2（contract-observer 同型）同 phase / vitest 1510/1510 PASS / 反向 3/3 PASS / **dispatch P0 框架 → Path #1 实测 STALE 推翻**：dispatch 标 llm-stats 为 P0 / 实测 type-only 已合规 / **3 真违 → 2 真违 + 1 STALE 范例**（phase 458 STALE 模板第 N 实证累）/ **「业务决策性 → 28 原则核 5/5 一致 → dominant 自决」第 N 实证累**（phase 520+521+522+531+537+542）
- 2026-05-08 / phase 545 G fork r66 design closure（design only / 0 src）/ §7.B B.6 row「cron → messaging 跨层耦合 port 抽」closure by phase 545 + phase 542：phase 542 γ 装配方注入（DiskMonitorOptions +`motionInbox: InboxWriter`）+ §7.A.invariant 第 2 条 type-only 合规 / formal NotifyPort interface (α) 0 收益 / 5/5 原则一致 γ / **「relay phase 影响 design 闭口连环」模板**（phase 542 装配方注入 → phase 545 G.1 closure）/ **「design closure phase 单 Step A 形态」累 N 实证**（phase 503+505+545）/ 与 l2_file_tool §B clawspace 占用 (3)+(6) closure 同 phase / 「业务决策性 → 28 原则核 5/N derive → dominant 自决」累 7（phase 520+521+522+531+537+542+545）
- 2026-05-10 / phase 615 H boundary fork r74 code（commit `6776e339` / merge `fc08cdd9` / 起步 SHA `710c1fb5` / 主会话 plan + 用户 code）/ **§B.handler-stuck-watchdog ✅ closed**：α NEW const HANDLER_STUCK + cancellingTicks Map field + CANCELLING_STUCK_TICKS=10 module const + tick 顶部 stuck 检查循环 + late-settle then-callback 同步清 / 行为差：handler 永挂时 timeoutMs 后 10 ticks（≈ 10s）audit + 重置 / 下 tick 自然重试 / 0 行为差正常路径 / **「cron timeout race 防御」第 N+1 实证累**（phase 540 + 615 同根 cluster）/ **「业务决策性 phase 但 28 原则 7/7 dominant 自决」第 N 实证**（不入 J fork ratify）/ 副发现：JS Promise 不可真 cancel 是 known limitation / cron handler cancellation 真支持推 r75+ 业务决策 / 与 l2_audit_log §B.fallback-buffer-origin-tag 同 phase 双 P1 cluster fix
- 2026-05-10 / **phase 649 P1.4 cron timer leak race deeper review STALE 推翻（B fork r80 / 起步 SHA `4f1ebb52` / 主会话 own / design only / 0 src）**/ phase 646 P1.4 推后 deeper review 兑现 / Path #1 双维度核：(维度 1) timer 资源 STALE 推翻（line 161 race chain clearTimeout 完整清 / 0 leak）+ (维度 2) handlerPromise.then subscriber + 闭包 inherent JS limitation 维持 phase 615 row known limitation accept 立场（不重复登记）/ 真 cancellation 升级（γ AbortSignal handler API 重构）推 r80+ 业务方需求驱动 / **「dispatch claim framing 待 deeper review → 推后 → STALE 推翻」N=2 升格阈值达**（phase 646 推后 + 649 兑现 STALE 推翻 / 推 Meta 44 升格独立 feedback）/ **「review claim 实测四态分类」第 N+1 实证累**（C3 STALE 推翻 ×2 维度 / 0 真 drift / dispatch ratio 0%）/ **「known limitation 立场维持 / 不重复登记」首发模板**（phase 615 已记 / phase 649 引用立场不重复 row / 推 r80+ ≥ 2 实证升格）/ **「design only single Step inline」N=10 实证累**（mirror phase 503+505+545+554+567+621+622+629+635+649 模板深度成熟极致）/ 0 src diff / B fork r80 design only / B.handler-stuck-watchdog row 末追加 deeper review 注

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号）| Cron 独立进程 / Daemon spawn | ✓（§1 进程形态）|
| KD（待编号）| dream 系列业务归 L4 MemorySystem / Cron 仅按 schedule 触发 handler / 不 own jobs 业务 | ✓ 真合规（A.1 双重归属 framing 推翻 closed）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **runner 生命周期**：start / stop / SIGTERM 终止 / tick 调度间隔
- **schedule 解析**：hourly / daily:HH:MM / interval:Nm 三形态 / 未知格式 fallback hourly + audit `cron_parse_fallback`
- **runKey 去重**：同 schedule 同 runKey 同周期不重跑
- **同 job 防重叠**：running Set 内不重复触发
- **job throw 隔离**：catch + audit `cron_job_error` / runner 不终止 / 继续下一 job
- **disk-monitor 双通道告警**：audit `cron_disk_monitor_threshold_exceeded` + InboxWriter 投 motion inbox
- **random-dream → task writer 联动**：fire-and-forget + audit `cron_random_dream_job`
- **deep-dream LLM 失败 catch**：audit `cron_deep_dream_error`
- **审计回链**：每个 §5 CRON_* + MEMORY_*_DREAM_* 事件触发时机 + 载荷断言（caller 字符串硬编码 phase390 完全闭环）
- **D4 重启幂等**：runner 重启 lastRunKey 重置 / 上一周期已跑 job 重跑 / jobs 幂等不副作用
