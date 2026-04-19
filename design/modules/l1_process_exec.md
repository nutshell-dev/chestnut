# ProcessExec 接口契约

L1 外部进程调用的唯一入口。封装 `spawn`，提供超时控制、输出大小限制、PATH 注入、统一错误包装。

归属：L1 原语。依赖：无。被调用：agent 工具层（`exec` 工具）、ContractSystem（验收脚本）、Snapshot（git 命令）。

## 职责边界

### 做

1. 提供两个入口：`exec`（通过 `sh -c` 执行 shell 命令，支持管道/重定向/变量展开）与 `execFile`（直接 spawn，args 不经 shell 插值）
2. timeout 夹在 `[MIN, MAX]` 区间（**显式设计决策**的 clamp；见失败语义）
3. PATH 注入：确保 `process.execPath` 所在目录在子进程 `PATH` 里（让 `npx`、`tsx` 等 Node 工具可被发现；见"与现状的差异"）
4. maxBuffer 限制：stdout+stderr 超过 1MB 抛 `ProcessExecError(maxBufferExceeded=true)`，携带截断前的输出
5. 通过 `AbortSignal` 支持取消（abort → 子进程 kill）
6. 统一错误包装：超时、非零退出、maxBuffer、spawn 失败均包成 `ProcessExecError`，保留原始 stdout/stderr

### 不做

- 不做权限检查 / 命令黑白名单（调用方责任）
- 不做输出流式回传（返回整段 stdout/stderr 字符串；流式需求归工具层实现）
- 不做 stdin 写入（无调用方需求）
- 不做进程池 / 并发控制（每次调用独立 spawn）
- 不缓存执行结果
- 不做交互式 TTY

## 接口

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
- `exec` 走 `sh -c`：命令注入安全由调用方负责（ProcessExec 不过滤）
- `execFile` 不经 shell，args 原样透传，适合传用户输入的参数

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

无跨模块耦合。ProcessExec 是 L1 原语，对调用方完全被动。

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
