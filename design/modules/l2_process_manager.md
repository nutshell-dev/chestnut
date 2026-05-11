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

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<baseDir>/claws/<id>/status/pid` | 每 claw PID 文件（独占）| ✓ wx 排他写 |
| `<baseDir>/claws/<id>/status/daemon.lock` | lockfile 独占启动锁 | ✓ |
| `findProcessesWarned: Set<string>` | 运行期 per-instance 去重 | ✗ 重启即丢 |

**PID 文件加 lockfile 读写** — clawforum 内部进程注册 + 排他启动锁必经 ProcessManager 间接访问 / 是「进程标识 + 排他启动」两类磁盘 artifact 唯一调用入口。

> 注：(1) Motion 走 `dirResolver` 自定义路径（典型 `<baseDir>/motion/status/`）/ (2) **时间常量对外导出** `PROCESS_SPAWN_CONFIRM_MS` / `DAEMON_SHUTDOWN_GRACE_MS`（type-level 资源 / CLI 等待 spawn 稳定时间 = 本模块内部轮询上限同源 / 引用常量而非字面量 / 实施细节归 §1.做）。

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
| A.5 时间常量跨层耦合（constants.ts 中立）| drift | 已闭环（phase233 / SHA `37d8bb1`）| PROCESS_SPAWN_CONFIRM_MS / DAEMON_SHUTDOWN_GRACE_MS 迁至 manager.ts export const / CLI 三文件改 import 来源 / constants.ts 删除对应条目 |
| PID call sites bypass | drift | 已闭环（phase228 / SHA `b50fa53`）| 7 call sites（daemon.ts 3 + claw.ts 1 + chat-viewport.ts 3）全切 fsNative → PM public API / readPid+removePid+selfWritePid+selfRemovePid 4 API 公开 |
| **A.X-1 spawn 成功 audit 漏写**（r44 A 新发现）| stale drift | ✅ stale 闭环（r48 C1 phase356 / framing 100% 推翻）| ~~应然 spawn 成功 audit / 实然漏~~ → Path #1 实测：`manager.ts:461-467` 已有 `audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, claw=, pid=, command=, args=)` + L473-478 `PROCESS_SPAWN_FAILED` + `audit-events.ts:10` const 已注册 / 与 §A.3「已闭环 phase148 / 5 类事件全链」重复登记互斥 / r44 A audit fork 报告未实测引入 stale drift / dispatch table N+3 形态第 5 案 |
| ~~A.6 PM 工厂位置 cross-layer leak~~ | drift / 中 | **✅ closed（phase425 / main `4955b6fc`）** | 应然 = L2 ProcessManager 工厂应在 `src/foundation/process-manager/`。phase425 实施：git mv `src/cli/commands/process-manager-factory.ts` → `src/foundation/process-manager/agent-factory.ts`（保 history）+ 内部 4 import path 修（dir 深度 3→2 级）+ 5 caller files cascade（assemble + foundation/config/factories + cli/index×2 + daemon + 2 tests）/ 函数名 `createAgentProcessManager` 不动 / 实施过程额外消解 `foundation/config/factories.ts:29` 反向 import L6 CLI 严重 layer 违规（modules 文中只列 Assembly / Path #1 起草期捕获）/ 0 行为改 / 1370+ 测试 PASS |
| A.7 应然 method 名 `processName` ↔ 实然 `clawId` scope drift | naming/scope drift / 低 | open（phase414c L2a audit 登记 / 应然抽象层 vs 实然 caller universe）| 应然 PM 抽象 = 「进程生命周期编排」/ 参数名应为 `processName` (general)。实然 caller universe 限定 daemon (claw + motion) / 参数名 `clawId` align caller 实然 / arch 表 1 资源「进程注册表」silent on 命名 / 升档条件：未来出现非 claw 进程 caller (如 cron 子进程 / verifier 进程) → 实然必抽象为 processName / 当前可保留 `clawId` 命名 |
| A.8 应然幻象 method `list()` + `cleanupOrphans()` | spec drift / 低 | **closed**（phase414c L2a audit / interfaces/l2a.md 删 2 method 应然幻象）| 历史 interfaces 声明 `list(): Promise<ProcessInfo[]>` + `cleanupOrphans(): Promise<void>` / 实然从未实现 / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l2a.md 修订时删除 / 同型应然幻象 `ProcessHandle` / `ProcessInfo` / `LockHandle` / `StopSignal` / `ProcessManagerError` 全删 |
| **A.bypass-1 ProcessManager 直 import `node:child_process` + `node:fs`** | M#5 弱违反 / 中 | **✅ closed**（phase439 / main `76ab0ff3`）| ProcessManager 4 处 OS 调用经 L1 ProcessExec：(1) L437 spawn → spawnDetached (2) L602 spawnSync('pgrep', ...) → pgrepSync (3) L434 openSync + L488 closeSync → spawnDetached 内部 encapsulate / 行为 0 改 / 同 phase434 bypass 治理模板 / Watchdog 部分推 phase 440+ |
| A.invariant-1 PID 文件即权威 anchor | anchor | 防 drift（合规）| 应然立场登记：进程在 / PID 文件在 / 进程失活 / 下次 isAlive 自动清理 stale 文件 / 用作 reviewer 自检 |
| A.invariant-2 wx 排他写 anchor | anchor | 防 drift（合规）| 应然立场登记：`writeExclusiveSync('wx')` 保证同时只有一个 spawn 写入成功 / 不可改为「覆盖」语义 / 用作 reviewer 自检 |
| **A.spawn-eexist-race-misclassify spawn EEXIST 路径 readSync silent catch 误归类 PID_EMPTY** | drift / 低 / r71 C fork phase 591 derive | **closed by phase 591**（main `1d5e0680` / merge `1036cd25`）| 实然 `spawn.ts:104` `try { existingContent = ctx.fs.readSync(pidFile).trim(); } catch {}` silent / EEXIST → isAliveByPidFile false → 进入 stale lockfile 清理路径 / **race scenario**：concurrent `removePid` 删 pidFile → readSync 抛 ENOENT → silent catch → existingContent='' → audit `PID_EMPTY`（误归类 / 实际是 race / 不是真 PID 空文件）/ 违 D2 不静默 + D5 audit 数据准确性。**phase 591 决策（28 原则核 5/5 一致 dominant 自决）**：α catch (err) → if ENOENT audit `PID_READ_FAILED context=race_check`（race 良性可观察）+ else audit `PID_READ_FAILED context=eexist_check + reason=...`（其他 IO 错）/ `PID_EMPTY` 仅 readSync 成功且内容真空时调用（保留真语义）/ **0 NEW const**（复用 `PID_READ_FAILED` + context= 子场景 align phase 541 模板 M#7+M#8 收益）/ β silent ENOENT 违 D2 reject / γ NEW const 违 M#7 reject |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `findProcessesWarned: Set<string>` 无 TTL/清理策略 | 实例生命周期 = 进程生命周期 / 无泄漏风险 | 出现长生命周期实例（如 daemon 持续运行）|
| `openSync` / `closeSync` FS 抽象缺口 | Node spawn fd 语义必需 / 不可消除 | **✅ closed**（phase439 / main `76ab0ff3`）| 迁 L1 ProcessExec.spawnDetached 内部 encapsulate / ProcessManager 0 直 import `node:fs` |
| **接口冗余 `isAlive(clawId)` vs `getAliveStatus(clawId).alive`** | 同一概念两种接口形式 / 违 M#9「同一概念同一名字」| 收敛候选 / 删 isAlive 或保留双接口 |
| ~~`manager.ts` 单文件 625 行~~ | ~~M#7 边界~~ | **✅ closed**（manager.ts 拆分实然完成 / 现 76 行 + 14 sub-file：alive / lock / pid / spawn / stop / find / paths / errors / agent-factory / audit-events / constants / types / index / phase 715 sub-A D2-P1.1 state lag fix / src 实然已拆 / row 状态此次同步 closed）| 6 类职责（alive / lifecycle / lockfile / pid / find / orphan）紧密耦合于单文件 / M#1 反向测试形式 ✓ 物理 ✗（改一类影响共享文件 + 18 audit events + findProcessesWarned 共享状态）/ 修复路径推 r51+ design phase：按职责 6 类拆 6 文件（process-manager/{alive,lifecycle,lockfile,pid,find,orphan}.ts）+ deps interface 注入 / 同 phase341 task-system 拆 4 子模块模板复用 / standalone function pattern |
| `getAliveStatus` 内 ESRCH 后旁路清理 try-catch 容许 | 非业务语义失败 / 下次 isAlive 重试兜底 | / |
| **L2a.G1 (process-manager)** ctor 不显式注入 ProcessExec | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2a.md ctor `(fs, baseDir, audit, dirResolver?)` / arch 表 1 PM row 依赖列「ProcessExec、FileSystem、AuditLog」/ spawn / pgrep 等通过模块内部直接调用 L1 ProcessExec（capability+direct 默认 ok）/ interfaces 未说明 ProcessExec direct 调用方式 / derive 链断 / 同 Snapshot L2a.G1 同型 | **业务决策性 / 用户拍板候选**：α interfaces ctor 注释加「ProcessExec direct 调用 / 不经 DI」/ β 改 ctor 显式注入 / γ 保留现状 |
| **L2a.G2 (process-manager)** `dirResolver?: (clawId: string) => string` caller-injected protocol arch 耦合列「无」未列 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2a.md ctor 暴露 `dirResolver?` optional 参数 / 同 Snapshot ignorePatterns caller-injected 模式 / arch 表 1 Snapshot row 耦合列显式列「gitignore patterns 通过参数注入（Assembly 装配期 own 与组装）」/ arch 表 1 PM row 耦合列「无」未对应列出 dirResolver 协议 / derive 链断 | **业务决策性 / 用户拍板候选**：α arch 表 1 PM row 耦合列加「dirResolver 协议（caller 注入 clawId → path 映射 / optional / 默认 PM 内置）」/ β interfaces 注释 dirResolver 是 optional caller hook + 默认行为说明 / γ 保留现状（dirResolver optional / 默认 OK 不需 sharpen）|
| **L2a.G3 (process-manager)** `clawId` 命名 caller universe 限定 arch 装配归属未声明 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2a.md 使用语义 line 187-188 自承认「PM 应然抽象层是「进程生命周期编排」/ 实然采纳 `clawId` 命名是因为 daemon 实然全是 claw daemon... caller universe 限定为 claw daemon」/ arch 表 1 PM row 装配归属「按需」中性 / 无 caller universe 限定声明 / interfaces 实然约束未在 arch derive 链体现 | **业务决策性 / 用户拍板候选**：α arch §ProcessManager 节加一句「实然 caller universe = claw daemon (含 motion)」/ β arch 表 1 PM row 装配归属「按需」改「motion+claw」（per arch line 42-43 装配归属维度表）/ γ interfaces 中性化「processId」rename（同应然抽象层）/ δ 保留现状（interfaces 自我 sharpen 已显式）|
| **L2a.G4 (process-manager)** 「孤儿清理」对外能力不暴露 public method | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：arch 表 2 PM row 「daemon spawn 编排、进程注册管理、存活监控、优雅停止、**孤儿清理**、排他锁」6 能力 / interfaces 公共 API 5 类（lifecycle / 判活 / PID / lockfile / find）/ 孤儿清理无专门 public method / 可能 startup 期内置自动 / 也可能未实现 / interfaces 未注明 | **业务决策性 / 用户拍板候选**：α interfaces 加注释「孤儿清理 = startup 期内置 / 不暴露 public method」+ 实测验证 / β 加 public method `cleanupOrphans()` 显式化 / γ arch 表 2 删「孤儿清理」（如实然不实施）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：进程生命周期（PID / lockfile / spawn / stop / pgrep 查找）/ 与「子进程健康检查」（Watchdog）+「运行时事件循环」（Runtime）+「信号处理约定」（各 agent）独立可变
- **M#2 业务语义归属**：PID 文件 + lockfile 的读写判活语义全在 ProcessManager / CLI 经公共 API 消费
- **M#3 资源归属**：PID 文件 + daemon.lock 完整归 ProcessManager 独占（phase152 + phase228 闭环）
- **M#4 持久化**：「运行时句柄磁盘持久化载体」/ 失活自动清理 stale 实现「持久化一切 + 中断可恢复」
- **M#5 依赖单向**：ProcessManager → L1 ProcessExec + L1 FileSystem + L2 AuditLog（per arch §8 表 1）/ 0 反向 / 0 上引
- **M#6 依赖结构稳定**：ProcessManager class + SpawnOptions interface 稳定 / phase148 audit 必传 / phase152 acquireLock / phase228 readPid public 都是 non-breaking 扩展
- **M#7 耦合界面稳定**：灰度（B 类「isAlive vs getAliveStatus」+「manager.ts 单文件 592 行」边界）
- **M#8 耦合界面最小**：ProcessManager ctor 4 参 / 公共方法 12 个（按 4 组：alive / lifecycle / lockfile / pid）/ SpawnOptions 5 字段
- **M#9 显式表达编译器可检**：SpawnOptions interface 强类型 / 错误类（ProcessManagerError / AlreadyRunningError / StaleLockFileError）命名明确
- **M#10 不合理停下**：失败路径 audit + 返回值 / 抛 Error 分层（13+ 失败场景）
- **M#11 边界不对停下**：spawn 失败抛 / stop 返 boolean / findProcesses 失败返 [] + audit（A.2 歧义留 Phase 150）

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
- **D9 CLI 唯一外部入口**：CLI status / claw / motion / stop / start 消费 ProcessManager
- **D10 多 claw 不隔绝**：`<baseDir>/claws/<id>/status/pid` 路径归属 per-claw / findProcesses pgrep 跨 claw 查找
- **D11 motion 特殊**：`dirResolver` 可选参支持 Motion 非默认 PID 路径
- **D4 / D6**：无关（基础设施 / 不参与 LLM）

#### Philosophy（4 条）

- **P1 Agent 即目录**：PID 文件 + lockfile 是「Agent 即目录」原语的进程状态位
- **P2 上下文工程**：无关
- **P3 分多个智能体加分子任务**：单 ProcessManager 实例服务全部 claw / dirResolver 扩展点保留 motion 特殊性
- **P4 系统为智能体服务**：文件 lockfile（非内存锁）/ PID 文件（非 shared memory）/ pgrep 外部命令（非进程表解析）/ 简单优先 + 持久化为主

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

> 注：phase225 细则「常量归属于承担其语义的模块」是 M#3 资源唯一归属的派生实施细则（phase233 实践 PROCESS_SPAWN_CONFIRM_MS / DAEMON_SHUTDOWN_GRACE_MS 归 ProcessManager 而非 constants.ts 中立位）/ 不是 canonical Path Principles 之一 / 该实施细则归 §7.E KD 模板。

### 7.D 历史纪律

详 phase148 / phase152 / phase195 / phase228 / phase233 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：A.1 + A.3 闭环（9 console → 9 audit / 5 进程生命周期事件）+ ctor audit 必传
- phase152：A.4 闭环（lockfile 资源归位 / acquireLock + releaseLock + readLockPid + getLockPath）
- phase195：契约 backfill / `manager.ts` 单文件 592 行结构性登记
- phase228：PID call sites bypass 闭环（PID public API / 7 call sites 切换 / 4 PID audit 事件 / SHA `b50fa53`）
- phase233：A.5 闭环（时间常量归属修复 / SHA `37d8bb1`）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2a.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / Design Principles D9-D11 三处 verbatim 编号修正 align principles.md / §3 资源改 table 「PID + lockfile + findProcessesWarned」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim 已正确）
- 2026-04-28 / phase356 A.X-1 stale drift 闭环 / r48 C1 framing 100% 推翻：实然 manager.ts:461-467 已有 PROCESS_SPAWNED audit + L473-478 PROCESS_SPAWN_FAILED + audit-events.ts:10 const 已注册 / 与 §A.3「已闭环 phase148 / 5 类事件全链」重复登记互斥 / r44 A audit fork 报告未实测引入 stale drift / **dispatch table N+3 形态第 5 案**
- 2026-05-03 / phase 414c interfaces L2a audit（A.8 + spec align closed）：interfaces/l2a.md 删 `list()` + `cleanupOrphans()` 2 method 应然幻象 + ProcessHandle/ProcessInfo/LockHandle/StopSignal/ProcessManagerError 5 type 应然幻象全删
- 2026-05-04 / phase425 PM 工厂 cross-layer leak 闭环（main `4955b6fc`）/ A.6 closed / git mv `src/cli/commands/process-manager-factory.ts` → `src/foundation/process-manager/agent-factory.ts` + 内部 4 import path 修 + 5 caller files cascade（assemble + foundation/config/factories + cli/index×2 + daemon + 2 tests）/ 实施过程额外消解 `foundation/config/factories.ts:29` 反向 import L6 CLI 严重 layer 违规（modules 文中只列 Assembly / Path #1 起草期捕获）/ 0 行为改
- 2026-05-04 / phase439 bypass cluster 闭环（main `76ab0ff3`）/ A.bypass-1 closed / ProcessManager 4 处 OS 调用经 L1 ProcessExec：(1) L437 spawn → spawnDetached (2) L602 spawnSync('pgrep') → pgrepSync (3) L434 openSync + L488 closeSync → spawnDetached 内部 encapsulate / 同 phase434 bypass 治理模板
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_process_manager.md vs arch §8 + 表 1/2 + interfaces/l2a.md ProcessManager 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle **D1c 核心落实者** + D1a/D1b/D1d/D2/D3/D5/D7/D8/D9/D10/D11 + D4/D6 无关 + Philosophy P1+P3+P4 + Path #1-#7）/ 6 主能力 align arch 表 2（daemon spawn 编排 + 进程注册管理 + 存活监控 + 优雅停止 + 孤儿清理 + 排他锁）/ 3 dep + 3 caller align arch 表 1 / 资源 PID+lockfile align arch 表 1 / 补 phase356+414c+425+439 closure timeline entry / L2a.G1 (PM ctor 不显式注入 ProcessExec) + L2a.G2 (dirResolver caller hook arch 耦合列「无」未列) + L2a.G3 (clawId 命名 caller universe 限定 arch 装配归属未声明) + L2a.G4 (孤儿清理对外能力不暴露 public method) 4 项 design-gap 已登记 §B（业务决策性 α/β/γ/δ 候选）/ design only / 0 src 改
- 2026-05-05 / phase 497 模块内重构（A 激进式 backend split N=2 实证 / main `57e34a45`）：manager.ts 574 → 76 行 thin orchestrator（净 -498 / 净瘦 87%）+ 8 NEW sub-file（types.ts 38 + constants.ts 3 + paths.ts 19 + pid.ts 63 + alive.ts 40 + lock.ts 94 + spawn.ts 158 + stop.ts 69 + find.ts 22 / 总 506 行 NEW）/ ProcessManager class facade 0 改（12 thin delegate / 9 public method 签名 0 改）/ ProcessManagerContext { fs, audit, resolveDir } 注入模板（同 phase 480 contract context 注入）/ caller cascade 0（class facade + LockConflictError/SpawnOptions/constants re-export 保 import path / 19 src caller + 9 tests caller 全 0 改）/ 0 行为差 / 1403 tests PASS / 10 files +559 -551 / 拓扑严格单向：types+constants ← paths ← pid+alive+lock+find ← spawn+stop ← manager / 0 import 循环 / **「模块内重构形态分类」A.1 backend split N=2 实证达**（phase 480 contract + phase 497 PM / A 子分类首发完整 / 推 r+ Meta 升格扩 feedback_module_internal_refactor_taxonomy）/ rename 局部：spawn.ts:spawnProcess（避 child_process.spawn 名冲突）+ alive.ts:isAliveByPidFile（避 L1.isAlive 名冲突）+ stop.ts:stopProcess（避歧义）/ thin delegate 维持 public 名（spawn / isAlive / stop）
- 2026-05-09 / **phase 578 silent → audit cluster C（B fork r69）**（main `d3466037`）/ spawn.ts:111 `removePid(...).catch(() => {})` silent → `.catch((err) => audit.write(PID_REMOVE_FAILED, claw, context=spawn_retry_overwrite, reason))` 保 best-effort + 加 observability / 既有 `PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED` const 复用 / 0 NEW const / **0 NEW audit const cluster 治理首发**（既有 19 const 全复用 / vs phase 564 NEW 2 const 对比）/ Path #1 实证 dispatch claim 4/4 真（**反命题 N=3 实证累** / 557 4/4 + 564 5/5 + 578 4/4）/ silent X cluster N+1 实证累 / cross-cutting 同 phase：l6_cli §A stop.ts:73+76 双 catch 同 closed（stop.ts 内自构 motion-level audit α 模板复用 / N=6 累）
- 2026-05-09 / phase 579 daemon shutdown grace const 命名 sharpen（`SIGTERM_GRACE_MS` → `DAEMON_SHUTDOWN_GRACE_MS` / 0 行为差 / M#1 独立可变 / F fork r69）

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

## phase 684 — Sub-B fan-out spawn race acceptable design row

### B-P2.8 spawn.ts pidFile 写空字符串占位 race

- **claim**：`writeExclusiveSync(pidFile, '')` 占位 → 实际 pid 写入之间 readPid 返 NaN → null → 视未启动 → 又 spawn race
- **状态**：C2 部分 acceptable / `PID_EMPTY` audit 已暴露 race symptom
- **结论**：race window 真存在 / 但已 audit 暴露（设计自觉）/ 0 用户可见 bug 已超 1 r 验证 / 业务决策保留 race acceptable
- **不修原因**：`writeExclusiveSync` `wx` flag 已防双写 / EEXIST 路径走 isAliveByPidFile / audit 暴露后可观测

## phase 695 — r93 E fork V4-P2.1 hardcoded PID 6 file cluster 业务决策 row

### V4-P2.1 6 file（process_manager / contract_manager / contract-concurrency / contract/lock / process-exec / process）

- **claim**：6 file 用 hardcoded `999999` / `99999999` / `999999999` 假设进程不存在 / Linux `pid_max=4194304` 可能撞 / Windows `process.kill` 语义差
- **业务决策**：新建 `tests/helpers/dead-pid.ts` 基础设施 vs 保现状
- **选项**：
  - α：新建 `dead-pid.ts` helper（probe + reserve 真 dead pid）+ 6 file 迁移
  - β：保现状（撞概率极低 / 0 已知 CI flake）
  - γ：统一选 `999999999`（最大已用 / Linux pid_max=4194304 永不撞）+ 不抽 helper
- **28 原则核**：
  - 测试稳定性 / cross-platform → α
  - YAGNI（0 已知 flake）→ β
  - DRY + 简约 → γ（统一常量足够）
- **主会话预期**：γ 统一常量 999999999（轻量 / 不投资 helper）
- **决策状态**：**closed by phase 705**

## §A.dead-pid-helper-cluster — closed by phase 705

- **claim**：9 site 跨 6 test file 用 hardcoded 999999/99999999/999999999 假设 dead PID / 3 magic variant 散落 / 999999 < Linux pid_max=4194304 ⚠️ 理论可撞（macOS pid_max=99999 默认 / Windows 通常 < 100,000）
- **resolution**：`tests/helpers/dead-pid.ts` 新立 / `DEAD_PID = 999999999`（> Linux pid_max 238 × / > macOS pid_max 10,000 ×）+ `DEAD_PID_STRING` / 9 site 替换 / 0 magic 散落 / 命名 inconsistency `fakePid` 推 r96+
- **28 原则 derive**：α 6/6 dominant（DP「状态可观察」+ DP「事后日志可重建」+ ML「不可消除耦合显式表达」+ M#1 业务唯一 + YAGNI + D2 不静默）/ β runtime probe 路径 1/6 / 无需 user binary 拍板
- **副发现登记**：「dispatch 起草自审 §3.a 内部一致性」N+1 实证（dispatch 标「999999 跨 6 file」起草时未全 grep / 实测后 3 variant / 推 r96+ 升格独立子节 N=3 累过线）
- **resolution commit**：phase 705 Step E + F + G
