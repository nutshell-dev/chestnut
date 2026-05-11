# ProcessManager 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2a.md](../interfaces/l2a.md) ProcessManager 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §8「ProcessManager 本质：进程生命周期编排服务 / L2 通用基础设施 / 在 L1 ProcessExec 加 L1 FileSystem 之上 / 把进程生命周期编排封装成多模块共用的基础服务 / 自己不知任何 agent 或 LLM 业务」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），ProcessManager 的单一职责 = **进程生命周期编排（spawn 加注册加判活加 lockfile 加优雅停止）的统一入口**：

- **进程生命周期编排**：spawn 加 detach 加 PID 注册加判活加优雅停止（graceful / force / interrupt 三档意图）— 这是「跨多消费者复用的进程生命周期管理」（与 OS 进程能力原语 L1 ProcessExec 区分 / 与业务化重启策略 L6 Watchdog 区分）。
- **PID 文件加 lockfile 唯一入口**：进程标识加排他启动锁的所有读写判活必经本模块（M#3 资源唯一归属 derive）— 用 L1 FileSystem 的 `writeExclusive` 实现独占语义。
- **意图级信号 API**：暴露三档意图（graceful / force / interrupt）/ OS 信号名（SIGTERM / SIGKILL / SIGINT）映射归 L1 ProcessExec 内部细节（M#7 耦合界面稳定 derive）。

> 具体 API 形态归 [interfaces/l2a.md](../interfaces/l2a.md) ProcessManager 节。具体 method 实例（spawn / acquireLock / selfWritePid / 等）的存在依据是「进程生命周期编排所需的子动作」— 实然采纳的 method 集合差异加 dirResolver 扩展点等登记 §7.B。

### 不做

- **不 own OS 进程能力原语**（child_process / pgrep 等直接调归 L1 ProcessExec / 同 fs 直接调归 L1 FileSystem）— derive 自 M#5 单向依赖（业务模块不直接 import OS API）
- **不 own 调用方业务概念**（这进程是哪个 daemon / 什么 agent identity 归调用方业务）— derive 自 M#2 业务语义归属
- **不 own OS 信号名暴露**（caller-facing API 用意图三档 / OS 信号映射是 L1 ProcessExec 内部细节）— derive 自 M#2 + M#7 耦合界面稳定
- **不 own 业务化重启策略**（重启时机加 backoff 加重启决策归 L6 Watchdog）— derive 自 M#1 独立可变职责
- **不 own 子进程运行时健康检查**（健康监控归 L6 Watchdog）— derive 自 M#1
- **不 own 信号处理约定**（具体 agent 收到 SIGTERM 怎么响应归各 agent 自身）— derive 自 M#1 + M#2
- **不 own 日志聚合 / 滚动**（调用方传 logFile / 本模块仅 stdio 重定向 / 切分加查看加滚动归调用方）— derive 自 M#1 + M#2

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），ProcessManager 的业务语义边界：

- **own**：进程生命周期编排概念 — PID 加 lockfile 加 alive status 加意图级信号加 spawn / detach 操作。这些是 ProcessManager 唯一懂的「业务」（生命周期编排级，不是 clawforum agent 业务级）。
- **角色定位**：ProcessManager 是「**通用进程生命周期编排器**」非「**业务身份解读器**」。CLI / Daemon / Watchdog 等 caller 经公共 API 消费 / 不直接读写 PID lockfile 字面量 / 各 caller 在自己的业务身份层面用进程概念。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），ProcessManager 独占的资源：

- **PID 文件加 lockfile 读写**：clawforum 内部进程注册加排他启动锁必经 ProcessManager 间接访问 — 是 clawforum 对「进程标识 + 排他启动」这两类磁盘 artifact 的唯一调用入口。
- **`<baseDir>/claws/<id>/status/pid`**：每 claw 的 PID 文件（默认 dirResolver / 调用方可注入扩展给 Motion 等特殊 agent 自定义路径）。
- **`<baseDir>/claws/<id>/status/daemon.lock`**：lockfile / 独占启动锁。
- **时间常量对外导出**：`PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS`（type-level 资源 / CLI 等待 spawn 稳定的时间 = 本模块内部轮询上限同源 / 引用常量而非字面量）。
- **运行期内存状态**：`findProcessesWarned: Set<string>` 实例级去重（pgrep 失败 audit 防洪泛 / 重启即丢）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），ProcessManager 持久化两类 artifact：PID 文件（进程身份 + 存活权威）+ lockfile（排他启动锁）。重启后两者从磁盘读即可重建运行期判活加锁状态。

### 磁盘布局

```
<baseDir>/claws/<clawId>/status/
├── pid                          ← PID 文件（独占归属 / wx 排他写）
└── daemon.lock                  ← lockfile（独占启动锁）
```

Motion 走 `dirResolver` 自定义路径（典型）：

```
<baseDir>/motion/status/
├── pid
└── daemon.lock
```

### 文件格式

- **pid 文件**：单行字符串 / 进程 PID 数字（`writeExclusiveSync` 写入）
- **daemon.lock**：单行字符串 / 持有者 PID（acquireLock 写入 / releaseLock 删除）

### 重建语义

- **进程在 → PID 文件在**：spawn 时 `writeExclusiveSync` 创建 / 进程退出时 `selfRemovePid` 删除
- **进程失活 → 自动清理 stale**：下次 isAlive 调用 `kill(pid, 0)` 回 ESRCH / 旁路清理 PID 文件
- **跨进程重启**：PID 文件是「运行时句柄的磁盘持久化载体」/ 进程崩溃后下次启动 `acquireLock` 检测 stale lockfile / 清理后重新 acquire
- **wx 排他启动**：保证同时只有一个 spawn 写入成功 / 已活进程 wx 冲突抛 `AlreadyRunningError`

## 5. 审计事件清单

事件常量集中定义于 `PROCESS_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

### 进程生命周期事件

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `PROCESS_SPAWNED` | spawn 成功 | `clawId=`, `pid=` |
| `PROCESS_SPAWN_FAILED` | spawn 失败 | `clawId=`, `reason=` |
| `PROCESS_STOPPED` | stop 实际终止进程 | `clawId=`, `pid=` |
| `PROCESS_STOP_FAILED` | stop 信号发送失败 | `clawId=`, `reason=` |
| `PROCESS_KILL_ESCALATED` | SIGTERM → SIGKILL 升级 | `clawId=`, `pid=` |
| `PROCESS_STOP_STALE` | stop 目标 stale（ESRCH）| `clawId=`, `reason=` |
| `PROCESS_LIST_FAILED` | findProcesses 异常 | `pattern=`, `reason=` |
| `ORPHAN_SIGTERM_FAILED` | pgrep 清理孤儿 SIGTERM 失败 | `pid=`, `reason=` |

### PID 文件事件

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `PID_READ_OK` | readPid 成功 | `clawId=`, `pid=` |
| `PID_READ_FAILED` | readPid 读失败（非 ENOENT）| `clawId=`, `reason=` |
| `PID_WRITE_OK` | selfWritePid 成功 | `clawId=`, `pid=` |
| `PID_WRITE_FAILED` | selfWritePid 失败 | `clawId=`, `reason=` |
| `PID_REMOVE_OK` | removePid / selfRemovePid 成功 | `clawId=` |
| `PID_REMOVE_FAILED` | removePid 删除失败 | `clawId=`, `reason=` |
| `PID_EMPTY` | PID 空文件（并发 spawn 征兆）| `clawId=` |

### lockfile 事件

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `LOCK_ACQUIRED` | acquireLock 成功 | `clawId=`, `pid=` |
| `LOCK_RELEASED` | releaseLock 成功 | `clawId=` |
| `LOCKFILE_READ_FAILED` | lockfile 读失败 | `clawId=`, `reason=` |
| `LOCKFILE_CLEANUP_FAILED` | lockfile SIGTERM / 删除失败 | `clawId=`, `reason=` |

## 6. 层级声明

L2 通用基础设施层（与 AuditLog / Snapshot 同子层 / 进程生命周期编排原语 / 不预设业务模块 / 自己不知任何 agent 或 LLM 业务）。下游 Daemon（自注册 PID + 生命周期）+ Watchdog（监控目标进程 + 重启）+ CLI 通过工厂消费。详见 [architecture.md](../architecture.md) 加 [interfaces/l2a.md](../interfaces/l2a.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 9 处 console.warn 软吞 | drift | 已闭环（phase148）| 9 console → 9 audit events / ctor audit 必传 / 不提供 NoopAudit |
| A.2 findProcesses 失败语义二分（pgrep 不可用 vs 无匹配）| drift | 已闭环（phase150+）| 异常 throw `ProcessListUnavailable` / 无匹配返 [] / spawn 路径自行 catch 降级继续（实然采纳 throw 形态 / 契约同步采纳）|
| A.3 进程生命周期 audit | drift | 已闭环（phase148）| 5 类事件全链（SPAWNED / SPAWN_FAILED / STOPPED / KILL_ESCALATED / STOP_STALE）|
| A.4 daemon.lock CLI 绕过资源归属 | drift | 已闭环（phase152）| acquireLock / releaseLock / readLockPid 3 公共方法 + getLockPath helper 收敛字面量 |
| A.5 时间常量跨层耦合（constants.ts 中立）| drift | 已闭环（phase233 / SHA `37d8bb1`）| PROCESS_SPAWN_CONFIRM_MS / SIGTERM_GRACE_MS 迁至 manager.ts export const / CLI 三文件改 import 来源 / constants.ts 删除对应条目 |
| PID call sites bypass | drift | 已闭环（phase228 / SHA `b50fa53`）| 7 call sites（daemon.ts 3 + claw.ts 1 + chat-viewport.ts 3）全切 fsNative → PM public API / readPid+removePid+selfWritePid+selfRemovePid 4 API 公开 |
| **A.X-1 spawn 成功 audit 漏写**（r44 A 新发现）| stale drift | ✅ stale 闭环（r48 C1 phase356 / framing 100% 推翻）| ~~应然 spawn 成功 audit / 实然漏~~ → Path #1 实测：`manager.ts:461-467` 已有 `audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, claw=, pid=, command=, args=)` + L473-478 `PROCESS_SPAWN_FAILED` + `audit-events.ts:10` const 已注册 / 与 §A.3「已闭环 phase148 / 5 类事件全链」重复登记互斥 / r44 A audit fork 报告未实测引入 stale drift / dispatch table N+3 形态第 5 案 |
| ~~A.6 PM 工厂位置 cross-layer leak~~ | drift / 中 | **✅ closed（phase425 / main `4955b6fc`）** | 应然 = L2 ProcessManager 工厂应在 `src/foundation/process-manager/`。phase425 实施：git mv `src/cli/commands/process-manager-factory.ts` → `src/foundation/process-manager/agent-factory.ts`（保 history）+ 内部 4 import path 修（dir 深度 3→2 级）+ 5 caller files cascade（assemble + foundation/config/factories + cli/index×2 + daemon + 2 tests）/ 函数名 `createAgentProcessManager` 不动 / 实施过程额外消解 `foundation/config/factories.ts:29` 反向 import L6 CLI 严重 layer 违规（modules 文中只列 Assembly / Path #1 起草期捕获）/ 0 行为改 / 1370+ 测试 PASS |
| A.7 应然 method 名 `processName` ↔ 实然 `clawId` scope drift | naming/scope drift / 低 | open（phase414c L2a audit 登记 / 应然抽象层 vs 实然 caller universe）| 应然 PM 抽象 = 「进程生命周期编排」/ 参数名应为 `processName` (general)。实然 caller universe 限定 daemon (claw + motion) / 参数名 `clawId` align caller 实然 / arch 表 1 资源「进程注册表」silent on 命名 / 升档条件：未来出现非 claw 进程 caller (如 cron 子进程 / verifier 进程) → 实然必抽象为 processName / 当前可保留 `clawId` 命名 |
| A.8 应然幻象 method `list()` + `cleanupOrphans()` | spec drift / 低 | **closed**（phase414c L2a audit / interfaces/l2a.md 删 2 method 应然幻象）| 历史 interfaces 声明 `list(): Promise<ProcessInfo[]>` + `cleanupOrphans(): Promise<void>` / 实然从未实现 / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l2a.md 修订时删除 / 同型应然幻象 `ProcessHandle` / `ProcessInfo` / `LockHandle` / `StopSignal` / `ProcessManagerError` 全删 |
| A.invariant-1 PID 文件即权威 anchor | anchor | 防 drift（合规）| 应然立场登记：进程在 / PID 文件在 / 进程失活 / 下次 isAlive 自动清理 stale 文件 / 用作 reviewer 自检 |
| A.invariant-2 wx 排他写 anchor | anchor | 防 drift（合规）| 应然立场登记：`writeExclusiveSync('wx')` 保证同时只有一个 spawn 写入成功 / 不可改为「覆盖」语义 / 用作 reviewer 自检 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `findProcessesWarned: Set<string>` 无 TTL/清理策略 | 实例生命周期 = 进程生命周期 / 无泄漏风险 | 出现长生命周期实例（如 daemon 持续运行）|
| `openSync` / `closeSync` FS 抽象缺口 | Node spawn fd 语义必需 / 不可消除 | / |
| **接口冗余 `isAlive(clawId)` vs `getAliveStatus(clawId).alive`** | 同一概念两种接口形式 / 违 M#9「同一概念同一名字」| 收敛候选 / 删 isAlive 或保留双接口 |
| ~~`manager.ts` 单文件 625 行~~ | ~~M#7 边界~~ | **升 §A 必修**（design verify 真 deep 后升档 / r60+ Meta 33 候选）/ 6 类职责（alive / lifecycle / lockfile / pid / find / orphan）紧密耦合于单文件 / M#1 反向测试形式 ✓ 物理 ✗（改一类影响共享文件 + 18 audit events + findProcessesWarned 共享状态）/ 修复路径推 r51+ design phase：按职责 6 类拆 6 文件（process-manager/{alive,lifecycle,lockfile,pid,find,orphan}.ts）+ deps interface 注入 / 同 phase341 task-system 拆 4 子模块模板复用 / standalone function pattern |
| `getAliveStatus` 内 ESRCH 后旁路清理 try-catch 容许 | 非业务语义失败 / 下次 isAlive 重试兜底 | / |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：进程生命周期（PID / lockfile / spawn / stop / pgrep 查找）/ 与「子进程健康检查」（Watchdog）+「运行时事件循环」（Runtime）+「信号处理约定」（各 agent）独立可变
- **M2 业务语义归属**：PID 文件 + lockfile 的读写判活语义全在 ProcessManager / CLI 经公共 API 消费
- **M3 资源归属**：PID 文件 + daemon.lock 完整归 ProcessManager 独占（phase152 + phase228 闭环）
- **M4 持久化**：「运行时句柄磁盘持久化载体」/ 失活自动清理 stale 实现「持久化一切 + 中断可恢复」
- **M5 依赖单向**：ProcessManager → L1 ProcessExec + L1 FileSystem + L2 AuditLog（per arch §8 表 1）/ 0 反向 / 0 上引
- **M6 依赖结构稳定**：ProcessManager class + SpawnOptions interface 稳定 / phase148 audit 必传 / phase152 acquireLock / phase228 readPid public 都是 non-breaking 扩展
- **M7 耦合界面稳定**：灰度（B 类「isAlive vs getAliveStatus」+「manager.ts 单文件 592 行」边界）
- **M8 耦合界面最小**：ProcessManager ctor 4 参 / 公共方法 12 个（按 4 组：alive / lifecycle / lockfile / pid）/ SpawnOptions 5 字段
- **M9 显式表达编译器可检**：SpawnOptions interface 强类型 / 错误类（ProcessManagerError / AlreadyRunningError / StaleLockFileError）命名明确
- **M10 不合理停下**：失败路径 audit + 返回值 / 抛 Error 分层（13+ 失败场景）
- **M11 边界不对停下**：spawn 失败抛 / stop 返 boolean / findProcesses 失败返 [] + audit（A.2 歧义留 Phase 150）

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：phase148 闭环 / 15 audit 事件全链覆盖
- **D1b 状态可观察**：PID 文件即状态 / `getAliveStatus` 显式返 `{alive, reason, pid}` 三元组
- **D1c 中断可恢复**：**核心落实者**（PID + lockfile 磁盘持久化 + 运行时句柄重建）
- **D1d 事后可审计**：phase148 必传 audit + 15 事件全覆盖
- **D2 不得丢弃/静默**：A.1-A.3 闭环 / A.2 audit 通路补齐 / 失败语义二分 Phase 150 scope
- **D3 用户可观察**：audit 事件流 + CLI status 命令可查 PID / 活性
- **D5 日志重建**：audit 事件序列 + PID 文件时间戳 + lockfile 持有时间可重建进程生命周期
- **D7 系统可信路径**：PID 目录 + lockfile 目录约定在 WRITABLE_PATHS 内
- **D8 事件驱动**：audit 发事件 / ProcessManager 自身被动调用
- **D9 多 claw 不隔绝**：`<baseDir>/claws/<id>/status/pid` 路径归属 per-claw / findProcesses pgrep 跨 claw 查找
- **D10 motion 特殊**：`dirResolver` 可选参支持 Motion 非默认 PID 路径
- **D11 CLI 唯一对外**：CLI status / claw / motion / stop / start 消费 ProcessManager
- **D4 / D6**：无关（基础设施 / 不参与 LLM）

#### Philosophy（4 条）

- **P1 Agent 即目录**：PID 文件 + lockfile 是「Agent 即目录」原语的进程状态位
- **P2 上下文工程**：无关
- **P3 分多个智能体加分子任务**：单 ProcessManager 实例服务全部 claw / dirResolver 扩展点保留 motion 特殊性
- **P4 系统为智能体服务**：文件 lockfile（非内存锁）/ PID 文件（非 shared memory）/ pgrep 外部命令（非进程表解析）/ 简单优先 + 持久化为主

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告
- **Path #7 常量归属于承担其语义的模块**（phase225 细则）：phase233 实践（PROCESS_SPAWN_CONFIRM_MS 归 ProcessManager 而非 constants.ts 中立位）

### 7.D 历史纪律

详 phase148 / phase152 / phase195 / phase228 / phase233 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：A.1 + A.3 闭环（9 console → 9 audit / 5 进程生命周期事件）+ ctor audit 必传
- phase152：A.4 闭环（lockfile 资源归位 / acquireLock + releaseLock + readLockPid + getLockPath）
- phase195：契约 backfill / `manager.ts` 单文件 592 行结构性登记
- phase228：PID call sites bypass 闭环（PID public API / 7 call sites 切换 / 4 PID audit 事件 / SHA `b50fa53`）
- phase233：A.5 闭环（时间常量归属修复 / SHA `37d8bb1`）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2a.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#17 ProcessManager 独立于 Daemon（Daemon / CLI / Watchdog 三方共用基础设施）| ✓ |
| KD#22 ProcessManager 是库代码 / PID 策略唯一归属 / 自启动经 selfWritePid 接入（不直接操作 PID 文件字面量）| ✓（phase228 闭环）|
| KD（应然）时间常量归属于承担其语义的模块（Path #7）| ✓（phase233 闭环）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **PID 路径**：默认 PID 路径 / 自定义 dirResolver / Motion 走自定义 PID 路径
- **isAlive 路径**：活进程 / 死 stale 清理 / 非法 PID
- **stop 路径**：无 PID 静默 / stale 清理 / SIGTERM 升级 SIGKILL / 实际终止
- **spawn 路径**：wx 排他锁（活进程拒绝 / 错误含 clawId / 空 PID concurrent 警告）/ 轮询超时
- **findProcesses 路径**：pgrep 模式参数 / 孤儿 SIGTERM / pgrep 失败 vs 空结果区分（A.2 待 Phase 150）
- **lockfile 路径**：acquireLock / releaseLock / readLockPid / stale lockfile 清理
- **PID 公共 API**：readPid / removePid / selfWritePid / selfRemovePid（phase228）
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言
