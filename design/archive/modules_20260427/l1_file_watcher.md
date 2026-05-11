# FileWatcher 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §6 align）：L1 OS / external 抽象层。chokidar wrap（inotify / FSEvents / ReadDirectoryChangesW 跨 OS 抽象）。FileWatcher 业务边界 = 「fs 变化通知 OS 原语」/ **不 own audit 业务**（M2 业务语义负责：fs watch 操作的可观察性是 caller 业务上下文 / 不是 fs watch 原语本身的业务）/ **不依赖任何其他 clawforum 模块**（L1 不依赖 L2+）。caller 拿到 raw `onError` / lifecycle callback 后按自己业务上下文 audit / `WATCHER_*` audit 事件命名空间应然归 caller / 不归 FileWatcher。

**实然**：~~FileWatcher 当前依赖 `FileSystem + AuditLog`（L1 → L2 反向 / drift）/ 接受 audit 注入 / 自己写 `WATCHER_READY` / `WATCHER_ERROR` / `WATCHER_CLOSE` / `WATCHER_UNLINK` 等事件 / 把 audit 业务 leak 进 FileWatcher 内部 — 应然层 leak 待 §7 登记 drift（待 Stage 2 治理：FileWatcher 砍 audit 注入 + 砍 FileSystem 依赖 + 暴露 raw `onError` / lifecycle callback / 各 caller 自己 bridge audit）。~~（**phase327 完全修复** — 见 §7.A A.3）当前实然：仅依赖 chokidar 外部 / 签名 `createWatcher(absolutePath, callback, options?)` / 错误经 `onError(err, context)` 单回调暴露 / 4 caller 各 bridge 自有 audit 命名空间。

L2 文件系统变化通知原语。封装 chokidar，抹平多平台差异（inotify / FSEvents / polling），处理 `awaitWriteFinish` 稳定性等跨平台边界。不懂业务目录语义，不读文件内容。

**职责定位**：面向**持久化观察场景**的 FS 事件通知（含 100ms 稳定性窗口、polling 补漏、跨平台抹平），不面向所有 FS 事件诉求。短命 / 低延迟 watch 诉求通过 `stability: 'immediate'` 选项支持（候选 β 已实施）。

归属：
- **应然**：L1 原语 / 装配归属「按需」/ **应然依赖无**（仅 chokidar 外部依赖）
- **实然**：~~当前 L2 / 依赖 `FileSystem + AuditLog`（drift / 见 §7）~~ → **phase327 修复后**：L1 / 仅 chokidar 外部依赖 / 与应然完全 align（见 §7.A A.3）

~~归属：L2 基础设施。依赖：FileSystem（L1，仅用 `resolve` 解析相对路径）、AuditLog（L2，必需——Phase 148 已从"可选"升级为必传）、chokidar（外部依赖，视为"不可消除的外部协议适配"）。被调用：StreamReader（当前唯一核心消费者，传 `'immediate'`）。~~

## 职责边界

### 做

1. `createWatcher(fs, relativePath, callback, audit, options?)`：基于 chokidar 创建 watcher；路径经 `fs.resolve` 解析为绝对路径
2. 事件映射：chokidar `add` / `change` / `unlink` / `addDir` / `unlinkDir` → 同名 `WatchEventType`；附带 `stats` 时提供 `{ size, mtime }` 到 `WatchEvent.stats`
3. Ready 信号：chokidar `ready` 事件（初始扫描完成）通过 `options.onReady` 回调暴露
4. 错误处理：chokidar `error` 事件 `audit.write(WATCHER_FAILED, ...)` + `options.onError` 回调（调用方可决策 degrade / alert）；Phase 148 已清除 console.error
5. `Watcher` 句柄：
   - `close()`：异步关闭 chokidar watcher，`active=false`；重复 close idempotent
   - `isActive()`：返回当前是否在监听
   - `getPath()`：返回解析后的绝对路径
6. 稳定性保证：**默认** `stability: 'stable'` → `awaitWriteFinish: { 100ms, 50ms }` 避免"写到一半触发"。`stability: 'immediate'` 关闭稳定性窗口，面向 append-only 日志类消费者（如 StreamReader）

### 不做

- 不解析业务目录语义（调用方告诉"watch 什么路径"，模块不懂路径背后是什么）
- 不读文件内容（`stats` 只有 size/mtime；内容读取归调用方）
- 不提供事件批处理 / 去重 / 节流（调用方按需做）
- 不做跨平台一致性保证之外的增强（chokidar 能力上限即本模块上限）
- 不做历史事件回放（watcher 从 `ignoreInitial: true` 起点监听；初始状态扫描归调用方）
- 不面向低延迟 / 短命 watch 场景（100ms 稳定性窗口是显式承诺；不需要此语义的消费者应另择方案）

## 接口

```ts
type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

interface WatchEvent {
  type: WatchEventType;
  path: string;                 // chokidar 报告的绝对路径
  stats?: { size: number; mtime: Date };
}

interface Watcher {
  close(): Promise<void>;        // idempotent
  isActive(): boolean;
  getPath(): string;             // 解析后的绝对路径
}

function createWatcher(
  fs: FileSystem,
  relativePath: string,
  callback: (event: WatchEvent) => void,
  audit: Audit,                 // 必传；Phase 148 已修复
  options?: {
    recursive?: boolean;         // 默认 false（depth: 0）；true → depth: undefined（全递归）
    ignored?: (string | RegExp)[];
    onReady?: () => void;        // 初始扫描完成信号
    onError?: (error: Error) => void;
    /**
     * Write finish stability strategy.
     * 'stable' (default): 100ms stabilityThreshold — safe for files being written over time.
     * 'immediate': emit on every FS event without stabilization — for append-only log tails.
     */
    stability?: 'stable' | 'immediate';
  },
): Watcher;

> **audit 必传（Phase 148）**：callback / onReady / onError 抛错在本模块 try/catch 隔离后写 `WATCHER_CALLBACK_FAILED` / `WATCHER_READY_FAILED` / `WATCHER_FAILED` 事件；chokidar `error` 事件亦走 audit（不再 `console.error`）。
```

关键约定：
- **100ms 稳定性窗口（仅 stable 模式）**：`awaitWriteFinish.stabilityThreshold=100ms` 是**默认设计决策**——事件比实际文件变化晚最多 ~100ms；`stability: 'immediate'` 关闭此窗口，append-only 日志消费者（如 StreamReader）可获 <50ms 延迟
- **`ignoreInitial: true`**：watcher 启动时**不**对现有文件发 `add` 事件；调用方如需"初始状态扫描"要自己先 `fs.list`，再 `createWatcher` 跟增量
- **路径由 `fs.resolve` 解析**：`relativePath` 相对 `fs.root`；watcher 内部存的 `watchPath` 是绝对路径，`getPath()` 返回此值
- **chokidar 未识别事件静默丢弃**：`mapEventType` 返回 null → `on('all')` return；见 B 类登记
- **错误双通道（Phase 148 已整改）**：chokidar `error` 同时走 `audit.write(WATCHER_FAILED, ...)` 和 `onError` 回调——audit 为观察通道（始终写）、`onError` 为处理通道（调用方可降级）。Phase 148 前 audit 通道为 `console.error`，已清除

## 失败语义

| 失败源 | FileWatcher 行为 |
|---|---|
| chokidar 监听内部错误 | `audit.write(WATCHER_FAILED, path, message)` + `options.onError?.(err)`（**Phase 148：console.error 已清除**） |
| chokidar 发射未识别事件（非 5 种 `WatchEventType`） | `mapEventType` 返回 null，`on('all')` return 静默丢弃。**见 B 类登记** |
| `callback(event)` 调用方抛错 | try/catch 隔离 + `audit.write(WATCHER_CALLBACK_FAILED, path, type, message)`（**Phase 148 已修复 A.2**） |
| `options.onReady` 抛错 | try/catch + `audit.write(WATCHER_READY_FAILED, path, message)`（**Phase 148 已修复 A.2**） |
| `options.onError` 抛错 | try/catch + `audit.write(WATCHER_FAILED, path=..., context=onError_handler, reason=...)`（**Phase 148 已修复 A.2**；与 chokidar 自身 error 同事件类型，用 `context` 列区分） |
| `close()` 时 chokidar 抛错 | 原样抛出（Promise reject） |
| 重复 `close()` | no-op（靠 `active` 标志），第二次 Promise resolve |
| `createWatcher` 传入的 `relativePath` 不存在 | chokidar 会在对应路径出现时触发 `add`（chokidar 设计如此）——不是错误，不抛 |

## 不可消除的耦合

- ~~**FileWatcher → FileSystem（L1）**：通过构造参数注入；仅用 `fs.resolve` 解析相对路径。显式依赖~~ — **应然作废**（L1 不依赖任何 clawforum 模块；audit / FS 解析归 caller）/ ~~实然 drift 待 §7 登记~~ → **phase327 完全修复**：caller 自 `fs.resolve(...)` 后传绝对路径
- **FileWatcher → chokidar（外部依赖）**：FileWatcher 存在的核心理由就是把"chokidar 这个外部协议"的细节封装起来——跨平台 FS event 抽象本身是不可消除的外部耦合。chokidar 升级带来的行为变化（事件类型 / 参数 schema 变化）会穿透到本模块
- ~~**FileWatcher ← StreamReader（当前唯一核心消费者）**：通过 `createWatcher` 函数调用，依赖方向单向~~ — **应然作废**（StreamReader 应然不依赖 FileWatcher / 见 l2_stream §3 应然）/ 实然 drift 待 §7 登记
- **`awaitWriteFinish` 100ms 延迟契约**：调用方依赖此延迟保证"事件触发时文件已稳定"——这是模块对外承诺，未来改配置会破坏消费者。显式登记

> ~~**AuditLog 依赖**：应然作废（audit 不归 FileWatcher）/ 实然 drift 待 §7 登记。~~ → **phase327 完全修复**：错误经 `onError(err, context)` 单回调暴露 / caller 自写 audit / 命名空间归各 caller 业务。

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| ~~`relativePath`~~ `absolutePath` | 调用方传入 | ~~相对 `fs.root`~~ → **phase327 修复**：caller 自 resolve / 直接传绝对路径（FileWatcher 不再依赖 FileSystem） |
| `options.recursive` | 调用方传入 | 默认 false |
| `options.ignored` / `onReady` / `onError` | 调用方传入 | 全 optional |
| `persistent: true` | 内部硬编码 | keep event loop alive；无对外开关 |
| `ignoreInitial: true` | 内部硬编码 | watcher 不对现有文件发 add 事件 |
| `awaitWriteFinish: { 100ms, 50ms }` | 内部硬编码（`stability: 'stable'` 默认） | 跨平台稳定性窗口；`'immediate'` 时关闭 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 CLI 消费者绕过 FileWatcher，直接用 Node 原生 `fs.watch`** → **Phase 152 已修复**

违反原则：
- 模块逻辑"每种资源只归属唯一模块，其他模块通过该模块的对外入口间接访问"——这里"资源"是"文件系统事件通知能力"，FileWatcher 是归属点
- "耦合界面稳定"：CLI 散落的 `fsNative.watch` 调用自己处理降级 fallback（"fs.watch failed, falling back to polling"），跨平台一致性、polling 补漏等能力被重复实现
- 编码规范"改一处不应连带改多处"：chokidar 跨平台语义变化 / 换 watch 实现现在会连带改 CLI 多处

**现状**：
- `cli/commands/chat-viewport.ts` 多处：`fsNative.watch(streamPath, ...)` 监听 stream.jsonl
- `cli/commands/daemon-loop.ts`：`fsNative.watch(inboxPendingDir, ...)` 监听 inbox 目录
- CLI 自己实现 "watch 失败退化到轮询" 的 fallback 逻辑

**同构于 Stream A.1**——本质是同一问题的两面：CLI 没有走 L2 原语的文件访问路径。

**职责定位澄清**：FileWatcher 面向**持久化观察场景**（含稳定性窗口、polling 补漏、跨平台抹平），不面向所有 FS 事件诉求。CLI 短命 watch（如"stream 文件有没有变过"）可能不需要 100ms 稳定性延迟——这种诉求分化是 A.1 修复 phase 要决策的点：要么 CLI 接受稳定性窗口改用 FileWatcher，要么 FileWatcher 扩配置支持低延迟模式。当前契约**不替未来 phase 选方案**，只登记决策要点。

修复候选：
- **候选 α**：CLI 改用 `createWatcher`；接受 100ms 稳定性窗口
- **候选 β**：FileWatcher 扩 `options.stability?: 'stable' | 'immediate'` 支持低延迟模式。**已实施**（StreamReader 路径传 `'immediate'`）；CLI 侧仍未迁移，保留 A.1 为 open item
- **候选 γ**：FileWatcher 提供更丰富的消费接口满足 CLI 场景（如 Stream A.1 的历史读诉求合并考虑）

**Phase 152 已修复**：CLI 侧 `fsNative.watch` / `fs.watch(` 全部清除，`chat-viewport.ts` / `daemon-loop.ts` 改用 `createWatcher(..., { stability: 'immediate' })`（候选 β 收敛）；CLI 自写的 watch→polling 降级逻辑一并删除，polling 补漏回归 FileWatcher 内部。`grep 'fsNative\.watch\|fs\.watch(' src/` 0 命中。FS 事件通知能力完全归 FileWatcher。

**A.2 `callback` / `onReady` / `onError` 抛错未被 FileWatcher 隔离** → **Phase 148 已修复**

**Phase 148 已修复**：callback / onReady / onError 均在 try/catch 中隔离，错误写 audit；无静默降级。

### B. 偏差登记（当前合理或代价过高）

- **chokidar 未识别事件静默丢弃**：`mapEventType` 返回 null → silently skip。当前 chokidar 版本只发 5 种，登记待未来升级时重新评估
- **错误双通道（`console.error` + `onError`）** → **Phase 148 已修复：console.error 已清除，改为 audit + onError 双通道（audit 为观察通道、onError 为处理通道）**
- **`persistent: true` / `ignoreInitial: true` 不可开关**：内部硬编码。"持久化观察"语义已在职责定位显式承诺——短命 / 初始扫描诉求不在本模块范围，调用方自己 `fs.list` 分工。选项层不反映这两项是与职责定位对齐的结果，登记为合理偏差
- **事件前缀简化为 `WATCHER_*` 而非 `FILE_WATCHER_*`**：audit.tsv 里 `watcher_*` 语义无歧义（项目内只有一类 watcher 概念）；`FILE_WATCHER_CALLBACK_FAILED` 冗长且无额外语义收益。**设计决策**：Phase 148 登记；若未来引入其他 watcher（如 process watcher / memory watcher），再回头评估是否需要 `FILE_WATCHER_*` 消歧。

### C. 原则对照补充

- **"不可消除耦合显式表达"**：FS 依赖、chokidar 外部依赖、100ms 稳定性延迟均登记 ✓
- **"模块为自己的业务语义负责"**：FileWatcher 只负责"FS 事件通知"，不解析路径业务语义 ✓
- **"每种资源只归属唯一模块"**：FS 事件通知能力归 FileWatcher ✓（Phase 152 已修复 A.1，CLI 绕过已清除）
- **"耦合界面稳定最小"**：`Watcher` 接口仅 close / isActive / getPath；`createWatcher` 函数式入口 ✓
- **"名字准确反映意图"**：`recursive` / `ignored` / `stability` 语义明确；`persistent` / `ignoreInitial` 硬编码由职责定位（持久化观察）反向约束，不作为选项暴露 ✓

## 测试覆盖（验证行为契约）

`tests/foundation/file_watcher.test.ts`：createWatcher 基本事件映射、close idempotent、stats 字段、stability 'immediate' vs 'stable' 分支、chokidar error 到 onError 回调透传、onReady 触发时机。

**覆盖缺口**：
- A.1 架构边界测试（Phase 152 落地）：`grep 'fsNative\.watch\|fs\.watch(' src/` 0 命中。
- A.2 修复后需补回调抛错被隔离的测试（callback 抛错、onReady 抛错、onError 抛错，后续事件仍正常 deliver）

---

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**当前未修复必修违规：零条**。

既有 §A 3 条皆已修复闭环：

| §A 条 | 状态 | 修复 phase | 佐证 |
|---|---|---|---|
| A.1 CLI 绕过 FileWatcher 直用 `fs.watch` | phase152 完全修复 | 152 | `grep 'fsNative\.watch\|fs\.watch(' src/` 0 命中；`chat-viewport.ts` / `daemon-loop.ts` 改用 `createWatcher(..., { stability: 'immediate' })` |
| A.2 callback/onReady/onError 抛错未隔离 | phase148 完全修复 | 148 | try/catch 隔离 + audit；无静默降级 |
| **A.3 FileWatcher 内化 audit + 依赖 FileSystem（L1→L2 反向 + L1→L1 横向）** | **phase327 完全修复**（main `da747c3` + `5373c94` + `cf5e545`）| 327 | `grep 'audit\.\|AUDIT_EVENTS' src/foundation/file-watcher/watcher.ts` 0 命中；`grep 'FileSystem\|fs/types' src/foundation/file-watcher/watcher.ts` 0 命中；signature 5→3 参数化（`createWatcher(absolutePath, callback, options?)`）；`onError(err, context: 'watch'|'callback'|'ready')` 单回调暴露；4 caller 各 bridge 自有命名空间（`STREAM_READER_WATCHER_*` / `TASK_PENDING_WATCHER_*` / `INBOX_WATCHER_*` / `CHAT_VIEWPORT_WATCHER_*`）/ AUDIT_EVENTS 旧 `WATCHER_CALLBACK_FAILED` / `WATCHER_READY_FAILED` / `WATCHER_FAILED` 三常量已删 |

### 7.B ↔ §与现状的差异 节

映射既有 §B 4 条偏差（保留不解构 + 升档条件）：

| §B 条 | 当前判定 | 升档条件 |
|---|---|---|
| chokidar 未识别事件静默丢弃 | 合规（当前 chokidar 只发 5 种） | chokidar 升级新增事件类型 → 重评 |
| 错误双通道（console + onError）| phase148 审定改为 audit + onError 双通道 | 如需外部订阅 error 流 → 扩第 3 通道 |
| `persistent: true` / `ignoreInitial: true` 硬编码 | 合规（与"持久化观察"职责定位对齐） | 出现"短命 watch + 初始扫描"场景 → 拆子类或扩 options |
| ~~事件前缀 `WATCHER_*` 而非 `FILE_WATCHER_*`~~ | ~~合规（phase148 审定，项目内只有一类 watcher）~~ | ~~引入 process watcher / memory watcher → 消歧~~ — **phase327 作废**：`WATCHER_*` 命名空间已删 / 事件由各 caller 自 own（如 `STREAM_READER_WATCHER_*`）/ 不再有 FileWatcher 内化的 audit 事件 |

### 7.C 原则对照（32 条，合规一行按需扩展）

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。单一职责 = chokidar 跨平台 FS 事件通知统一封装
- **M2 业务语义归属**：合规。`createWatcher` / `Watcher.close/isActive/getPath` 由 FileWatcher 发起
- **M3 资源归属**：合规。"FS 事件通知能力"归 FileWatcher；phase152 闭环；phase327 起 audit event 命名空间归各 caller（`STREAM_READER_WATCHER_*` / `TASK_PENDING_WATCHER_*` / `INBOX_WATCHER_*` / `CHAT_VIEWPORT_WATCHER_*`）
- **M4 持久化**：无关（FileWatcher 本身无状态持久化；订阅状态在内存）
- **M5 依赖单向**：合规。~~L2 FileWatcher → L1 FileSystem + chokidar 外部；无反向~~ → **phase327 修复后**：L1 FileWatcher 仅依赖 chokidar 外部 / 不依赖任何 clawforum 模块 / 应然 L1 干净达成
- **M6 依赖结构稳定**：合规
- **M7 耦合界面稳定**：合规。`Watcher` 接口仅 3 方法；`createWatcher` 函数 phase327 起稳定为 3 参数（path / callback / options）
- **M8 耦合界面最小**：合规。phase327 后 `createWatcher` 删 fs/audit 强制注入；`WatcherOptions` 精选字段（`recursive` / `ignored` / `stability` / `persistent` / `onReady` / `onError`）
- **M9 显式表达编译器可检**：合规。`stability: 'stable' | 'immediate'` 显式 discriminated
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面 = 14）

- **D1a 信息不丢失**：合规（A.2 phase148 隔离 + audit 闭环）
- **D1b 状态可观察**：合规。`Watcher.isActive` / `getPath` 查询
- **D1c 中断可恢复**：合规。`close()` idempotent + 测试覆盖
- **D1d 事后可审计**：合规。phase327 起 audit 事件由各 caller 自 own（FileWatcher 本身不写 audit / 错误经 `onError(err, context)` 暴露 / caller 写自己命名空间事件）/ 信号无丢失
- **D2 不得丢弃/静默**：合规
- **D3 用户可观察**：灰度（FileWatcher 本身是基础设施，不直接面对用户）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：无关（无持久化状态）
- **D6 智能体决策主体**：无关
- **D7 系统可信路径**：合规
- **D8 事件驱动**：**驱动**。FileWatcher 是事件驱动链路的源头
- **D9 多 claw 不隔绝**：无关（每 agent 独立 watcher 实例）
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规（FileWatcher 监控 agent dir 下文件）
- **P2 上下文工程**：无关
- **P3 多 agent 利用**：合规
- **P4 系统为智能体服务**：合规（FS 事件是 daemon 驱动的触发源）

#### Path Principles（6 条）

- **Path #1**：✓ phase148/152/327 修复 SHA 佐证
- **Path #2**：✓ §A 3 条皆标修复
- **Path #3**：✓ APPEND 不解构
- **Path #4**：本地 only 无破坏性
- **Path #5**：phase193 Step 5
- **Path #6**：触发 3 次（同 Stream）

### 7.Phase 执行纪律

#### phase193 纪律 — L2 FileWatcher backfill（2026-04-22，design 本地 only）

- **scope**：承 phase187 L1 模式，APPEND §7 四子节
- **产出**：§7.A 零条（A.1/A.2 皆闭环）/ §7.B 4 条映射 / §7.C 32 条 / §7.Phase（本节）
- **对比定位**：
  - **L2 纯通用组 2/3**（配套 Stream + AuditLog）
  - 修复模式: "CLI 绕过 → 统一原语 + 能力扩展"（候选 β `stability: 'immediate'` 落地避免 候选 α 的 100ms 延迟约束）
  - 与 Stream A.1 同构问题（FS 访问路径 vs FS 事件路径）；phase152 同 phase 修复（两侧共治）
- **方法论贡献**：L2 "候选 α/β/γ 多路径留候选；实施 phase 按 constraint 优选"模板样例（phase152 选候选 β 平衡 CLI 低延迟 + 模块收口）

#### phase327 纪律 — L1→L2 audit 解耦 + L1→L1 fs 解耦（2026-04-26，r34 B / Stage 2 P0 #1）

- **scope**：A.3 闭环 / FileWatcher 砍 audit + 砍 FileSystem 注入 / 4 caller bridge / audit event 命名空间散到 caller
- **产出**：
  - `createWatcher` 签名 5→3 参数（`(absolutePath, callback, options?)`）
  - `onError(err, context: 'watch' | 'callback' | 'ready')` 单回调（决策 #2 α）
  - 4 caller 自 bridge：StreamReader / TaskSystem / Daemon (waitForInbox) / chat-viewport (helper)
  - audit/events.ts 删 3 旧常量 + 各 caller 加 8 新常量（`*_WATCHER_FAILED` + `*_WATCHER_CALLBACK_FAILED` × 4）
  - main 3 commit：`da747c3` (Step 1 签名) / `5373c94` (Step 2-5 caller bridge) / `cf5e545` (Step 6 测试 + audit/events 清 + modules.md 注)
- **方法论贡献**：
  - **L1→L2 解耦 pattern**：caller bridge audit + 命名空间归发起方业务（M3）+ raw `onError(err, context)` 单回调（M8 耦合界面最小）
  - **决策 #1 命名空间分配模板**：选 α「各 caller 自有 prefix」/ Stage 2 后续 leak 模块（如 r34 C LLMService）直接复用
  - 与 phase328 (LLMService) 同 r34 / 同 pattern / 双 P0 接力实证 L1→L2 解耦模板可复用
- **历史教训登记**：phase327 实施期违 PR 1 phase = 1 commit 纪律（合 main 留 3 commit 未 squash）/ 见 r34 B 收官报告 / `feedback_pr_one_commit_rule` 升档候选
