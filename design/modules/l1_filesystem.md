# FileSystem 接口契约

L1 文件 I/O 原语。clawforum 进程内代码的所有文件 I/O 的唯一入口，提供原子写、路径守护、权限域配置。

归属：L1 原语。依赖：无。被调用：几乎所有 L2+ 模块（AuditLog、Stream、Messaging、SessionStore、Snapshot、ProcessManager、FileWatcher、SubagentSystem、ContractSystem、MemorySystem 等）。

## 职责边界

### 做

1. 提供 async / sync 双轨基本文件操作：read、write、append、delete、move、stat、exists、list、ensureDir、removeDir
2. 原子写：`writeAtomic` / `writeAtomicSync` 通过 "write-to-temp + rename"（sync 版加 fsync）保证崩溃不留半文件
3. 独占创建：`writeExclusiveSync`（PID 锁文件等场景），目标已存在时抛 `EEXIST`
4. 路径解析与守护：`resolve` 把相对路径解析为 `baseDir` 下绝对路径，越界抛 `PathNotInClawSpaceError`
5. 权限域检查（`enforcePermissions=true`）：SYSTEM_PATHS 写入禁止、WRITABLE_PATHS 放行、baseDir 内其他区域默认可写

### 不做

- 不理解业务目录语义（inbox/outbox/stream.jsonl 等由 L2 各模块自行组织）
- 不做变更事件订阅（归 FileWatcher）
- 不做跨进程文件锁协调（`writeExclusiveSync` 只提供 "exclusive create" 原语；更复杂的锁归调用方）
- 不做全量 glob 引擎（`list` 仅支持简单 pattern；复杂搜索归工具层 search）
- 不 cache 文件内容
- 不保证跨进程同步（多进程写同一文件需调用方协调）

## 接口

构造：等价于 `new NodeFileSystem(options)`（当前唯一实现；契约以 interface 为准，不绑定具体 class）。

```ts
interface FileSystemOptions {
  baseDir: string;                // 所有相对路径解析的根
  enforcePermissions?: boolean;   // 默认 true
}

interface FileSystem {
  // ---- async ----
  read(path): Promise<string>;
  writeAtomic(path, content): Promise<void>;
  append(path, content): Promise<void>;
  delete(path): Promise<void>;
  move(fromPath, toPath): Promise<void>;
  ensureDir(path): Promise<void>;
  removeDir(path): Promise<void>;
  list(path, options?: { recursive?; includeDirs?; pattern? }): Promise<FileEntry[]>;
  exists(path): Promise<boolean>;
  isDirectory(path): Promise<boolean>;
  stat(path): Promise<StatInfo>;

  // ---- sync（hot path：audit.tsv 追加、PID 锁、Stream writer）----
  readSync(path): string;
  writeAtomicSync(path, content): void;
  writeExclusiveSync(path, content): void;     // 已存在抛 EEXIST
  appendSync(path, content): void;
  deleteSync(path): void;
  moveSync(fromPath, toPath): void;
  existsSync(path): boolean;
  ensureDirSync(path): void;
  statSync(path): StatInfo;
  listSync(path, options?): FileEntry[];

  // ---- 路径解析 ----
  resolve(relativePath): string;               // 返回绝对路径；越界抛 PathNotInClawSpaceError
}

// ---- 启动期维护（free function，不走 interface）----
function cleanupOrphanedTemp(baseDir: string): Promise<void>;
// 遍历 baseDir 下所有 `.tmp.*` 残片（`writeAtomic` rename 前崩溃遗留）并删除。
// 由 Daemon 启动期调用；纯副作用，无返回值。失败原样抛（启动期关键路径）。

// ---- 跨模块 gitignore 聚合 ----
const IGNORE_PATTERN: string;
// 导出给 Snapshot 装配层：表示 FileSystem `writeAtomic` 副产物 `*.tmp.*` 不应进 git。
// 配合 Snapshot A.7 修复；消费方引用常量而非字面量，让编译器在 FileSystem 改变临时文件命名时捕获 drift。

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: Date;
}

interface StatInfo {
  size: number;
  mtime: Date;
  ctime: Date;
  isFile: boolean;
  isDirectory: boolean;
}
```

关键约定：
- 所有 `path` 参数相对 `baseDir`；实现内部 `resolve` 做越界检查
- `writeExclusiveSync` 的 EEXIST 是 PID 锁实现依据，不可改为"覆盖"语义
- `list` 的 `pattern` 仅支持简单 glob（`*`、`?`），不支持复杂表达式

## 失败语义

| 失败源 | FileSystem 行为 |
|---|---|
| 路径越出 `baseDir` | 抛 `PathNotInClawSpaceError` |
| 写入 SYSTEM_PATHS 且 `enforcePermissions=true` | 抛 `WriteOperationForbiddenError` |
| `read` / `delete` / `stat` / `move` 目标不存在 | 抛 `FileNotFoundError`（read/stat/delete 明确；move 走 Node fs 默认错误） |
| `writeExclusiveSync` 目标已存在 | 抛 `Error(code=EEXIST)` |
| 原子写在 rename 前崩溃 | 原文件未变更，留下 `.tmp.*` 残片；由 Daemon 启动期调用 `cleanupOrphanedTemp(baseDir)` 清理（见 §3 接口尾部 free function）|
| `cleanupOrphanedTemp` 自身 I/O 失败（权限 / 磁盘）| 原样抛 Node fs 错误；Daemon 决策是否中止启动（启动期关键路径，不静默）|
| 磁盘满 / 权限不足 / 其他 OS 错误 | 原样抛 Node fs 错误（不吞、不包装）；**静默失败风险**：调用方必须显式 try/catch，否则进程崩溃或日志淹没 |
| `list` 非法 pattern | 原样抛 glob 解析错（调用方责任） |
| `ensureDir` / `ensureDirSync` 对已存在路径调用 | 无操作，不抛错 |

## 不可消除的耦合

无跨模块耦合。FileSystem 是 L1 原语，对调用方完全被动。

## 配置常量归属

- `SYSTEM_PATHS`、`WRITABLE_PATHS`：定义在 `permissions.ts` 内部，**不导出、不可运行时配置**。理由：权限模型的语义定义跨 claw 稳定，若需调整必须走代码修改评审路径。
- `enforcePermissions` 默认 `true`：生产严格；测试允许传 `false` 关闭。
- `.tmp.` 临时文件命名前缀：归 `atomic.ts` 内部；对外通过 `IGNORE_PATTERN` 常量暴露给 Snapshot 装配层（见 §3），消费方不得直接引用字面量。

## 与现状的差异

- 当前只有 `NodeFileSystem` 一个实现；契约以 interface 描述，不绑定具体 class，未来如需 InMemoryFileSystem（测试）或其他实现不必改契约。
- `cleanupOrphanedTemp` 是 `atomic.ts` 导出的自由函数，契约 §3 已登记为 free function 形态；由 Daemon 启动期调用，不纳入 interface 签名（interface 只描述实例能力；启动期一次性维护作为 free function 合理）。
- `FileSystemOptions.allowedPaths`（当前 interface 仍存在）：phase0 预留的 baseDir 外白名单扩展点，生产代码 0 消费者，仅测试引用。**契约不描述此字段**；后续 phase 一致性自检时评估是否可从 interface / `permissions.ts` / `node-fs.ts` 透传链与测试中一并删除。

## 测试覆盖（验证行为契约）

- `tests/foundation/fs.test.ts`（22 `it`）：async/sync 双轨 read/write/append/delete/move/stat/exists/list/ensureDir/removeDir；`writeAtomic` temp+rename 崩溃残片；`writeExclusiveSync` EEXIST；`list` 简单 pattern；`cleanupOrphanedTemp` 残片扫除。
- `tests/foundation/path-permissions.test.ts`（22 `it`）：`resolve` 越界 `PathNotInClawSpaceError`；SYSTEM_PATHS 写入拒绝 `WriteOperationForbiddenError`；WRITABLE_PATHS 放行；`enforcePermissions=false` 关闭策略。

**覆盖缺口**：
- `IGNORE_PATTERN` 常量未被任何测试直接引用（仅 Snapshot 装配层消费）——若改名只能由 Snapshot 集成测试捕获 drift。
- 磁盘满 / 权限不足的原样抛 Node fs 错误路径未覆盖（依赖 OS 错误不易稳定触发）。
