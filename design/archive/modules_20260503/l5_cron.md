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

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) Cron 节。具体实现细节（CronRunner 类 + lastRunKey Map + running Set + tick interval timer + parseSchedule helper + jobs 内部 llm-stats / disk-monitor / random-dream / deep-dream 等）的存在依据是「定时调度框架」原语 — 实然采纳的细节差异加双重归属（dream 物理 memory / 语义 cron）等登记 §7。

### 不做

- **不做业务任务语义**（具体 cron job 业务逻辑：dream-trigger / disk-monitor / llm-stats），归各业务模块自己 own / Cron 只 own 触发机制 — derive 自 M#5「底层模块不预设上层模块语义」
- **不做跨进程协调**（per-runner instance 不预设跨 daemon 协调）— derive 自 M#1
- **不持久化任务历史**（Cron runtime ephemeral / 去重时窗状态重启 reset / D4 显式豁免）— derive 自 M#3 + M#4
- **不解析复杂 cron 表达式**（仅 3 形态 daily / hourly / interval）— derive 自 M#8 耦合界面最小
- **不调 LLM 主路径**（LLM 仅 dream jobs 内部消费 / runner 不知）— derive 自 M#1
- **不预设具体业务 jobs**（CronJob 由装配方注入）— derive 自 M#5
- **不做异步任务派发**（具体 cron job 内部若需派子代理走 L4 TaskSystem）— derive 自 M#1
- **不做跨进程通信**（disk-monitor 投 motion inbox 走 L2 Messaging InboxWriter）— derive 自 M#5
- **不做任务结果回传**（Cron 仅触发处理器 / 处理器内部业务归处理器 caller）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Cron 的业务语义边界：

- **own**：「定时调度框架」业务语义唯一发起点 — tick 调度 / runKey 去重 / 同 job 防重叠 / job 异常隔离。这些是 Cron runner 唯一懂的「业务」（调度框架级）。
- **角色定位**：Cron 是「**generic 调度 primitive**」非「**业务任务执行器**」。jobs 业务由装配方注入 / runner 不知 job 业务语义。
- **非智能体**：系统级后台任务管道 / 不参与 agent 决策。
- **物理位置双重归属**：dream 系列物理在 `src/core/memory/` / 语义归属 cron 触发 + memory 业务（A.1 双重归属保留 / 历史原因 / 不强行 mechanical 迁移）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），分两块清晰边界：

**Cron runner own（调度框架资源）**：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `lastRunKey: Map<string, string>` | 派生态 | ✗ runner.ts:37 / 重启重置 |
| `running: Set<string>` | 派生态 | ✗ runner.ts:38 / 防重叠 |
| `timer: setInterval` | 派生态 | ✗ start 创建 / stop 清 |

**jobs 内部资源（业务 own / 物理在 cron module 内 / 双重归属保留）**：

| 资源 | 业务 own | 持久化 |
|---|---|---|
| `.clawforum/logs/llm-stats.jsonl` | llm-stats job | ✓ 累积写 |
| `.random-dream-state.json` | random-dream / 物理在 `src/core/memory/` | ✓ cooldown |
| `.deep-dream-state.json` | deep-dream / 物理在 `src/core/memory/` | ✓ cooldown |

> 双重归属理由：dream 系列物理位于 `src/core/memory/`（业务归 memory）/ 触发由 cron 调度（调度归 cron）/ 历史保留 / 详 §1「不做」+ §7.A A.1 登记。runner 不感知 jobs 内部 state 文件 / 各 job 自行 read/write。

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

> 事件常量集中定义于 `src/core/cron/audit-events.ts` `CRON_AUDIT_EVENTS`（runner + cron jobs / 模块自治）+ `src/core/memory/audit-events.ts` `MEMORY_AUDIT_EVENTS`（dream 系列双重归属）。

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

memory 模块双重归属事件（MEMORY_AUDIT_EVENTS / dream 系列）：

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

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 random-dream / deep-dream 物理在 `src/core/memory/` 而非 `src/core/cron/jobs/` | design-gap / 双重归属 → ⚓ accepted-stable | **⚓ accepted-stable** | **应然立场已合规**：双重归属是设计意图（cron 触发 + memory 业务）/ 物理在 memory 反映业务归属 / cron 仅触发 / runner 不感知 jobs 内部 state 文件。升档：跨 module 重构需重新评估归属 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~**caller 字符串硬编码**~~ | ~~drift / 收敛中~~ | **✅ 闭环 phase390**（main `a82675a`）| phase336 α 方案：events.ts 9 死常量删 / phase345 cron + memory 双 audit-events.ts 模块自治建成 / phase390 治 runner.ts 2 处 leak（PARSE_FALLBACK + JOB_ERROR const 化）+ tests/runner.test.ts 同步改 const refs / caller 字符串硬编码 完全闭环 |
| ~~应然 §6 「无独占持久化」错~~ | **✅ closed（应然修订 / phase389 status 同步）** | ~~应然滞后~~ → 本契约 §4 持久化表加 3 文件 / D4 豁免理由收窄至 runner lastRunKey |
| ~~应然 §3+§4 漏 disk-monitor 经 InboxWriter 投 motion inbox~~ | **✅ closed（应然修订 / phase389 status 同步）** | ~~应然滞后~~ → interfaces/l5.md 加 InboxWriter 依赖 / §5 加 cron_disk_warning 投 motion inbox 路径 / 评估 cron → messaging 跨层耦合是否抽 port 推 r42+ |
| B.1 dream LLM 内部细节 audit 覆盖待核 | observability-debt / 低 | open / r43+ | dream 主路径有 audit ✓ / 内部 LLM 调用细节是否全 event 覆盖待核 / D5 部分违规 |
| ~~`random-dream → writePendingSubagentTaskFile` 跨层值依赖~~ | drift / 中 | **✅ closed phase424**（cross-ref l4_memory_system §7.B / TaskLifecyclePort 删 + random-dream 直 dep TaskSystem class）| 真合规落地：random-dream 物理在 memory L4 / 直 dep TaskSystem L4 同层单向 / 0 port abstraction / port pattern reversal 第 2 例 / 详 feedback_governance_workaround_smell |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：runner 调度与 jobs 业务独立 / runner 不知 job 业务语义
- M#2 业务语义归属：tick 调度由本模块发起 / jobs 业务归各 job
- M#3 资源唯一归属：A.1 双重归属保留（dream 物理 memory / 语义 cron）
- M#4 持久化：runner 派生态不落盘（D4 显式豁免）/ jobs 内部 3 状态文件各自落盘
- M#5 依赖单向：不反向依赖 Runtime / Daemon / random-dream 物理 L4 memory → 直 dep TaskSystem L4 同层单向（phase424 后真合规 / 详 §7.B closed row）
- M#6 依赖结构稳定：runner ctor 一次注入 / CronJob[] 装配期固化
- M#7 耦合界面稳定：CronJob interface 稳定 / 7 个 audit events const 稳定
- M#8 耦合界面最小：runner 接触面小 / phase390 caller 字符串硬编码完全闭环
- M#9 显式编译器可检：phase390 后 caller 全 const refs / 编译期可查
- M#10 不合理停下：jobs 可独立改不动 runner / phase227 冻结期 / 不强行重构
- M#11 边界对不上停下：A.1 双重归属与 random-dream 跨层值依赖显式登记 / 不强行 mechanical

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

**Path Principles**

- Path #1 实然为唯一基准：phase336 扫描发现 9 死 const + 18 caller 字符串硬编码 / r48 audit 实测 caller 已大部分迁 const / 仅 2 leak / phase390 完全闭环
- Path #3 语义最小变更：phase336 死常量删 + phase345 模块自治拆分 / phase390 caller 风格统一并轨收尾
- Path #6 冲突立即中断：phase227 冻结期 / 不强行重构
- Path #8 总难度最低：α 方案选（events.ts 删 + 模块自治建 / caller 风格统一并轨独立 phase）

### 7.D 历史纪律

- 2026-04-23 / phase227 + phase232 cron 模块冻结登记（结构补完不算解冻）
- 2026-04-27 / phase336 H1 收官 / events.ts CRON_* 9 死常量删 + caller 字符串硬编码登记（α 方案 / SHA `9d1bd83`）
- 2026-04-27 / phase345 caller 风格统一并轨第 1 次（cron/audit-events.ts + memory/audit-events.ts 双模块自治建成 / dream 系列迁 MEMORY_AUDIT_EVENTS / caller 字符串硬编码大部分闭环）
- r48 实测：caller 字符串硬编码残留 2 处（runner.ts 内）/ 等 caller 风格统一并轨下次复用顺手治理
- 2026-04-28 / phase390 caller 风格并轨收尾（caller 字符串硬编码完全闭环 / runner.ts 2 处 leak + tests 2 处断言改 const refs / SHA `a82675a`）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l5.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号）| Cron 独立进程 / Daemon spawn | ✓（§1 进程形态）|
| KD（待编号）| dream 系列归属 cron 触发 + memory 业务 | A.1 双重归属保留 |

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
