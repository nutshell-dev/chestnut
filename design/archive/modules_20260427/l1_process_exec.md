# ProcessExec 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §2 + §跨 OS 支持 align）：**进程 OS 能力的统一 wrapper / 跨 OS 抽象层**。M1 反向测试：「进程 OS 原语统一封装」与「agent 工具导出」「audit 落盘」独立可变（改 OS 分支不影响工具层 / 改工具层不影响 OS 抽象 / 改 audit 策略不影响进程原语）。业务边界 = 「所有进程 OS 操作的中性接口 + 跨 OS 实现分支（POSIX 与 Windows 内部映射）」/ **不 own agent 工具导出**（exec 工具归 ShellTool L2 / 应然新增模块）/ **不 own audit**（caller bridge）/ **不暴露 shell mode**（强制 cmd + args[] 形态 / 接受 shell 时 caller 自负跨 OS 风险）。接口扩为 5 方法：exec / spawnDetached / kill / isAlive / findByPattern。应然依赖：无。

**实然**：当前仅暴露 `exec` + `execFile` 两入口（短任务执行 + 抓输出 + timeout / maxBuffer / AbortSignal）/ 缺 `spawnDetached`（长生命周期 detached spawn）/ 缺中性 `kill(pid, signal)`（'TERM' / 'KILL' / 'INT' POSIX↔Windows 映射）/ 缺 `isAlive(pid)` / 缺 `findByPattern(pattern)`（POSIX pgrep / Windows tasklist 等）/ 模块导出 `exec` agent 工具（应然归 ShellTool L2）/ `exec` 走 `sh -c` 暴露 shell mode（应然不暴露）/ 应然层 leak 待 §7 登记 drift（待 Stage 2 治理：扩接口 + 工具导出搬到 ShellTool L2 + shell mode 收口）。

归属：L1 原语。~~依赖：无~~（应然依赖：无 / 实然同 / 表述对齐应然 wrapper 定位）。被调用：~~agent 工具层（`exec` 工具）~~（应然 leak / 工具归 ShellTool L2）、ContractSystem（验收脚本）、Snapshot（git 命令）、应然新增 caller：ProcessManager（spawnDetached + kill + isAlive，当前直 import `child_process` drift）/ Watchdog 等需进程查找的模块（findByPattern）。

## 职责边界

### 做

**应然（5 方法接口）**：

1. `exec(cmd, args, opts)` — 短任务执行 + 抓输出 + timeout + maxBuffer + AbortSignal（强制 cmd + args[] / 不走 shell）
2. `spawnDetached(cmd, args, opts)` — 长生命周期 detached spawn（不抓输出 / 返回 pid / 父进程退出后子进程独立存活）
3. `kill(pid, signal)` — 中性信号 'TERM' / 'KILL' / 'INT'（POSIX 直传 SIGTERM/SIGKILL/SIGINT / Windows 内部映射 TerminateProcess 或等价）
4. `isAlive(pid)` — 存活检查（POSIX `kill(pid, 0)` / Windows OpenProcess 等价）
5. `findByPattern(pattern)` — 按 pattern 查 PID（POSIX pgrep / Windows tasklist 过滤 等）
6. timeout 夹在 `[MIN, MAX]` 区间（**显式设计决策**的 clamp；见失败语义）
7. 统一错误包装：所有失败包成 `ProcessExecError`（结构化携带 pid / signal / stdout / stderr / exitCode）

**实然（仅 1 方法）**：

1. ~~提供两个入口：`exec`（通过 `sh -c` 执行 shell 命令，支持管道/重定向/变量展开）与 `execFile`（直接 spawn，args 不经 shell 插值）~~ — **应然 leak**：`exec` 暴露 shell mode 违反「不暴露 shell mode」/ 实然两入口需收敛为单一 `exec(cmd, args, opts)` / shell mode 移除 / drift §7 登记
2. timeout 夹在 `[MIN, MAX]` 区间（合规 / 保留）
3. PATH 注入：确保 `process.execPath` 所在目录在子进程 `PATH` 里（让 `npx`、`tsx` 等 Node 工具可被发现；见"与现状的差异"）
4. maxBuffer 限制：stdout+stderr 超过 1MB 抛 `ProcessExecError(maxBufferExceeded=true)`
5. 通过 `AbortSignal` 支持取消（abort → 子进程 kill）
6. 统一错误包装：超时、非零退出、maxBuffer、spawn 失败均包成 `ProcessExecError`
7. ~~缺 `spawnDetached` / `kill` / `isAlive` / `findByPattern`~~ — **应然 leak**：caller（如 ProcessManager / Watchdog）直 import `child_process` 绕过 L1 抽象 / drift §7 登记

### 不做

- 不做权限检查 / 命令黑白名单（调用方责任）
- 不做输出流式回传（返回整段 stdout/stderr 字符串；流式需求归工具层实现）
- 不做 stdin 写入（无调用方需求）
- 不做进程池 / 并发控制（每次调用独立 spawn）
- 不缓存执行结果
- 不做交互式 TTY
- **不导出 agent 工具**（应然 / 实然 drift：当前导出 `exec` 工具 / 应然归 ShellTool L2 新增模块）
- **不写 audit**（应然 / 实然合规：caller bridge）
- **不暴露 shell mode**（应然 / 实然 drift：`exec` 走 `sh -c` 是 shell mode leak / 接受 shell 时 caller 自负跨 OS 风险）

## 接口

**应然（5 方法 + 中性 signal 类型）**：

```ts
type ProcessSignal = 'TERM' | 'KILL' | 'INT';  // POSIX↔Windows 内部映射

interface ExecOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

interface SpawnDetachedOptions {
  cwd: string;
  env?: Record<string, string>;
  stdio?: 'ignore' | 'inherit';  // detached 不抓输出 / 默认 'ignore'
}

interface ExecResult { stdout: string; stderr: string; exitCode: number; }

// 5 方法 / 强制 cmd + args[] 形态（不暴露 shell mode）
function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
function spawnDetached(cmd: string, args: string[], opts: SpawnDetachedOptions): { pid: number };
function kill(pid: number, signal: ProcessSignal): void;
function isAlive(pid: number): boolean;
function findByPattern(pattern: string | RegExp): Promise<number[]>;
```

**实然（1 方法 / 双入口含 shell mode leak）**：

```ts
interface ExecOptions {
  cwd: string;                  // 必填：工作目录（强制显式，避免继承调用方进程 cwd 造成误用）
  timeout?: number;             // 默认 DEFAULT_TIMEOUT_MS；clamp 到 [MIN, MAX]
  signal?: AbortSignal;         // 外部取消
  env?: Record<string, string>; // 合并入 process.env + 注入后的 PATH
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;             // 成功路径恒为 0（非零退出走 ProcessExecError）
}

function exec(command: string, options: ExecOptions): Promise<ExecResult>;
function execFile(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;

class ProcessExecError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number | null;      // OS 未交付 numeric code 时为 null（如信号终止）
  killed: boolean;              // 超时或 signal abort 导致的 kill
  maxBufferExceeded: boolean;
}
```

关键约定：
- `cwd` 必填——不默认继承调用方进程 cwd，避免"忘传导致跑在错误目录"的静默失败类错误
- ~~`exec` 走 `sh -c`：命令注入安全由调用方负责（ProcessExec 不过滤）~~ — **应然 leak**：shell mode 不应暴露 / 实然 drift §7 登记
- ~~`execFile` 不经 shell，args 原样透传，适合传用户输入的参数~~ — 应然合并入单一 `exec(cmd, args, opts)` / 强制 cmd + args[] 形态

## 失败语义

| 失败源 | ProcessExec 行为 |
|---|---|
| 进程非零 exit | 抛 `ProcessExecError(exitCode=n, killed=false)`，携带 stdout/stderr |
| 超时（运行 > clamped timeout） | 抛 `ProcessExecError(killed=true, message="Command timed out after <ms>ms")` |
| `signal.abort()` | 抛 `ProcessExecError(killed=true)`（Node 实现中 abort 也表现为 killed=true） |
| stdout+stderr > 1MB | 抛 `ProcessExecError(maxBufferExceeded=true)`，携带截断前的输出 |
| 命令不存在 / spawn 失败 | 抛 `ProcessExecError(exitCode=null)`，message 为 Node 原始错误 |
| `cwd` 不存在 | 抛 `ProcessExecError(exitCode=null)`（Node spawn 错误原样包装） |
| 调用方传 `timeout < MIN` 或 `> MAX` | **显式设计决策**的 clamp（防误传 0 立即失败、防超大值变相永久挂起）；不抛错、不 warn。调用方意图被改写属已知取舍，契约责任是让此行为在文档层可见，而非免费隐藏 |

## 不可消除的耦合

**应然**：无跨模块耦合。ProcessExec 是 L1 原语，对调用方完全被动 / 跨 OS 抽象（POSIX vs Windows）由本模块内部分支吸收 / 不向调用方泄漏 OS 差异。

**实然 leak**：~~无跨模块耦合~~ — 模块导出 `exec` agent 工具（依赖 Tools 协议类型）属应然 leak / 工具应归 ShellTool L2 新增模块 / drift §7 登记。

## 配置常量归属

| 常量 | 值 | 归属 | 说明 |
|---|---|---|---|
| `PROCESS_EXEC_TIMEOUT_MIN_MS` | 1000 | 模块导出 | 下限防误传 0/负数 |
| `PROCESS_EXEC_TIMEOUT_MAX_MS` | 120_000 | 模块导出 | 上限防漏传变相永久挂起 |
| `PROCESS_EXEC_DEFAULT_TIMEOUT_MS` | 30_000 | 模块导出 | 默认 30s |
| `PROCESS_EXEC_MAX_BUFFER` | 1MB | 内部常量 | 不导出；大输出需调用方走临时文件方案 |

前三者跨模块被测试与调用方引用 → 导出。`MAX_BUFFER` 是实现策略 → 内部常量。

## 与现状的差异

- 当前 `MAX_BUFFER` 未导出也不可配置。若将来调用方（如 Snapshot 处理大 diff）需要更大缓冲，应评估改为 `ExecOptions.maxBuffer?` 或走临时文件方案，而非提高全局上限。
- `exec` 硬编码 `sh`。契约不声明 Windows 支持（Unix 进程模型，与 Transport 选 UDS 的决策一致）。
- **PATH 注入是上层部署假设下沉到 L1**：`runProcess` 自动把 `process.execPath` 所在目录塞进子进程 `PATH`，起因是 clawforum 调用 `npx` / `tsx` 等 Node 工具时需子进程能发现它们。严格按"底层不预设上层语义"原则，这是上层部署特性被 L1 吞下的 kludge。当前保留现状以避免大范围改动；若未来部署模型变化（打包成单可执行文件、容器化等）应重新评估此注入的归属层——候选方案：由 Daemon 装配期统一准备一个"合法的 PATH"透传进 `ExecOptions.env`，ProcessExec 退回为纯 spawn。

## 测试覆盖（验证行为契约）

- `tests/foundation/process-exec.test.ts`（13 `it`）：`exec` 成功路径 / 非零 exit 抛 `ProcessExecError` 携带 stdout/stderr / 超时 `killed=true` / `AbortSignal` 取消 / maxBuffer 超限 / spawn 失败 / `execFile` args 不经 shell 插值 / timeout clamp 到 `[MIN, MAX]` / PATH 注入能发现 `npx`。

**覆盖缺口**：
- `cwd` 不存在的错误包装路径（边界依赖 OS 错误，未显式断言）。
- `ExecOptions.maxBuffer?` 参数化（当前内部常量，未开放 → 无测试需求）。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**phase187 历史结论**（保留 / 实然描述）：实测零条 console / audit / 失败软吞 → "最干净 L1" 评级。`src/foundation/process-exec/` 3 文件共 197 行 / 0 `console.*` / 0 audit.tsv 直写 / 所有失败经 `ProcessExecError` 结构化抛出。

**2026-04-26 应然修订（架构 sharpen）新增 drift / 待 Stage 2 治理**：

#### A.1 [drift] 接口缺 4 方法（spawnDetached / kill / isAlive / findByPattern）

- **应然**：5 方法接口（exec / spawnDetached / kill / isAlive / findByPattern），覆盖所有进程 OS 操作
- **实然**：仅暴露 `exec` + `execFile`（短任务执行）/ 缺 detached spawn / 中性 kill / 存活检查 / 进程查找 4 方法
- **后果**：caller（ProcessManager 等）直 import `child_process` 绕过 L1 抽象 → 跨 OS 治理无单点 / Windows 移植散落各 caller
- **治理路径**：扩接口 4 方法 + 内部按 OS 分支实现（POSIX child_process + signals + pgrep / Windows TerminateProcess + tasklist 等）+ 推动 caller 切换

#### A.2 [drift] 实然只暴露 exec 接口 / 接口待扩

- **应然**：单一 `exec(cmd, args[], opts)` 形态 / 强制 cmd + args[]
- **实然**：双入口 `exec(string)` 走 `sh -c` + `execFile(cmd, args)` / 应然合并为单一 cmd + args[] 形态
- **治理路径**：`execFile` 改名 `exec` / 旧 `exec(string)` 删除（含 shell mode）

#### A.3 [drift] 模块导出 exec agent 工具 leak（应然归 ShellTool L2）

- **应然**：L1 ProcessExec 不 own agent 工具导出 / 工具归 ShellTool L2（应然新增模块 / 见 modules.md §ShellTool）
- **实然**：当前 ProcessExec 模块导出 `exec` agent 工具（依赖 Tools 协议类型 / cross-layer-up 候选）
- **后果**：L1 反向依赖 L2 Tools 协议 / 违反 M5 单向依赖 / 跨 OS 抽象层混入 agent 业务语义
- **治理路径**：`exec` 工具搬到新增 L2 ShellTool 模块 / ProcessExec 退化为纯进程原语

#### A.4 [drift] shell mode 是否暴露的应然约束（不暴露）

- **应然**：不暴露 shell mode / 强制 cmd + args[] 形态 / 接受 shell 时 caller 自负跨 OS 风险（自己 spawn `sh -c` 或 `cmd /c`）
- **实然**：`exec(string)` 走 `sh -c` 直接暴露 shell mode / Snapshot / ContractSystem 等 caller 利用之走管道 + 重定向 + 变量展开
- **后果**：跨 OS 移植时 shell 语义不可移（POSIX `sh` vs Windows `cmd` / PowerShell 行为差异巨大）/ caller 写的 shell 命令绑死 POSIX
- **治理路径**：移除 `exec(string)` 入口 / caller 改用 cmd + args[] 形态 / 仍需 shell 的 caller 自负跨 OS 风险（自包 `sh -c <cmd>` 形成 args[]）

### 7.B ↔ §与现状的差异 节

既有 "§与现状的差异" 节已登记 3 条：`MAX_BUFFER` 未导出 / `sh` 硬编码 Unix-only / PATH 注入属上层语义下沉。

phase187 复核：3 条均仍合规偏差（当前无升档条件触发）。

phase187 补 0 条（无新偏差发现）。

### 7.C 原则对照（32 条）

全 32 条覆盖（Module Logic 11 + Design 11 + Philosophy 4 + Path 6）。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。单一职责 = 同步进程调用的统一封装
- **M2 业务语义归属**：合规。spawn / execFile / timeout 处理由本模块直发起
- **M3 资源归属**：无关（进程是操作系统资源，无跨模块资源竞争）
- **M4 持久化**：无关
- **M5 依赖单向**：合规。process-exec → types/errors；无反向
- **M6 依赖结构稳定**：合规。`exec` / `execFile` / `ExecOptions` / `ExecResult` 接口自 phase146+ 稳定
- **M7 耦合界面稳定**：合规
- **M8 耦合界面最小**：合规。`ExecOptions` 4 字段精选（cwd / env / timeout / signal）
- **M9 显式表达编译器可检**：合规。`ProcessExecError` 命名 class 携带 exitCode / signal / stdout / stderr
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条）

- **D1a 信息不丢失**：合规。`ProcessExecError` 携带 stdout + stderr + exitCode + signal 全量
- **D1b 状态可观察**：合规。失败时返回的 result 完整
- **D1c 中断可恢复**：合规。AbortSignal 统一支持（契约 L117 测试）
- **D1d 事后可审计**：合规（由调用方落 audit，基础设施本身不自审计）
- **D2 不得丢弃/静默**：合规（timeout clamp 静默改写已登记 §B，当前合规偏差）
- **D3 用户可观察**：合规（同 D1b）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：合规
- **D6a 决策主体**：无关
- **D6b 子代理不阻塞**：合规（不阻塞设计通过 AbortSignal 实现）
- **D7 系统可信路径**：合规。`execFile` 不经 shell 展开，args 原样传递
- **D8 事件驱动**：无关
- **D9 多 claw 不隔绝**：无关
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（3 条）

- **P1 上下文工程**：无关
- **P2 多 agent 复用**：合规（单一代码基）
- **P3 Agent 即目录 / 对话即状态**：无关

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ Read 源码 197 行 + 测试 13 it
- **Path #2 差距显式登记**：✓ 既有 §与现状的差异 3 条偏差登记
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = 契约 backfill
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only；无破坏性
- **Path #5 完成后复盘**：将于 phase187 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.Phase 执行纪律

#### phase187 纪律 — L1 ProcessExec backfill（2026-04-21，design 本地 only）

- **scope**：既有契约缺 §7.C 32-条原则对照 + §7.Phase 节，按 phase181 L3 模板补齐
- **产出**：§7.A 零条（最干净 L1）/ §7.B 映射 既有 3 条保留 / §7.C 32 条 / §7.Phase（本节）
- **对比定位**：
  - **最干净 L1 模块** —— 0 console / 0 audit 直写 / 所有失败结构化
  - 与 FileSystem（1 console 合规）+ MessageCodec（1 console 合规）组成 "纯净 L1 原语" 组
  - 对比 LLMService（8 软吞）+ Transport（3 软吞）的"需 event sink wire" 组
- **方法论贡献**：L1 模块 "零 console 理想态" 样板

