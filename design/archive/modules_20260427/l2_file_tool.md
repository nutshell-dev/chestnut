# FileTool 接口契约

**L2 基础设施层（agent 语义）**。把 L1 `FileSystem` 能力包装成 agent 工具的适配层 + 路径权限域 + 越界守护。属"agent 调用文件系统"业务语义的归属点；与 Tools 框架的关系：FileTool 实现 `Tool` 协议，由 Assembly 装配期注册到 `ToolRegistry`。

> **应然 / 实然 split**（2026-04-26 / r31 新建 / drift 标记）：
>
> **应然**：本契约描述的形态 —— 独立 L2 模块，导出 4 个工具对象（read / write / search / ls）+ 路径权限域配置 + 越界守护策略。
>
> **实然**：**模块尚不存在**。当前 read / write / search / ls 工具源码物理位于 `src/core/tools/builtins/`（read.ts / write.ts / search.ts / ls.ts，4 个文件），由 Tools 模块跨业务持有。详 §7。

## 1. 职责

### 做

1. **read 工具**：实现 `Tool` 协议 / args = `{ path }` / 返回文件文本内容；越界守护按权限域校验
2. **write 工具**：实现 `Tool` 协议 / args = `{ path, content }` / 原子写入；越界守护
3. **search 工具**：实现 `Tool` 协议 / args = `{ pattern, path? }` / 在权限域内做内容/文件名搜索
4. **ls 工具**：实现 `Tool` 协议 / args = `{ path }` / 返回目录列表
5. **路径权限域配置**：装配方注入允许访问的根路径集合（如 `clawDir` / `motionDir`）
6. **越界守护**：解析后的绝对路径必须在权限域内；越界 → `ToolResult { success: false, content: 'path out of allowed scope' }`

### 不做

- **不做 fs OS 原语**（归 L1 FileSystem）
- **不做工具注册 / 调用 / 超时 / audit**（归 L2 Tools 框架）
- **不做业务语义解释**（什么算"该读的文件"由 caller / agent 决定）
- **不持权限域状态**（每个 ExecContext / 每次装配传入）

### 业务语义

「agent 用文件系统能力」的 L2 适配点 —— 把"OS 文件系统"变成"agent 工具调用"语义。

## 2. 接口

```ts
// 4 个工具对象（实现 L2 Tools 模块的 Tool 协议）
declare const readTool: Tool;
declare const writeTool: Tool;
declare const searchTool: Tool;
declare const lsTool: Tool;

// 工具集合 + 装配工厂（应然形态）
interface FileToolModule {
  tools: { read: Tool; write: Tool; search: Tool; ls: Tool };
}

function createFileTools(opts: {
  fs: FileSystem;
  allowedRoots: string[];   // 权限域根路径（绝对路径）
}): FileToolModule;
```

**前置条件**：
- 所有 path 参数解析为绝对路径后必须前缀匹配 `allowedRoots` 之一
- write 必须经 fs 原子写（temp + rename）

**失败分类**：
- 越界 → `{ success: false, content: 'path out of allowed scope: <path>' }`（不抛）
- fs 错误（ENOENT / EACCES 等） → `{ success: false, content: <err.message> }`
- 参数缺失 → 由 Tools 框架 `validateArgs` 兜底抛 `ToolInvalidInputError`

## 3. 审计事件

本契约导出工具不产 audit 自发事件 —— 框架层 `tool_exec`（L2 Tools 契约 §3 登记）覆盖通用执行事件。如未来需要业务事件（如 `file_write_blocked` 越界拒绝），在此追加。

## 4. 上游依赖

| 项 | 来源 | 用途 |
|---|---|---|
| `FileSystem` type + 实现 | L1 / `foundation/fs/...` | read / write / ls / search 底层 OS 调用 |
| `Tool` / `ToolResult` / `ExecContext` type | L2 Tools / `core/tools/executor.ts` | Tool 协议 + 返回类型 |

**应然不依赖**：任何 L3+ 模块、任何业务模块。

## 5. 装配归属

- **按需装配**：任何允许 agent 操作文件系统的 daemon（claw / motion 主装配；verifier / dispatch 子代理装配按 profile 决定是否包含）
- **装配方**：Assembly（L6c）调 `createFileTools({ fs, allowedRoots })` 拿 4 个 Tool 对象 → 逐个 `toolRegistry.register(tool)`
- **profile 白名单**：read / search / ls 在 `readonly` profile；write 仅 `full` / `subagent`（详 L2 Tools §2.e）

## 6. 资源

无自有磁盘资源 / 无运行期实例状态（thin wrapper / 路径权限策略由 caller 注入）。

## 7. 与现状差距（drift）

### A 类违规

#### A.1 模块尚不存在 — 待物理迁移建立

**现状**（2026-04-26）：
- read / write / search / ls 4 个工具源码物理位于 `src/core/tools/builtins/`（read.ts / write.ts / search.ts / ls.ts）
- 业务语义按 α.1 决策（KD#27）已声明归 FileTool 模块，但物理位置未迁移
- 路径权限域当前由各工具内部各自处理（无统一 `allowedRoots` 抽象）

**应然**：4 工具迁至独立目录（如 `src/core/file-tool/`）+ 统一 `createFileTools` 工厂 + 共享权限域守护

**修复方向**（独立 phase）：
1. 物理迁移 4 文件 `src/core/tools/builtins/{read,write,search,ls}.ts` → `src/core/file-tool/`
2. 抽出 `createFileTools({ fs, allowedRoots })` 工厂 + 抽公共越界守护 helper
3. Assembly 装配点改调工厂 + 注册 4 工具
4. 更新 modules.md 依赖图 + L2 Tools §7 同步去 builtins/

**Stage**：Stage 2 物理迁移批（与 ShellTool / Messaging tools 等并行规划）

### B 类偏差

无（应然契约 / 实然不存在 / 全 drift 归 A.1）

### C 类（原则对照 / 应然契约自洽性）

| 原则 | 判定 | 依据 |
|---|---|---|
| M#1 独立可变职责 | 合规 | 文件系统适配语义独立于其他工具 |
| M#2 业务语义归属 | 合规 | "agent 操作文件系统"业务点归本模块 |
| M#5 依赖单向 | 合规 | L2 → L1 (FileSystem) + L2 → L2 (Tools) 同层 type 依赖 |
| M#7 耦合界面稳定 | 合规 | 4 工具对象稳定 / `Tool` 协议稳定 |
| M#9 显式编译器可检 | 合规 | 工具签名全 type / 越界守护编码 |

## 8. 测试覆盖

### 应然

- `tests/core/file-tool/read.test.ts` —— 正常 / 越界 / 不存在
- `tests/core/file-tool/write.test.ts` —— 原子性 / 越界 / 父目录不存在
- `tests/core/file-tool/search.test.ts` —— 模式匹配 / 越界目录拒绝
- `tests/core/file-tool/ls.test.ts` —— 目录枚举 / 越界
- 公共：`createFileTools` 工厂 / `allowedRoots` 边界（前缀匹配 / 路径规范化 / 符号链接）

### 实然

- 当前 4 工具单测在 `tests/core/tools/builtins/{read,write,search,ls}.test.ts`（位置随 builtins / Stage 2 一并迁移）
