# ShellTool 接口契约

**L2 基础设施层（agent 语义）**。把 L1 `ProcessExec` 能力包装成 agent 工具的适配层 + 命令调用约束。属"agent 调用外部命令"业务语义的归属点；与 Tools 框架的关系：ShellTool 实现 `Tool` 协议，由 Assembly 装配期注册到 `ToolRegistry`。

> **应然 / 实然 split**（2026-04-26 / r31 新建 / drift 标记）：
>
> **应然**：本契约描述的形态 —— 独立 L2 模块，导出 1 个工具对象（exec）+ 可选命令白/黑名单 + caller 自负 shell mode 跨 OS 风险。
>
> **实然**：**模块尚不存在**。当前 exec 工具源码物理位于 `src/core/tools/builtins/exec.ts`，由 Tools 模块跨业务持有。详 §7。

## 1. 职责

### 做

1. **exec 工具**：实现 `Tool` 协议 / args = `{ command, cwd?, timeoutMs?, env?, ... }` / 调 L1 ProcessExec 跑命令 / 返回 `{ stdout, stderr, exitCode }`
2. **命令调用约束**：可选白/黑名单（装配期注入）—— 拒绝不在白名单 / 命中黑名单的命令
3. **shell mode 跨 OS 适配**：caller 自负风险（应然 ProcessExec 不暴露 shell mode；ShellTool 接受调用时由业务方负责跨 OS shell 语法适配）
4. **超时透传**：args.timeoutMs → ProcessExec.exec 超时控制；与 Tools 框架 `ExecuteOptions.timeoutMs` 双重保护

### 不做

- **不做进程原语**（spawn / kill 归 L1 ProcessExec）
- **不做工具注册 / 调用 / 框架级超时 / audit**（归 L2 Tools 框架 / `tool_exec` 通用事件覆盖）
- **不做 shell 解析**（不展开 `~` / 不替换 env var；这些归 caller / shell 自身）
- **不暴露 shell mode 选项**（应然层面；如必须用 `bash -c`，由 caller 在 command 里显式构造）

### 业务语义

「agent 用外部命令」的 L2 适配点 —— 把"OS 进程执行"变成"agent 工具调用"语义。

## 2. 接口

```ts
// 1 个工具对象（实现 L2 Tools 模块的 Tool 协议）
declare const execTool: Tool;

// 工具集合 + 装配工厂（应然形态）
interface ShellToolModule {
  tools: { exec: Tool };
}

function createShellTools(opts: {
  processExec: ProcessExec;
  allowList?: (string | RegExp)[];   // 命令名/正则白名单
  denyList?: (string | RegExp)[];    // 黑名单（优先级高于 allowList）
  defaultTimeoutMs?: number;
}): ShellToolModule;

// args schema
interface ExecArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}
```

**前置条件**：
- command 非空字符串
- 若注入 `allowList` / `denyList`，命令首 token 经匹配；否则放行所有
- cwd（若指定）由 caller 保证可访问；ShellTool 不做权限校验

**失败分类**：
- 命中 denyList / 不在 allowList → `{ success: false, content: 'command rejected: <name>' }`（不抛）
- 进程非零退出 → `{ success: true, content: '<stdout+stderr>', metadata: { exitCode } }`（exitCode 非 0 由 caller 判读，工具本身视作"执行完成"）
- 超时 → `{ success: false, content: 'exec timeout after <n>ms' }`
- spawn 失败（command not found 等） → `{ success: false, content: <err.message> }`

**caller shell mode 风险**：
- 跨 OS：`ls` (Unix) vs `dir` (Windows)，agent 自负
- shell injection：command 直接传给 ProcessExec，agent 自负参数转义；高安全场景请结合 allowList 限制

## 3. 审计事件

本契约导出工具不产 audit 自发事件 —— 框架层 `tool_exec`（L2 Tools 契约 §3 登记）覆盖通用执行事件。如未来需要业务事件（如 `exec_command_rejected` 黑白名单拦截），在此追加。

## 4. 上游依赖

| 项 | 来源 | 用途 |
|---|---|---|
| `ProcessExec` type + 实现 | L1 / `foundation/process/...` | exec 底层 OS 进程 |
| `Tool` / `ToolResult` / `ExecContext` type | L2 Tools / `core/tools/executor.ts` | Tool 协议 + 返回类型 |

**应然不依赖**：任何 L3+ 模块、任何业务模块。

## 5. 装配归属

- **按需装配**：任何允许 agent 调用外部命令的 daemon（claw 主装配；motion / verifier 子代理一般不开放 exec / 通过 profile 屏蔽）
- **装配方**：Assembly（L6c）调 `createShellTools({ processExec, allowList?, denyList? })` 拿 exec Tool 对象 → `toolRegistry.register(execTool)`
- **profile 白名单**：exec 仅 `full` profile（详 L2 Tools §2.e）

## 6. 资源

无自有磁盘资源 / 无运行期实例状态（thin wrapper / 白黑名单装配期注入）。

## 7. 与现状差距（drift）

### A 类违规

#### A.1 模块尚不存在 — 待物理迁移建立

**现状**（2026-04-26）：
- exec 工具源码物理位于 `src/core/tools/builtins/exec.ts`
- 业务语义按 α.1 决策（KD#27）已声明归 ShellTool 模块，但物理位置未迁移
- 当前 exec 工具实现细节（白黑名单 / shell mode 处理）在 builtins 内部，未抽象为 `createShellTools` 工厂

**应然**：exec 迁至独立目录（如 `src/core/shell-tool/`）+ `createShellTools` 工厂 + allowList/denyList 抽出装配期注入

**修复方向**（独立 phase）：
1. 物理迁移 `src/core/tools/builtins/exec.ts` → `src/core/shell-tool/exec.ts`
2. 抽出 `createShellTools({ processExec, allowList?, denyList?, defaultTimeoutMs? })` 工厂
3. Assembly 装配点改调工厂 + 注册 exec 工具
4. 更新 modules.md 依赖图 + L2 Tools §7 同步去 builtins/exec.ts

**Stage**：Stage 2 物理迁移批（与 FileTool / Messaging tools 等并行规划）

### B 类偏差

无（应然契约 / 实然不存在 / 全 drift 归 A.1）

### C 类（原则对照 / 应然契约自洽性）

| 原则 | 判定 | 依据 |
|---|---|---|
| M#1 独立可变职责 | 合规 | 命令执行适配语义独立于其他工具 |
| M#2 业务语义归属 | 合规 | "agent 调用外部命令"业务点归本模块 |
| M#5 依赖单向 | 合规 | L2 → L1 (ProcessExec) + L2 → L2 (Tools) 同层 type 依赖 |
| M#7 耦合界面稳定 | 合规 | exec 工具对象稳定 / `Tool` 协议稳定 |
| M#9 显式编译器可检 | 合规 | exec 签名全 type / 白黑名单类型化 |
| D7 系统可信路径 | 合规 | profile 限定 + 可选白黑名单兜底 |

## 8. 测试覆盖

### 应然

- `tests/core/shell-tool/exec.test.ts` —— 正常 / 超时 / 非零退出 / 命令不存在 / 拒绝（allowList/denyList）/ env 透传 / cwd 透传

### 实然

- 当前 exec 单测在 `tests/core/tools/builtins/exec.test.ts`（位置随 builtins / Stage 2 一并迁移）
