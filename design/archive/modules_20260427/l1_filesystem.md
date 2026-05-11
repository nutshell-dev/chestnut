# FileSystem 接口契约

L1 文件 I/O 原语。clawforum 内部代码的所有文件 I/O 的唯一入口，提供原子写、路径守护、权限域配置。

**应然**（2026-04-26 修订 / 跟 modules.md §1 + L1 定位节 align）：L1 OS / fs API 抽象层。仅暴露纯 fs 操作（read / write / atomic / mkdir / stat / list / exists / 字节范围读 / 等）。**不 own** 路径越界守护 + 权限域检查（agent 业务 / FileTool L2 own）/ **不 own** 启动期临时残片清理（装配业务 / Daemon 或 Assembly own）/ **不 own** 导出 read / write / search / ls agent 工具（FileTool L2 own）/ **不 own** audit（cross-cutting / caller 自己 audit）。M1 反向测试：「fs OS 操作」vs「路径权限域 / 启动清理 / agent 工具导出」独立可变（改 fs 接口不影响 agent 权限语义 / 改权限策略不影响 fs OS wrapper）。

**实然**：当前 FileSystem 内化路径越界守护（`PathNotInClawSpaceError`）+ 权限域检查（SYSTEM_PATHS / WRITABLE_PATHS）+ 启动期 `cleanupOrphanedTemp` free function + 部分 agent 工具语义（`list` 简单 glob 等）/ 都是 leak / 待 §7 治理（Stage 2：FileSystem 退化为纯 fs wrapper / FileTool L2 持权限域 + 越界守护 + 工具导出 / Daemon 或 Assembly own 启动期清理）。

**应然依赖**：无（L1 不依赖任何 clawforum 模块）。
**实然依赖**：无（保持，仅业务边界 leak / 不引入跨模块 import）。

归属：L1 原语。被调用：几乎所有 L2+ 模块（AuditLog、Stream、Messaging、SessionStore、Snapshot、ProcessManager、FileWatcher、SubagentSystem、ContractSystem、MemorySystem 等）。

## 职责边界

### 做

1. 提供 async / sync 双轨基本文件操作：read、write、append、delete、move、stat、exists、list、ensureDir、removeDir
2. 原子写：`writeAtomic` / `writeAtomicSync` 通过 "write-to-temp + rename"（sync 版加 fsync）保证崩溃不留半文件
3. 独占创建：`writeExclusiveSync`（PID 锁文件等场景），目标已存在时抛 `EEXIST`
4. ~~路径解析与守护：`resolve` 把相对路径解析为 `baseDir` 下绝对路径，越界抛 `PathNotInClawSpaceError`~~ — **2026-04-26 应然修订作废**：路径越界守护归 FileTool L2（agent 业务）/ FileSystem 应然仅做纯路径 join / 实然 leak 待 §7.A 登记 drift（A.p320-1）
5. ~~权限域检查（`enforcePermissions=true`）：SYSTEM_PATHS 写入禁止、WRITABLE_PATHS 放行、baseDir 内其他区域默认可写~~ — **2026-04-26 应然修订作废**：权限域检查归 FileTool L2（agent 业务语义）/ FileSystem 不持 SYSTEM_PATHS / WRITABLE_PATHS 概念 / 实然 leak 待 §7.A 登记 drift（A.p320-1）

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
  readBytesSync(path, start, end): Buffer;   // 字节安全范围读；供 Stream reader 等字节偏移消费方
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
// ~~function cleanupOrphanedTemp(baseDir: string): Promise<void>;~~
// ~~遍历 baseDir 下所有 `.tmp.*` 残片（`writeAtomic` rename 前崩溃遗留）并删除。~~
// ~~由 Daemon 启动期调用；纯副作用，无返回值。失败原样抛（启动期关键路径）。~~
// 2026-04-26 应然修订作废：启动期临时残片清理归 Daemon / Assembly（装配业务）/
// FileSystem 应然仅暴露 list + delete 原语 / 装配方组合实现清理 / 实然 leak 待 §7.A 登记 drift（A.p320-2）

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
| `readBytesSync` 目标不存在 | 抛 `FileNotFoundError`（与 `readSync` 一致） |
| `readBytesSync` 的 start/end 越界（负 / start > end）| 原样抛 Node fs / Buffer 错误（调用方责任） |
| `readBytesSync` 文件在 end 之前 EOF | 返回实际读到的 Buffer（长度 < end - start）；不抛错、不填充 |
| `writeExclusiveSync` 目标已存在 | 抛 `Error(code=EEXIST)` |
| 原子写在 rename 前崩溃 | 原文件未变更，留下 `.tmp.*` 残片；由 Daemon 启动期调用 `cleanupOrphanedTemp(baseDir)` 清理（见 §3 接口尾部 free function）|
| `cleanupOrphanedTemp` 自身 I/O 失败（权限 / 磁盘）| 原样抛 Node fs 错误；Daemon 决策是否中止启动（启动期关键路径，不静默）|
| 磁盘满 / 权限不足 / 其他 OS 错误 | 原样抛 Node fs 错误（不吞、不包装）；**静默失败风险**：调用方必须显式 try/catch，否则进程崩溃或日志淹没 |
| `list` 非法 pattern | 原样抛 glob 解析错（调用方责任） |
| `ensureDir` / `ensureDirSync` 对已存在路径调用 | 无操作，不抛错 |

## 不可消除的耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。FileSystem interface 即 port 范本（消费方 own / NodeFileSystem 实现 / 装配注入）。**应然 L1 sharpen v2** = OS 抽象 only / 不内化 L2+ 业务语义。

无跨模块耦合。FileSystem 是 L1 原语，对调用方完全被动。

> 应然层注：实然 FileSystem 内化「权限域 + 越界守护」与「启动清理」，看似让 caller "感知不到耦合"，但实际把 agent 业务语义（FileTool L2）+ 装配业务（Daemon）leak 进 L1 / 形成隐式跨层耦合 / 实然 leak 待 §7.A 治理（A.p320-1 / A.p320-2）。

## 配置常量归属

- ~~`SYSTEM_PATHS`、`WRITABLE_PATHS`：定义在 `permissions.ts` 内部，**不导出、不可运行时配置**。理由：权限模型的语义定义跨 claw 稳定，若需调整必须走代码修改评审路径。~~ — **2026-04-26 应然修订作废**：权限域常量归 FileTool L2 / 实然 leak 待 §7.A（A.p320-1）
- ~~`enforcePermissions` 默认 `true`：生产严格；测试允许传 `false` 关闭。~~ — **2026-04-26 应然修订作废**：随权限域归 FileTool L2 / 实然 leak 待 §7.A（A.p320-1）
- `.tmp.` 临时文件命名前缀：归 `atomic.ts` 内部；对外通过 `IGNORE_PATTERN` 常量暴露给 Snapshot 装配层（见 §3），消费方不得直接引用字面量（应然合规：仅文件命名约定的对外暴露 / 不属 agent 工具语义）

## 与现状的差异

- 当前只有 `NodeFileSystem` 一个实现；契约以 interface 描述，不绑定具体 class，未来如需 InMemoryFileSystem（测试）或其他实现不必改契约。
- `cleanupOrphanedTemp` 是 `atomic.ts` 导出的自由函数，契约 §3 已登记为 free function 形态；由 Daemon 启动期调用，不纳入 interface 签名（interface 只描述实例能力；启动期一次性维护作为 free function 合理）。
- `FileSystemOptions.allowedPaths`（当前 interface 仍存在）：phase0 预留的 baseDir 外白名单扩展点，生产代码 0 消费者，仅测试引用。**契约不描述此字段**；后续 phase 一致性自检时评估是否可从 interface / `permissions.ts` / `node-fs.ts` 透传链与测试中一并删除。
- phase165 新增 `readBytesSync(path, start, end): Buffer`（字节安全范围读）——Stream reader 增量消费的字节/字符索引 mismatch 根因修复驱动；其他 L1 方法不变。

## 测试覆盖（验证行为契约）

- `tests/foundation/fs.test.ts`（22 `it`）：async/sync 双轨 read/write/append/delete/move/stat/exists/list/ensureDir/removeDir；`writeAtomic` temp+rename 崩溃残片；`writeExclusiveSync` EEXIST；`list` 简单 pattern；`cleanupOrphanedTemp` 残片扫除。
- `tests/foundation/path-permissions.test.ts`（22 `it`）：`resolve` 越界 `PathNotInClawSpaceError`；SYSTEM_PATHS 写入拒绝 `WriteOperationForbiddenError`；WRITABLE_PATHS 放行；`enforcePermissions=false` 关闭策略。

**覆盖缺口**：
- `IGNORE_PATTERN` 常量未被任何测试直接引用（仅 Snapshot 装配层消费）——若改名只能由 Snapshot 集成测试捕获 drift。
- 磁盘满 / 权限不足的原样抛 Node fs 错误路径未覆盖（依赖 OS 错误不易稳定触发）。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A ↔ §A 映射

本契约既有 "§与现状的差异" 节已承担 §7.A/§7.B 角色。**phase187 实测复核**（仅查 console / audit leak 维度）：

- `atomic.ts:162` `console.warn` cleanup orphaned temp 失败 —— **合规**（按 phase181 判据：cleanup 期非关键路径；主失败已走 throw；warn 仅记录辅助删除失败，不影响 Daemon 装配决策）
- `node-fs.ts` / `permissions.ts` / `types.ts` / `index.ts` 0 console 调用
- 0 audit 直接写入（职责边界正确：审计归调用方）

~~**§7.A 当前实然 = 零必修违规**。~~ — **2026-04-26 应然修订**：「零必修违规」结论仅基于 console / audit 维度。新应然（L1 = OS / fs API 抽象层，不 own 路径权限 / 启动清理 / agent 工具导出 / audit）暴露 4 项业务边界 leak：

**A.p320-1 — 路径越界守护 + 权限域检查 leak（应然归 FileTool L2）**

- 现状：FileSystem interface 暴露 `resolve(relativePath): string`（越界抛 `PathNotInClawSpaceError`）+ `enforcePermissions` 选项 + `permissions.ts` 内化 SYSTEM_PATHS / WRITABLE_PATHS / `WriteOperationForbiddenError`；§做 第 4-5 条
- 违反：modules.md L1 定位「不 own 权限 / 安全 / 路径限制（agent 业务 / L2 agent 语义 wrapper own）」+ M1 反向测试（fs OS 操作 vs agent 路径权限独立可变）+ M2 业务语义归属
- 风险：FileSystem 改 OS API 时被迫一并 review agent 权限语义；FileTool L2 复用 fs 时无法绕过隐式权限策略；跨 OS 适配（modules.md §POSIX 章）权限模型耦合在 L1 / 不 portable
- owner：phase0+
- 计划 phase：Stage 2（FileSystem 退化为纯 fs wrapper / FileTool L2 独立持权限域 + 越界守护 / `enforcePermissions=false` 等价于"L1 不再做"）
- 升档条件：跨 OS 适配启动 / 或 FileTool L2 模块化时

**A.p320-2 — 启动期临时残片清理 leak（应然归 Daemon / Assembly）**

- 现状：`atomic.ts` 导出 free function `cleanupOrphanedTemp(baseDir): Promise<void>` 遍历 `.tmp.*` 残片删除 / 由 Daemon 启动期调用；§接口 free function 节
- 违反：modules.md L1 定位「不 own 装配 / 生命周期编排（L6 装配 own）」+ M2 业务语义归属（启动期清理 = 装配期一次性副作用 / 不是 fs OS 能力）
- 风险：FileSystem 知道「.tmp.*」语义 = atomic write 私有约定 + 知道「启动期需清理」业务规则；如果未来 atomic write 改名（已 phase313 导出 IGNORE_PATTERN）/ 清理策略变化（保留 N 天 / 异步等）/ 装配方需要二次 control，逻辑都被绑死在 L1
- owner：phase0+
- 计划 phase：Stage 2（Daemon 或 Assembly own 清理 / 调 FileSystem `list` + `delete` 原语组合 / `cleanupOrphanedTemp` 移出 fs 模块）
- 升档条件：装配链路重构时

**A.p320-3 — 导出 read / write / search / ls agent 工具 leak（应然归 FileTool L2）**

- 现状：phase320 实测复核 — FileSystem 模块本身**未直接导出 agent 工具**（`list` / `read` 等是 fs 原语 / 非 ToolDefinition 形态）；本条登记为「应然原则记录」/ 用于防 drift 即未来误把 agent 工具 export 加进 fs 模块
- 违反（潜在）：modules.md L1 定位「不 own agent 工具导出」
- 状态：当前 = 合规（未实然 leak）/ 仅做应然边界声明 / 防回归
- owner：N/A
- 计划 phase：N/A（无消化动作 / 用作 phase reviewer 自检 anchor）

**A.p320-4 — audit 内化 leak（应然 caller 自己 audit）**

- 现状：phase320 实测复核 — FileSystem 0 audit 直接写入（节首 phase187 已实测）/ 当前 = 合规
- 应然：caller 自己 audit fs 操作；FileSystem 不持 audit 接口 / 不在异常路径调用 audit
- 状态：当前 = 合规 / 防 drift anchor

**§7.A 实然 = 2 条必修业务边界 leak（A.p320-1 / A.p320-2）+ 2 条防 drift anchor（A.p320-3 / A.p320-4）**。console / audit 维度仍 0 违规。

### 7.B ↔ §与现状的差异 节

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 §B 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - interface 单实现 / cleanupOrphanedTemp free function / `FileSystemOptions.allowedPaths` ghost / readBytesSync = **drift**
> - B.p187-1 IGNORE_PATTERN 已 phase313 清零 = **drift / 已闭环**
> - **A.p320-1 权限域内化（SYSTEM_PATHS/WRITABLE_PATHS）**（应然 §不可消除耦合 已注 / 待 §7.A 治理）= **drift / 高**：L1 sharpen v2 应然 OS 抽象 only / 实然 enforcePermissions 选项 + permissions.ts 在 L1 内 / 推 r43+ design phase（与 FileTool L2 协调迁移）
> - **A.p320-2 越界守护内化（resolveAndCheck）**（应然 §不可消除耦合 已注 / 待 §7.A 治理）= **drift / 高**：M1 独立可变冲突（混合路径解析 + 权限检查）/ 推 r43+
> - **A.p320-3 启动期 cleanupOrphanedTemp 暴露**（atomic.ts:150-172）= **drift / 中**：装配业务 leak L1 / 推 r43+
> - **B.p344-fs-1 console.warn at atomic.ts:164**（r43 A audit fork 第 7 轮新发现）= **drift / 低**：caller 自己 audit / L1 不应有 warn / 推 r43+
> - **B.p344-fs-2 PermissionError vs PathNotInClawSpaceError**（r43 A 新发现）= **drift / 低**：应抛 PathNotInClawSpaceError / 实然抛 PermissionError 通用类 / 推 r43+

既有 "§与现状的差异" 已登记 4 条偏差：interface 单实现 / `cleanupOrphanedTemp` free function 形态 / `FileSystemOptions.allowedPaths` ghost 字段 / `readBytesSync` phase165 新增。

phase187 补登记 1 条：

**B.p187-1 — `IGNORE_PATTERN` 常量契约承诺但未导出**

- 现状：`design/modules/l1_filesystem.md:125` 承诺 "通过 `IGNORE_PATTERN` 常量暴露给 Snapshot"；实测 `src/foundation/fs/atomic.ts` 无此导出，`src/foundation/fs/index.ts` 也未转出
- 违反：Coding Principle 命名节"同一概念用同一名字" + M7 耦合界面稳定（契约声明的对外接口与实现不一致）
- 风险：若 atomic.ts 未来把 `.tmp_` 前缀改名，Snapshot 装配层直接 hard-code 字面量会 drift 而 tsc 不报
- owner：phase0+（契约描述超前于实现）
- 计划 phase：顺手清理 —— `atomic.ts` 导出 `export const IGNORE_PATTERN = /^\.tmp_/`；Snapshot 装配层消费该常量
- 升档条件：若 Snapshot 集成测试确认 drift 已发生 → 升格 7.A

**phase313 消化**（2026-04-25 / SHA `ebf8958`）：`atomic.ts` 导出 `IGNORE_PATTERN = '.tmp_'`；`fs/index.ts` 转出。B.p187-1 清零。

### 7.C 原则对照（32 条）

全 32 条覆盖（Module Logic 11 + Design 11 + Philosophy 4 + Path 6）。深度按需。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。文件 I/O + 权限 + atomic write 三组职责内聚
- **M2 业务语义归属**：合规。由 FileSystem 直接 fs.promises 调用（核心业务语义不外包）
- **M3 资源归属**：合规。FileSystem 是磁盘资源访问的唯一路径（SYSTEM_PATHS / WRITABLE_PATHS 权限域归属）
- **M4 持久化**：无关（FileSystem 本身是持久化路径）
- **M5 依赖单向**：合规。foundation/fs → types/errors；无反向
- **M6 依赖结构稳定**：合规。interface 自 phase0 稳定，phase165 仅加 `readBytesSync` 为 non-breaking 扩展
- **M7 耦合界面稳定**：~~灰度（B.p187-1 `IGNORE_PATTERN` 契约承诺未导出）~~ → **合规**（phase302 导出后消除）
- **M8 耦合界面最小**：合规。interface 字段精选，无"为未来保留"
- **M9 显式表达编译器可检**：合规。`PermissionError` / `PathNotInClawSpaceError` / `WriteOperationForbiddenError` 命名 class；interface 强类型
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条，#1 展 4 面 / #6 展 2 面）

- **D1a 信息不丢失**：合规。所有 I/O 抛原生 Node fs 错（含 errno / path）原样暴露
- **D1b 状态可观察**：合规。interface 同步/异步双轨（fs.promises + sync 变体）；list / exists / readBytesSync 提供状态查询
- **D1c 中断可恢复**：合规。`writeAtomic` temp+rename 崩溃残片由 `cleanupOrphanedTemp` 装配期扫除
- **D1d 事后可审计**：无关（FileSystem 本身是审计文件的写入点，不自审计）
- **D2 不得丢弃/静默**：合规（atomic.ts:162 warn 合规；无软吞）
- **D3 用户可观察**：合规。同 D1b
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：合规。atomic write 保证磁盘一致性前提
- **D6a 决策主体**：无关（FileSystem 是基础设施，不做决策）
- **D6b 子代理不阻塞**：无关
- **D7 系统可信路径**：合规。permissions 强制 SYSTEM_PATHS 只读 / WRITABLE_PATHS 放行
- **D8 事件驱动**：无关（FileSystem 被调用，不发事件）
- **D9 多 claw 不隔绝**：无关（跨 claw 访问归上层）
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条 / r44 A.X 结构合规修：3→4 / 补 P4）

- **P1 上下文工程**：无关
- **P2 多 agent 复用**：合规。单一代码基，权限模型由 SYSTEM_PATHS / WRITABLE_PATHS 常量固化
- **P3 Agent 即目录 / 对话即状态**：合规。FileSystem 是 "Agent 即目录" 原语的实现
- **P4 系统为智能体服务**：合规。FileSystem 提供文件访问基础设施 / 不参与决策 / 仅路径解析 + 读写原语

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ 本 phase backfill 前 Read 源码 1165 行 + 测试 44 it
- **Path #2 差距显式登记**：✓ §与现状的差异 4 条 + phase187 补 1 条（B.p187-1）
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = 契约 backfill
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only；无破坏性
- **Path #5 完成后复盘**：将于 phase187 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#2（原 modules.md）FileSystem 权限域**：agentFs + trustedFs,白名单由 Daemon 注入

---

### 7.Phase 执行纪律

#### phase187 纪律 — L1 FileSystem backfill（2026-04-21，design 本地 only）

- **scope**：既有契约缺 §7.C 32-条原则对照 + §7.Phase 节，按 phase181 L3 模板补齐
- **产出**：§7.A 映射（零条，实测复核）/ §7.B 映射 + 补 B.p187-1 / §7.C 32 条 / §7.Phase（本节）
- **对比 phase181 L3 executor backfill**：
  - phase181 AgentExecutor 0 §7.A / StepExecutor 0 §7.A（降级回调合规）
  - phase187 FileSystem 0 §7.A（同类型"纯净 L1 原语"）—— 与 ProcessExec 形成"零软吞 L1"对比组
- **方法论贡献**：L1 契约 backfill 形态首批落地；保留既有 §A/§B 节不解构（Path #3 最小变更），仅补 §7.C + §7.Phase 增量价值

#### phase317 纪律 — 契约 drift 修订（r30 分支 C / 2026-04-25 / design only）

- **scope**：B.p187-1 消化 SHA 修正（假 SHA `2079eba` → 正确 `ebf8958` / phase302→313）
