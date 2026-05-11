# ProcessExec 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) ProcessExec 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §2「ProcessExec 本质：进程能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），ProcessExec 的单一职责 = **OS 进程能力的原语暴露加跨平台抹平**：

- **OS 进程原语暴露**：OS 提供什么进程能力，本模块暴露什么 — 不阉割也不增添。具体能力含同步执行加 detached spawn 加发信号加存活查询加进程查找等，由 OS（POSIX / Windows）决定。
- **detached spawn + process find**：phase439 新增 `spawnDetached`（封装 child_process.spawn + log fd open/close）加 `pgrepSync`（封装 child_process.spawnSync('pgrep')），补全 L1 OS 进程能力全集。
- **跨 OS 平台抹平**：吸收 POSIX 加 Windows 进程模型异构 — 调用方写一套代码跨 OS 跑（derive 自 Design Principle「分布式部署加跨 OS 平台」）。中性 signal 名（'TERM' / 'KILL' / 'INT'）+ POSIX 直传 + Windows 等价映射是抹平产物。
- **统一错误结构**：所有失败包成结构化错误（pid / signal / stdout / stderr / exitCode 等），让 caller 不感知 OS 异构错误形态（M#7 耦合界面稳定 derive）。

> 具体 API 形态归 [interfaces/l1.md](../interfaces/l1.md) ProcessExec 节。具体 method 实例（exec / spawnDetached / kill / isAlive / findByPattern）的存在依据是「OS 提供该原语」— 实然采纳的 method 集合差异加防御性约束（timeout clamp / cwd 必填 / PATH 注入）登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / daemon / watchdog 等业务概念）— derive 自 M#2 业务语义归属（ProcessExec 业务语义仅 OS 级）加 M#5 单向依赖
- **不 own 进程业务编排**（PID 文件管理加孤儿清理加重启策略归 L2 ProcessManager）— derive 自 M#1 独立可变职责
- **不 own agent 工具暴露**（exec 工具暴露给 agent 是独立可变职责 / 归 L2 CommandTool）— derive 自 M#1
- **不 own 命令权限策略**（黑白名单加准入控制是业务上层语义 / 归 L2 CommandTool 装配期）— derive 自 M#5 不预设上层
- **不 own audit**（cross-cutting / 归各调用方自治）— derive 自 M#1
- **不 own shell 兼容层**（`sh -c` 跨 OS 不一致 / 调用方自负风险 / 强制 cmd + args[] 形态）— derive 自 M#1 + D7 系统可信路径
- **不 own 进程池加并发控制**（消费者侧业务策略 / 每次调用独立 spawn）— derive 自 M#1
- **不 own 输出流式回传**（流式诉求归工具层实现）— derive 自 M#1
- **不 own 交互式 TTY**（消费者侧业务）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），ProcessExec 的业务语义边界：

- **own**：OS 级进程概念 — 命令字符串加 PID 加信号加 cwd 加 stdout/stderr/exitCode 等。这些是 ProcessExec 唯一懂的「业务」（OS 抽象层级，不是 clawforum 业务层级）。
- **角色定位**：ProcessExec 是「**OS 进程访问通道**」非「**进程编排器**」。仅提供进程能力调用机制，不持进程跟踪状态加生命周期决策（归 L2 ProcessManager）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），ProcessExec 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| OS 进程能力访问（M#5 业务模块不允许直接 import `node:child_process`）| 概念性 / 唯一入口 | — |

**ProcessExec 是 clawforum 对 OS 进程能力的唯一调用入口** — 每次调用独立 spawn / 无连接池 / 无进程跟踪 / 不持运行期状态。

> 注：timeout 边界常量 `PROCESS_EXEC_TIMEOUT_MIN_MS` / `PROCESS_EXEC_TIMEOUT_MAX_MS` / `PROCESS_EXEC_DEFAULT_TIMEOUT_MS` 对外导出（type-level / 调用方引用常量而非字面量 / M#9 编译期可检 / 实施细节归 §1.做）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），ProcessExec 自身的持久化立场：

- **模块零状态**：ProcessExec 不持自有磁盘 artifact 加运行时状态 — 是无状态服务。
- **重建语义**：进程重启时模块无状态需要恢复 / 调用方下次调用即得新进程。
- **子进程生命周期**：detached spawn 后子进程独立存活 / ProcessExec 不跟踪 / PID 文件加生命周期跟踪归 L2 ProcessManager。

## 5. 审计事件清单

**ProcessExec 不产生任何 audit 事件**（应然 / cross-cutting 业务归 caller / 跟 FileWatcher / FileSystem 同 L1 干净 pattern）。

调用方在自有命名空间审计进程 OS 操作（如 ProcessManager 的 `PROCESS_*` / Snapshot 的 `SNAPSHOT_*` 等）。

## 6. 层级声明

L1 OS / external 抽象层 / 进程 OS 能力跨 OS 抽象。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~**A.1 接口缺 4 方法（spawnDetached / kill / isAlive / findByPattern）**~~ | ~~drift / 高~~ | **✅ closed**（phase439 spawnDetached + phase495 kill+isAlive+findByPattern / main `00a765e6`）| ~~`spawnDetached` + `pgrepSync` 已落地~~ → phase 495 实施：NEW `process-control.ts`（kill + isAlive + Signal）+ NEW `find-by-pattern.ts`（替 pgrepSync / 返 ProcessInfo[]）+ pgrepSync export deprecate / 16 caller cascade（process.kill SIGTERM/SIGKILL → kill 'TERM'/'KILL' x7 + process.kill(pid, 0) → isAlive(pid) x8 + pgrepSync → findByPattern.map(.pid) x1）/ 0 行为差。**β reframe sync**（G8 phase 495 / phase 439 etched async 实测核反向 over-engineering / 16 caller 全 sync 上下文 / interfaces/l1.md sync 签名 reframe 修订 / **同 phase 488 G8 reframe 模板第 3 实证 / 必硬化升格独立 feedback**）。**18 原则全 align**：M#1 OS 原语 only + M#3 OS 进程能力唯一入口 + M#5 单向 + M#7 稳定 + M#8 最小 + M#9 Signal type union + D2 不静吞（ESRCH 显式 silent / 其他抛 ProcessExecError）+ D7 防误传 + Path #1 实测核反 over-engineering + Path #7 总难度。|
| ~~**A.2 实然双入口含 shell mode leak**~~ | ~~drift / 中~~ | **✅ closed**（phase 482 / main `1d3e7a77`）| ~~应然单一 `exec(cmd, args[], opts)` 形态 / 实然 `exec(string)` 走 `sh -c` + `execFile(cmd, args)`~~ → phase 482 实施：删整 `exec(command: string)` sh -c 包装函数 + execFile rename → exec / 单 signature `exec(cmd, args[], opts)` / caller cascade 7 文件（snapshot.ts wrapper 内删 cmd join 直传 args[] / contract/manager.ts execFile rename + dead exec import 顺手清 / command-tool execFile rename / tests/foundation/process-exec.test.ts rename）/ 0 行为差。**phase 号 race 顺延**（原 phase 479 plan 标 phase 480 / phase 480 race 输给另一 thread ContractSystem 拆分 / 顺延 phase 482 / `feedback_phase_number_atomic_claim §态 ③` 第 5 实证）。**5 原则 align**：M#1 独立职责 + M#7 稳定 + M#8 最小 + M#9 编译期检查 + D7 可信路径 + Philosophy 基础设施。|
| ~~A.3 CommandTool L2 应然新模块物理不存在 / exec 工具暂栖 Tools L2 builtins~~ ✅ closed | structural drift / 中 | **✅ closed**（phase378 / main `14c7767` / cross-ref l2_command_tool §A.1）| 应然 L1 ProcessExec 不 own agent 工具导出 / 工具归 CommandTool L2（应然新增模块 / 见 `design/modules/l2_command_tool.md` §1）/ ~~实然导出 `exec` agent 工具（依赖 Tools 协议类型 / cross-layer-up 候选 / L1 反向依赖 L2 Tools 协议 / 违反 M5 单向依赖）~~ — phase374 Path #1 实测推翻：L1 模块本身合规（`src/foundation/process-exec/index.ts` 0 agent 工具导出 / `src/foundation/process-exec/exec.ts` 0 Tools 协议依赖 / 仅 import child_process + util + path + 同模块 types）/ exec agent 工具暂栖身 `src/core/tools/builtins/exec.ts`（L2 / 单向依赖 L1 ✓）/ drift 实位 = CommandTool L2 应然新模块物理未落地 / **同根 → l2_command_tool §A.1** / 治理路径权威单源 → l2_command_tool §A.1（6 步） / 落地后本 §A.3 自动闭环 |
| ~~**A.4 shell mode 暴露**~~ | ~~drift / 中~~ | **✅ closed**（phase 482 / 同 A.2 同根 phase）| ~~应然不暴露 shell mode / 实然 `exec(string)` 走 `sh -c` 直接暴露 / Snapshot / ContractSystem 等 caller 利用之走管道 + 重定向 + 变量展开~~ → phase 482 同 A.2 phase 治 / 删 exec(string) 入口 / sh -c 隐式 leak 消除。**caller 显式 sh 自负合规模式保**：contract/manager.ts:1185 `exec('sh', [resolved], ...)` + command-tool/exec.ts:56 `exec('sh', ['-c', cmd], ...)` / agent-facing 仍 string schema 但工具实施层显式 sh 包装 / align 应然 §10「caller 显式 sh 自负跨 OS 风险」/ 不在治理 scope。|
| ~~**A.5 exec kill 无 SIGKILL escalation + env 全继承 + error/close race**~~ | ~~drift / 高~~ | **✅ closed**（phase 535 / main `2686732d`）| exec.ts timeout/maxBuffer `proc.kill()` 仅 SIGTERM / trap SIGTERM 子进程永不结 / Promise 永不 settle → SIGTERM grace 1s → SIGKILL escalation + settled guard / ExecOptions 无 env field → 全继承 process.env 含 secret → +`env?: Record<string, string>` / error handler 无 settled guard → 二重 reject / 3 site 修 + 3 NEW test / 0 行为差（默认路径全等价）/ **align §7.B PATH 注入候选方案落地** |
| 历史 console / audit 维度 | 干净 | 合规 | phase187 实测：3 文件 197 行 / 0 console.* / 0 audit 直写 / 所有失败经 ProcessExecError 结构化抛出 / "最干净 L1" 评级 |

#### A.1-A.4 治理路径（Stage 2）

1. **接口扩 5 方法**：内部按 OS 分支实现（POSIX child_process + signals + pgrep / Windows TerminateProcess + tasklist 等）
2. **shell mode 收口**：移除 `exec(string)` 入口 / `execFile` 改名 `exec(cmd, args[], opts)`
3. **agent 工具搬走（A.3）**：与 l2_command_tool §A.1 同根 / 治理路径权威单源 = `design/modules/l2_command_tool.md` §A.1 6 步（物理迁 `src/core/tools/builtins/exec.ts` → `src/core/command-tool/exec.ts` + `createCommandTools` 工厂 + Assembly 改装配点 + schema 修 + modules.md 同步 + profiles 缩窄）/ 落地后本 §A.3 自动闭环 / **不在本契约重复登记 6 步**（单源原则 / phase374 cross-ref 加强）
4. **caller 切换**：推动 ProcessManager / Watchdog / Snapshot / ContractSystem 等 caller 切到新接口（同时消除其直 `import 'child_process'` 行为）

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `MAX_BUFFER` 1MB 未导出 / 不可配置 | 内部策略 | 调用方（如 Snapshot 处理大 diff）需要更大缓冲时评估改 `ExecOptions.maxBuffer?` 或走临时文件方案 |
| `sh` 硬编码（POSIX-only）/ 无 Windows 支持 | 与 Transport 选 UDS 同型决策 / 契约不声明 Windows 支持 | Stage 2 跨 OS 抽象启动（A.1 治理时同步）|
| **PATH 注入是上层部署假设下沉 L1 的 kludge** | 当前保留现状以避免大范围改动 | ✅ **env field 已落地**（phase 535 / caller 可传 options.env scrub secret / 默认行为不变）/ 部署模型变化时进一步评估 Daemon 装配期统一准备 |
| timeout clamp 静默改写调用方意图 | 显式设计决策 / 防误传 0 + 防超大值 / 不抛 / 不 warn | 出现 clamp 改写导致行为困惑案例 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：进程 OS 原语统一封装 / 与「agent 工具导出」「audit 落盘」独立可变（~~应然违反点 → A.3 / 实然 leak~~ ✅ closed by phase378 / phase374 Path #1 实测推翻 / L1 模块本身 0 export agent 工具 / drift 实位是 CommandTool L2 模块物理未落地 / 同根 → l2_command_tool §A.1 闭环 / 详 §7.A A.3）
- **M#2 业务语义归属**：spawn / exec / kill / isAlive / findByPattern 由本模块直发起 / 跨 OS 实现分支吸收 OS 差异
- **M#3 资源归属**：无关（进程是操作系统资源 / 无跨模块资源竞争）
- **M#4 持久化**：无关
- **M#5 依赖单向**：process-exec → child_process + types/errors / 0 反向（~~应然违反点 → A.3 实然 export agent 工具反向依赖 Tools L3~~ ✅ closed by phase378 / phase374 Path #1 实测推翻 framing / L1 模块 0 export agent 工具 / 实然 0 反向 / 详 §7.A A.3）
- **M#6 依赖结构稳定**：构造期无参数 / 函数式入口 / 自 phase146 稳定
- **M#7 耦合界面稳定**：5 方法 + ProcessExecError 类
- **M#8 耦合界面最小**：ExecOptions 4 字段精选（cwd / env / timeout / signal）
- **M#9 显式表达编译器可检**：`ProcessExecError` 命名 class 携带 exitCode / signal / output（phase 483 后 stdout+stderr 时序合并 → output 单字段）
- **M#10-M#11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：ProcessExecError 携带 output（stdout+stderr 时序合并）+ exitCode + signal 全量（phase 483 字段精简 / 时序合并保留 / D5「信息不丢失」derive）
- **D1b 状态可观察**：失败时返回的 result 完整
- **D1c 中断可恢复**：AbortSignal 统一支持
- **D1d 事后可审计**：caller bridge / 基础设施本身不自审计
- **D2 不得丢弃/静默**：timeout clamp 静默改写已登记 §7.B / 当前合规偏差
- **D3 用户可观察**：同 D1b
- **D5 日志重建**：合规
- **D6b 子代理不阻塞**：AbortSignal 支持
- **D7 系统可信路径**：cmd + args[] 形态防 shell 注入（~~应然 / 实然 leak A.4~~ ✅ closed by phase 482 / shell mode 收口 / 删 exec(string) sh -c 包装 / 单 signature exec(cmd, args[], opts) / caller 显式 sh 自负合规模式保 / 详 §7.A A.2+A.4）
- **D4 / D6a / D8-D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：无关（进程执行原语 / 不直接消费目录形态）
- **P2 上下文工程**：无关
- **P3 分多个智能体加分子任务**：单一代码基
- **P4 系统为智能体服务**：基础设施 / 不参与决策

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase187 各 phase 收尾报告。

关键里程碑：
- phase187 L1 ProcessExec 契约 backfill / §7.A 0 条（最干净 L1）/ phase187 实测：0 console / 0 audit / 0 软吞
- r31 架构 sharpen：应然修订 L1 OS 抽象 only / 不 own agent 工具 / 不 own audit / 不暴露 shell mode / 接口扩为 5 方法
- r44 A：契约结构升 9 节模板 / A.1-A.4 应然 leak 显式登记 / Stage 2 治理路径定义
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l1.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table 「OS 进程能力访问」+ 注脚 align 其他模块）
- 2026-05-05 / phase 479 design phase（Cluster A exec 通道 / G1 锁定 execFile rename → exec / §A.2+§A.4 closed-design 推 phase 480 / 5 原则全 align M#1+M#7+M#8+M#9+D7+Philosophy）
- 2026-05-05 / phase 482 L1 exec 双入口合并落地（main `1d3e7a77` / G1 phase 479 锁定 / execFile rename → exec / 删 exec(string) sh -c 包装 / caller cascade 7 文件 ~25 行 / 0 行为差 / **phase 号 race 顺延 phase 480→482**（race 实证 5 累 / 模板深度成熟极致）/ Cluster A r+1 第 2 phase 落地（4/4 拆完 2/4））
- 2026-05-05 / phase 483 spawn 重写（main `9edb895c` / G3 phase 479 锁定 / runProcess 改 child_process.spawn 替 execFileAsync / 双 stream 'data' event 同 callback 推单 buffers / Buffer.concat utf-8 decode / **时序合并保留**（NEW 测试 verify）/ ExecResult schema stdout+stderr → output 单字段 breaking change / ProcessExecError 同改 / 行为差仅时序合并（实际改进 'nothing to commit' git stdout match 隐 bug））
- 2026-05-05 / phase 485 ExecContext +syncDir 装配协议立（main `9b703d7e` / Cluster A r+1 收官 4/4 / phase 481+482+483+485 / 不直接涉 process-exec 但 cluster milestone / r53+ §10 应然完整落地）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l1_process_exec.md vs arch §2 + 表 1/2 + interfaces/l1.md ProcessExec 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D6b/D7 + D4/D6a/D8-D11 无关 + Philosophy P3+P4 + Path #1-#7）/ 5 主能力 align arch 表 2 / 0 dep + 4 caller align arch 表 1 / 资源「无」align arch 表 1 / 修 §7.C M#1+M#5+D7 三处 stale claim「应然违反点 → A.3/A.4」（phase374+378+421+433 + phase 482 已闭环 / 实然 0 leak）/ phase187 最干净 L1 + phase439 spawnDetached + phase 482 双入口合并（race 实证 5 累 / **模板深度成熟极致**）+ phase 483 spawn 重写时序合并 + phase 485 ExecContext +syncDir Cluster A 收官多里程碑稳态保留 / A.1 partial closed（余 kill+isAlive+findByPattern 推 r+1）/ design only / 0 src 改
- 2026-05-05 / r65 重核补 §7.C M#9 + D1a + §8 测试 3 处 stale 同步（phase 483 ExecResult/ProcessExecError stdout+stderr → output 单字段时序合并 / interfaces 已修 / modules 跟进）
- 2026-05-05 / phase 494 master design phase（design only / G1-G7 全锁 0 待用户拍板 / 18 原则推力 align verify / r+1 拆 phase 495 单 code phase）
- 2026-05-05 / phase 495 §A.1 余 3 method 全清落地（main `00a765e6` / NEW process-control.ts kill+isAlive+Signal + NEW find-by-pattern.ts 替 pgrepSync / pgrepSync export deprecate / 16 caller cascade（process.kill SIGTERM/SIGKILL → kill 'TERM'/'KILL' x7 + process.kill(pid, 0) → isAlive(pid) x8 + pgrepSync → findByPattern.map(.pid) x1）/ 0 行为差 / 13 文件 +204 -117 / **§A.1 partial → ✅ closed / KD 应然 partial → ✅ closed**）/ **β reframe sync 落地**（G8 phase 495 / phase 439 etched async 实测核反向 over-engineering / interfaces/l1.md sync 签名 reframe / **phase 488 G8 reframe over-engineering 模板第 3 实证 / 必硬化升格独立 feedback**）/ **L1 ProcessExec §A 全清里程碑**（A.1 → A.4 全 closed / 余 §B 偏差 3 项 + 跨 OS Stage 2 单独 phase）
- 2026-05-08 / phase 535 exec kill SIGKILL escalation + env scrub + settled guard（main `2686732d` / §A.5 closed / timeout+maxBuffer SIGTERM→SIGKILL grace 1s / ExecOptions +env field / error handler settled guard / 3 NEW test / 0 行为差 / §7.B PATH 注入候选方案落地）
- 2026-05-09 / phase 579 SIGKILL grace const 命名 sharpen（`GRACE_PERIOD_MS` → `EXEC_SIGKILL_GRACE_MS` / 0 行为差 / M#1 独立可变 / F fork r69）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（应然）ProcessExec L1 OS 抽象 only / 不 own agent 工具 + 不 own audit + 不暴露 shell mode | ✅ **closed**：A.2 双入口 + A.4 shell mode 暴露 ✅ closed（phase 482 / main `1d3e7a77`）+ A.3 工具 leak ✅ closed（phase378 + phase421 + phase433）+ **A.1 接口缺 3 方法 ✅ closed（phase 495 / main `00a765e6` / kill+isAlive+findByPattern NEW + pgrepSync deprecate / 16 caller cascade / β reframe sync）** |
| KD（应然）跨 OS 抽象（POSIX vs Windows）由本模块内部分支吸收 | ⚠ 实然 POSIX-only（与 Transport UDS 同型决策）|
| KD（应然）`CommandTool` L2 新增模块（应然 / 接管 exec agent 工具）| ✅ **closed by phase378+phase421+phase433**：phase378 物理立 `src/core/command-tool/`（rename ShellTool→CommandTool 反向 / r62 D 落地）+ phase421 同型 cross-doc rename 闭环 + phase433 cross-layer 迁 `src/foundation/command-tool/` / interfaces/l2c.md + modules/l2_command_tool.md 全 align / 同根 drift §A.3 一并 closed |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **`exec` 成功路径**：standard 命令 + output 正常返回（phase 483 后 stdout+stderr 时序合并单字段）
- **非零 exit**：抛 `ProcessExecError` + 携带 output（时序合并）
- **超时**：`killed=true` + message
- **AbortSignal 取消**：abort → kill 子进程 + ProcessExecError
- **maxBuffer 超限**：`maxBufferExceeded=true` + 截断前输出
- **spawn 失败**：命令不存在 + cwd 不存在
- **timeout clamp**：`< MIN` 或 `> MAX` 被夹到边界 + 不抛错
- **PATH 注入**：能发现 npx / tsx 等 Node 工具
- **spawnDetached**（phase439 已补 / pgrepSync deprecated by phase 495）
- **kill**（phase 495 已补 / ESRCH silent ignore + 'TERM'/'KILL'/'INT' 信号映射 + 非 ESRCH 错抛 ProcessExecError）
- **isAlive**（phase 495 已补 / 自 pid 返 true + 不存在 pid 返 false + EPERM 仍返 true）
- **findByPattern**（phase 495 已补 / 0 match 返空数组 + 'node' pattern 返 ProcessInfo[]）
- **SIGKILL escalation**（phase 535 / trap SIGTERM 进程 → timeout → SIGTERM grace 1s → SIGKILL → settle）
- **env scrub**（phase 535 / 传 env 不见 process.env / 不传则全继承 + PATH augmentation）
- **settled guard**（phase 535 / error handler settled guard / spawn error 仅 reject 一次）
