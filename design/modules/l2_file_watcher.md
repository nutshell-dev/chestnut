# FileWatcher 接口契约

L2 文件系统变化通知原语。封装 chokidar，抹平多平台差异（inotify / FSEvents / polling），处理 `awaitWriteFinish` 稳定性等跨平台边界。不懂业务目录语义，不读文件内容。

**职责定位**：面向**持久化观察场景**的 FS 事件通知（含 100ms 稳定性窗口、polling 补漏、跨平台抹平），不面向所有 FS 事件诉求。短命 / 低延迟 watch 诉求通过 `stability: 'immediate'` 选项支持（候选 β 已实施）。

归属：L2 基础设施。依赖：FileSystem（L1，仅用 `resolve` 解析相对路径）、chokidar（外部依赖，视为"不可消除的外部协议适配"）。被调用：StreamReader（当前唯一核心消费者，传 `'immediate'`）。

归属：L2 基础设施。依赖：FileSystem（L1，仅用 `resolve` 解析相对路径）、chokidar（外部依赖，视为"不可消除的外部协议适配"）。被调用：StreamReader（当前唯一核心消费者）。

规划中应调用但未接入：Runtime、ContractSystem、Messaging；实际现状走 raw `fs.watch`，见"与现状的差异"A.1。

## 职责边界

### 做

1. `createWatcher(fs, relativePath, callback, audit, options?)`：基于 chokidar 创建 watcher；路径经 `fs.resolve` 解析为绝对路径
2. 事件映射：chokidar `add` / `change` / `unlink` / `addDir` / `unlinkDir` → 同名 `WatchEventType`；附带 `stats` 时提供 `{ size, mtime }` 到 `WatchEvent.stats`
3. Ready 信号：chokidar `ready` 事件（初始扫描完成）通过 `options.onReady` 回调暴露
4. 错误处理：chokidar `error` 事件 audit `watcher_error` + `options.onError` 回调（调用方可决策 degrade / alert）；callback / onReady / onError 抛错均被 try/catch 隔离
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
```

关键约定：
- **100ms 稳定性窗口（仅 stable 模式）**：`awaitWriteFinish.stabilityThreshold=100ms` 是**默认设计决策**——事件比实际文件变化晚最多 ~100ms；`stability: 'immediate'` 关闭此窗口，append-only 日志消费者（如 StreamReader）可获 <50ms 延迟
- **`ignoreInitial: true`**：watcher 启动时**不**对现有文件发 `add` 事件；调用方如需"初始状态扫描"要自己先 `fs.list`，再 `createWatcher` 跟增量
- **路径由 `fs.resolve` 解析**：`relativePath` 相对 `fs.root`；watcher 内部存的 `watchPath` 是绝对路径，`getPath()` 返回此值
- **chokidar 未识别事件静默丢弃**：`mapEventType` 返回 null → `on('all')` return；见 B 类登记
- **错误双通道**：chokidar `error` 触发 audit `watcher_error` 和 `onError` 回调——audit 是结构化事件流，onError 是调用方决策通道，两者不冗余

## 失败语义

| 失败源 | FileWatcher 行为 |
|---|---|
| chokidar 监听内部错误 | audit `watcher_error(path=..., reason=...)` + `options.onError?.(err)` 回调；watcher 状态未自动改变 |
| chokidar 发射未识别事件（非 5 种 `WatchEventType`） | `mapEventType` 返回 null，`on('all')` return 静默丢弃。**见 B 类登记** |
| `callback(event)` 调用方抛错 | audit `watcher_callback_failed(path=..., event=..., reason=...)`；callback 被隔离，后续事件继续触发（Phase 148 已修复） |
| `options.onReady` 抛错 | audit `watcher_ready_failed(path=..., reason=...)`；onReady 被隔离（Phase 148 已修复） |
| `options.onError` 抛错 | audit `watcher_error(path=..., context=onError_handler, reason=...)`；二级隔离（Phase 148 已修复） |
| `close()` 时 chokidar 抛错 | 原样抛出（Promise reject） |
| 重复 `close()` | no-op（靠 `active` 标志），第二次 Promise resolve |
| `createWatcher` 传入的 `relativePath` 不存在 | chokidar 会在对应路径出现时触发 `add`（chokidar 设计如此）——不是错误，不抛 |

## 不可消除的耦合

- **FileWatcher → FileSystem（L1）**：通过构造参数注入；仅用 `fs.resolve` 解析相对路径。显式依赖
- **FileWatcher → chokidar（外部依赖）**：FileWatcher 存在的核心理由就是把"chokidar 这个外部协议"的细节封装起来——跨平台 FS event 抽象本身是不可消除的外部耦合。chokidar 升级带来的行为变化（事件类型 / 参数 schema 变化）会穿透到本模块
- **FileWatcher ← StreamReader（当前唯一核心消费者）**：通过 `createWatcher` 函数调用，依赖方向单向
- **`awaitWriteFinish` 100ms 延迟契约**：调用方依赖此延迟保证"事件触发时文件已稳定"——这是模块对外承诺，未来改配置会破坏消费者。显式登记

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `relativePath` | 调用方传入 | 相对 `fs.root` |
| `options.recursive` | 调用方传入 | 默认 false |
| `options.ignored` / `onReady` / `onError` | 调用方传入 | 全 optional |
| `persistent: true` | 内部硬编码 | keep event loop alive；无对外开关 |
| `ignoreInitial: true` | 内部硬编码 | watcher 不对现有文件发 add 事件 |
| `awaitWriteFinish: { 100ms, 50ms }` | 内部硬编码（`stability: 'stable'` 默认） | 跨平台稳定性窗口；`'immediate'` 时关闭 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 CLI 消费者绕过 FileWatcher，直接用 Node 原生 `fs.watch`**

违反原则：
- 模块逻辑"每种资源只归属唯一模块，其他模块通过该模块的对外入口间接访问"——这里"资源"是"文件系统事件通知能力"，FileWatcher 是归属点
- "耦合界面稳定"：CLI 散落的 `fsNative.watch` 调用自己处理降级 fallback（"fs.watch failed, falling back to polling"），跨平台一致性、polling 补漏等能力被重复实现
- 编码规范"减少代码间的依赖：改一处不应连带改多处"：chokidar 跨平台语义变化 / 换 watch 实现现在会连带改 CLI 多处

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

**此违规属模块边界执行不一致**：按 Module Logic "模块设计中出现依赖问题就要停止当前任务先讨论模块重构"原则，修复应进独立重构 phase；当前契约负责把缺陷登记为已发现。

**A.2 `callback` / `onReady` / `onError` 抛错未被 FileWatcher 隔离**

**状态：Phase 148 已修复**

修复详情（Step 5）：
- `callback` 抛错 → audit `watcher_callback_failed(path=..., event=..., reason=...)`；try/catch 隔离，后续事件继续触发
- `onReady` 抛错 → audit `watcher_ready_failed(path=..., reason=...)`；try/catch 隔离
- `onError` 抛错 → audit `watcher_error(path=..., context=onError_handler, reason=...)`；二级 try/catch 隔离
- commit 锚点：`85ce00d..11fe6de`

违反原则（已修复）：
- "不可预期失败暴露而非吞没"——回调抛错从"穿透 chokidar 静默降级"变为"结构化 audit 事件 + 隔离继续" ✓

### B. 偏差登记（当前合理或代价过高）

- **chokidar 未识别事件静默丢弃**：`mapEventType` 返回 null → silently skip。当前 chokidar 版本只发 5 种，登记待未来升级时重新评估
- ~~错误双通道（`console.error` + `onError`）~~ → Phase 148 已修复：console.error 移除，仅保留 audit + onError 双通道（audit 是结构化事件流，onError 是调用方决策回调，不冗余）
- **`persistent: true` 不可开关**：内部硬编码，调用方无法要求"短命 watcher 不 keep event loop"。当前消费者都是 daemon 级长期监听，不需要，登记为已知限制
- **`ignoreInitial: true` 不可开关**：同上。调用方如需初始扫描要自己 `fs.list`。当前消费者均如此分工，但选项层缺失——名字没反映可不可开关这件事（违反"名字准确反映意图"次要表现），登记
- **唯一核心消费者是 StreamReader**：规划中的 Runtime / ContractSystem / Messaging 都未接入。这不是 FileWatcher 的问题，而是上层模块的设计演进问题——登记 `modules.md` 漂移待 Step 13 修
- **`modules.md` 索引层漂移**：L83 声明的调用方 Runtime / ContractSystem 都未实际使用 FileWatcher；inbox watch 在 CLI daemon-loop.ts 用 raw fs.watch。Step 13 统一修正

### C. 原则对照补充

- **"不可消除耦合显式表达"**：FS 依赖、chokidar 外部依赖、100ms 稳定性延迟均登记 ✓
- **"模块为自己的业务语义负责"**：FileWatcher 只负责"FS 事件通知"，不解析路径业务语义 ✓
- **"每种资源只归属唯一模块"**：FS 事件通知能力名义归 FileWatcher；CLI 绕过（A.1）❌
- **"耦合界面稳定最小"**：`Watcher` 接口仅 close / isActive / getPath；`createWatcher` 函数式入口 ✓
- **"名字准确反映意图"**：`recursive` / `ignored` 等选项清晰；但 `persistent` / `ignoreInitial` 硬编码不在选项层反映（B 类登记）
- **"减少代码间的依赖：改一处不应连带改多处"**：FileWatcher 目标是封装 chokidar 变化；A.1 因 CLI 绕过破坏此目标

## 测试覆盖现状

`tests/foundation/file-watcher.test.ts`（6 `it`）覆盖：
- callback 正常 add/change/unlink 事件
- callback 抛错隔离 → `watcher_callback_failed`，后续事件继续
- onReady 抛错隔离 → `watcher_ready_failed`
- chokidar error → `watcher_error`
- onError 回调抛错 → 二级 `watcher_error`
- close 幂等

**注**：跨平台 FS event 抽象的契约测试需要在 mac / linux 两平台跑；当前测试基础设施是否覆盖这点待 Step 13 审查。
