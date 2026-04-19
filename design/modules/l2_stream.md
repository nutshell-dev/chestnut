# Stream 接口契约

L2 执行过程的实时观察窗口。服务于"用户可以观察运行过程中的所有状态"——把 agent 的思考、工具调用、LLM 往返、子代理生命周期等事件按时间序列落盘，供 TUI / CLI / watchdog 实时 tail 观察，也供事后审计重建运行时序。

归属：L2 基础设施。依赖：FileSystem（L1）、FileWatcher（L2，读侧用）、AuditLog（L2，必需——Phase 148 已从"可选"升级为必传，写侧 + 读侧均注入）。被调用（写侧）：Runtime、SubagentSystem、SubAgent、Snapshot、Daemon、Notify、CLI 命令。读侧：Gateway 正确通过 `StreamReader` 订阅；部分 CLI 消费者绕过 `StreamReader` 直接读文件路径，见"与现状的差异"A.1。

> 读侧的 audit 同时**透传**给 `StreamReader` 内部 `createWatcher(..., audit, ...)`——低层 watcher 回调 / onReady / onError 失败走 `WATCHER_*` 事件命名空间，不进 `STREAM_READER_*`。调用方读 audit.tsv 时需同时关注两套前缀。

## 职责边界

### 做

**写侧（StreamWriter）**：

1. `open()`：daemon 启动期归档现有 `stream.jsonl` 到 `logs/stream/stream.<now>.jsonl`，作为"session 边界"。归档失败降级：继续 append 到现有文件 + 写 `session_boundary, reason=archive_failed` 事件
2. `write(event)`：`JSON.stringify(event) + '\n'` appendSync 到 `stream.jsonl`。事件 schema 最小约束（`ts: number`、`type: string`，其他字段任意）
3. `close()`：标记关闭（无 flush；append 本身已同步落盘）
4. 归档裁剪：`open()` 时按 `maxFiles`（保留最新 N 份）+ `maxDays`（时间窗口）prune `logs/stream/`
5. 归档失败用"数据流内事件"暴露（`session_boundary, reason=archive_failed`）——让观察者知道数据完整性降级

**读侧（StreamReader）**：

6. `createStreamReader(fs, onEvent, audit)`：订阅 `stream.jsonl` 的新追加事件；基于 `FileWatcher` 的 `stability: 'immediate'` 监听文件变化，按 byte offset 增量读取、JSON.parse 每行后回调。保证 <50ms 事件延迟
7. `start()` 从当前文件尾 offset 起订阅（不 replay 历史）；`stop()` 关闭 watcher，idempotent
8. 文件被截断 / 替换（`size < offset`） → 自动 reset offset；文件 unlink → `audit.write(STREAM_READER_UNLINKED, ...)` + reset（Phase 148 由 console.error 升级）
9. `onEvent` 回调抛错 → `audit.write(STREAM_READER_CALLBACK_FAILED, ...)` 不冒泡（错误隔离）；JSON parse 失败 → `audit.write(STREAM_READER_PARSE_FAILED, ...)` 跳过该行（Phase 148 由 console.error 升级）

### 不做

- 不做事件 schema 校验（`type` 与其他字段对 Stream 是 opaque；消费者自定义）
- 不做历史 replay / 随机读（`StreamReader` 只跟新事件；需要历史的消费者另行处理——当前 CLI 直接读文件是过渡方案，见 A.1）
- 不做跨进程并发写协调（依赖 FS `appendSync` 原子性；同 claw 单 daemon 约定兜住）
- 不做压缩 / 加密
- 不做 session 语义（只知"open 时归档"，不知上一轮 session 为何结束、何时开始）

## 接口

```ts
interface StreamEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

// 写侧
interface StreamLog {
  /**
   * 写一条事件。ts 由调用方生成（各写入方在产生事件时取 Date.now()）。
   * type 标识事件类别，其他字段调用方自定义。
   * 未 open 时静默丢弃——见失败语义 A.2。
   */
  write(event: StreamEvent): void;
}

class StreamWriter implements StreamLog {
  constructor(
    fs: FileSystem,
    audit: Audit,                 // 必传；Phase 148 已修复
    retention?: { maxFiles?: number | null; maxDays?: number | null },
  );
  open(): void;                 // 归档旧 stream.jsonl + prune archives
  write(event: StreamEvent): void;
  close(): void;                // 标记关闭
}

// 读侧
interface StreamReader {
  start(): void;                // 从文件尾订阅；重复 start 抛错
  stop(): Promise<void>;        // idempotent
  isActive(): boolean;
}

function createStreamReader(
  fs: FileSystem,
  onEvent: (event: StreamEvent) => void,
  audit: Audit,                 // 必传；Phase 148 已修复
): StreamReader;
```

关键约定：
- **`ts` 由写入方传入**：与 AuditLog"时间戳归本模块独占生成"相反——Stream 事件的 `ts` 是业务事件发生时间，不同于审计记录的落盘时间，归调用方生成更准确
- **事件 schema 归调用方**：`type` 与其余字段由各写入方自定义；Stream 不协调 schema 命名空间
- **`open()` 是 daemon 生命周期绑定点**：每次 daemon 启动恰好一次；多次调用 idempotent（靠 `isOpen` 标志）
- **`close()` 不 flush**：`appendSync` 已同步落盘，不需要额外 flush
- **audit 必传（Phase 148）**：写侧 appendSync / archive / prune 失败，读侧 callback / parse / read / unlink / watcher error 均写结构化 audit 事件；不再走 console

### 工厂（装配期入口）

`src/foundation/stream/index.ts` 导出 `createStreamWriter`，是 Assembly / Runtime 装配期的推荐构造入口：

```ts
export function createStreamWriter(
  fs: FileSystem,
  audit: Audit,
  retention?: { maxFiles?: number | null; maxDays?: number | null },
): StreamWriter;
```

**行为承诺**：构造代理；与 `new StreamWriter(fs, audit, retention)` 完全等价——
- 不缓存、不单例：每次调用返回新实例
- 不注入默认值（默认归 ctor 本身）
- 不做参数校验 / 不触发副作用

装配方应通过工厂而非 `new` 构造，以便未来依赖组合扩展时单点修改。

## 失败语义

| 失败源 | Stream 行为 |
|---|---|
| `open()` 归档 move 失败 | `audit.write(STREAM_ARCHIVE_FAILED, ...)` + `session_boundary(reason=archive_failed)` 事件（Phase 148 由 console.error 升级） |
| `open()` 重复调用 | 第二次起 no-op（`isOpen` 守卫） |
| `write(event)` 未先 open | `audit.write(STREAM_WRITE_DROPPED, type=...)` 后 `return`，事件丢失（**A.2 部分修复**：audit 通路已通；完整"抛错 / ring buffer"决策留 Phase 150；**契约修复方向段与源码当前行为有分歧**——契约建议抛错，源码当前 drop + audit，统一到 Phase 150 收口） |
| `write(event)` `appendSync` 失败 | `audit.write(STREAM_APPEND_FAILED, type, message)`，事件丢失（**A.3 部分修复**：audit 通路已通；事件本体仍丢，同 A.2 归 Phase 150） |
| `pruneArchives` 列目录 / parse / 删除失败 | `audit.write(STREAM_ARCHIVE_PRUNE_FAILED, ...)`（Phase 148 由 console.warn 升级） |
| `StreamReader` 增量读取 FS 失败 | `audit.write(STREAM_READER_READ_FAILED, ...)`（Phase 148 由 console.error 升级） |
| `close()` | 纯状态切换，不抛 |
| `StreamReader.start()` 重复调用 | 抛 `Error('StreamReader already started')`（预期失败由调用方处理） |
| `StreamReader.stop()` 未 start | no-op，idempotent |
| `StreamReader` JSON.parse 单行失败 | `audit.write(STREAM_READER_PARSE_FAILED, line_prefix, reason)`（Phase 148 由 console.error 升级；parse 失败走**外层** try/catch——该行不再进入 callback，不会同时写 CALLBACK_FAILED） |
| `StreamReader` `onEvent` 抛错 | `audit.write(STREAM_READER_CALLBACK_FAILED, reason)` 隔离不冒泡（Phase 148 由 console.error 升级；位于 parse try **内层**——仅 JSON 合法时才会触发） |
| `StreamReader` 检测到 `unlink` | `audit.write(STREAM_READER_UNLINKED, ...)` + reset offset（Phase 148 由 console.error 升级） |
| `StreamReader` 检测到 `size < offset`（文件被截断 / 替换） | reset offset + pending 从 0 重新跟 |
| `StreamReader` watcher 层错误 | `audit.write(STREAM_READER_WATCHER_FAILED, ...)` + `active=false`（Phase 148 由 console.error 升级） |

## 不可消除的耦合

- **Stream → FileSystem（L1）**：显式依赖，构造注入
- **Stream ← 众多写入方（广连接但单向）**：多个 L3 / L4 模块通过 `StreamLog.write` 写同一 `stream.jsonl`。schema 命名空间由各写入方自己负责——Stream 不协调。与 AuditLog 广连接同构
- **`ts` 语义归调用方**：Stream 不生成时间戳，反映"业务事件时间不是落盘时间"的原则选择。显式登记
- **Stream → FileWatcher（L2，读侧依赖）**：`StreamReader` 通过 `createWatcher` 订阅 `stream.jsonl` 变化，传 `stability: 'immediate'`。显式依赖，读侧构造期内部调用。L2 → L2 跨子模块依赖显式允许
- **读侧路径泄漏**：Gateway 正确通过 `StreamReader` 订阅；但 CLI 消费者（claw.ts / chat-viewport.ts / watchdog.ts / daemon-loop.ts / watchdog-utils.ts）仍直接用 `stream.jsonl` 文件路径消费——**部分违反"每种资源只归属唯一模块"**。A.1 覆盖
- **`StreamCallbacks` 协议归 Stream 定义**：作为"执行过程事件的发布协议"，上游 StepExecutor / AgentExecutor / Runtime 通过此接口发布事件。签名变更驱动力在 Stream。显式登记（modules.md 已登记"定义的协议"字段）

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `STREAM_FILE = 'stream.jsonl'` | 内部硬编码 | 相对 fs 根；绝对路径由调用方装配 fs 时决定 |
| `ARCHIVE_DIR = 'logs/stream'` | 内部硬编码 | 同上 |
| `IGNORE_PATTERN` 导出 | **对外导出**（配合 Snapshot A.7 修复） | Stream 作为文件名的归属模块，对外导出供 Snapshot 装配 gitignore 聚合；消费方引用常量而非字面量，让编译器在 Stream 改名时捕获 drift |
| archive 文件名 `stream.<now>.jsonl` | 内部硬编码 | 调用方无法定制 |
| `retention.maxFiles` / `maxDays` | 调用方装配期传入 | null / undefined = 不裁剪 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 部分读侧消费者绕过 `StreamReader`，直接用文件路径消费 `stream.jsonl`** → **Phase 152 已修复（候选 α）**

违反原则：
- 模块逻辑"每种资源只归属唯一模块，其他模块通过该模块的对外入口间接访问"
- "耦合界面稳定"：绕过模块的消费者在内部实现（文件名、jsonl 格式、归档目录结构）变化时会连带改散落的 CLI 代码

**现状**：模块**已有** `StreamReader`（`createStreamReader`）读侧入口，Gateway 正确使用它。但 CLI 消费者仍走文件路径：
- `cli/commands/claw.ts`：读 `stream.jsonl` 末尾取 last-active 时间
- `cli/commands/chat-viewport.ts`：tail `stream.jsonl` 渲染 TUI
- `cli/commands/watchdog.ts` / `daemon-loop.ts` / `watchdog-utils.ts`：直接路径访问

**差距分析**：`StreamReader` 当前只订阅"新追加事件"（不 replay 历史、不提供随机读）。CLI 场景（last-active 时间、TUI 初始加载）需要**读历史 + 跟新增**的组合能力，`StreamReader` 当前接口不够——这是消费者绕过的技术原因。

修复候选：
- **候选 α**：`StreamReader` 扩 `start(options?: { fromOffset?: number | 'head' | 'tail' })`，支持从头回放；或加独立 `StreamHistoryReader` 接口
- **候选 β**：新增 `readRange(fromTs?, toTs?): StreamEvent[]` 同步历史读入口
- **候选 γ**：CLI 消费者改为装配 `StreamReader` + 独立历史读原语组合

**Phase 152 已修复**（候选 α 落地）：
- Stream 模块新增 `readAll(fs, audit): Promise<StreamEvent[]>` 历史读入口（`foundation/stream/reader.ts:40`，`index.ts` 导出）
- 文件名导出为 `STREAM_FILE` 常量（`foundation/stream/types.ts:8`），CLI 改 import 常量 + `readAll` / `createStreamReader`
- `claw.ts` / `watchdog-utils.ts` last-active 指标走 `readAll`；`chat-viewport.ts` tail 走 `createStreamReader`；`daemon.ts` / `motion.ts` / `contract.ts` 用 `STREAM_FILE` 消除字面量
- `utils/notify.ts` 的 `notifyStream` 一并裁撤（原本是 stream 旁路写入层，Phase 152 Step 3 并入 scope）
- `grep "'stream\.jsonl'" src/` 仅命中 `foundation/stream/types.ts` 的常量定义
残留：`chat-viewport.ts` 仍用 `path.join(clawDir, STREAM_FILE)` 构造路径喂 `createWatcher` —— 这是 FileWatcher 接口语义（收路径）的合理产物，不是资源归属违规。

**A.2 `write` 前未 `open()` 事件静默丢弃** → **Phase 148 部分修复**

**Phase 148 部分修复**：write 前调用已写 `STREAM_WRITE_DROPPED` 审计事件——audit 通路闭环；但"事件本体不得丢弃"完整语义（抛错 or 缓冲）留 Phase 150 失败语义原语收口。

违反原则（修复前）：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——事件进 `console.warn` 后丢弃
- "持久化一切信息到磁盘"——未落盘
- "事后可审计"——事件本身消失，无从重建

**修复方向**：`write` 在未 open 时抛 `Error('StreamWriter: write() called before open()')`。理由：
- 编码规范「预期失败由调用方显式处理」——daemon 启动期序错乱是调用方 bug，暴露而非吞没
- 不引入 ring buffer β 方案——"早于 open 的事件"在当前装配顺序下不是合理场景；若未来出现，应修装配顺序而非容忍该用法

**A.3 `appendSync` 写失败事件丢失** → **Phase 148 部分修复**

**Phase 148 部分修复**：`appendSync` 失败已写 `STREAM_APPEND_FAILED`；事件本体仍丢失，同 A.2 归 Phase 150。原"依赖全局结构化事件通道决策"已由 Phase 148 闭环（`AUDIT_EVENTS` 即该通道）。

违反原则（修复前）：同 A.2。事件已生成但未落盘，`console.error` 后返回——事件信息彻底丢失。

与 LLMService A.1 / AuditLog A.1 / Transport A.1 的"引入结构化事件通道"同构——但 Stream 自己就是事件通道，其自身的失败无处记录（递归边界，类似 AuditLog）。

**A.4 `retention.maxFiles: null / undefined / 0` 三种值同语义**

违反原则：命名一致性是接口契约的一部分；同一概念用同一名字。

修复方向：统一为 `maxFiles?: number`（`undefined` = 不裁剪）。删除 `null` / `0` 的特殊处理。

### B. 偏差登记（当前合理或代价过高）

- **`open()` 归档失败用数据流内事件（`session_boundary, reason=archive_failed`）暴露**：这是**正面设计决策**——用数据流自身报告数据流降级，符合"运行中状态可观察"。在失败语义表标注不作为违规
- **`StreamLog` interface 极薄**：仅 `write`；读侧拆到独立 `StreamReader`——写 / 读分离合理，但 `StreamReader` 能力不足见 A.1
- **`close()` 无 flush 操作**：`appendSync` 已同步；`close()` 只标记 `isOpen=false`。合理
- ~~`pruneArchives` 的裁剪失败只 warn~~ → Phase 148 已修复：`STREAM_ARCHIVE_PRUNE_FAILED`（裁剪失败 audit 化）
- **`ts` 由写入方传入**：与 AuditLog 相反；设计动机合理（事件发生时间 ≠ 落盘时间），但"多个写入方用不同时钟"理论上可能漂移——当前同进程内 `Date.now()` 无此风险，登记以防未来跨进程写
- **事件命名前缀非对称（写侧 `STREAM_*` / 读侧 `STREAM_READER_*`）**：StreamWriter 与 StreamReader 是两个独立 class，事件归属在 audit 流里以前缀精准区分——写侧失败归"数据入口"、读侧失败归"订阅链路"，诊断路径不同。对称化为 `STREAM_WRITER_*` 会冗长且语义无额外收益；去掉读侧 `_READER_` 会与潜在未来写侧 callback 事件命名冲突。**设计决策**：保留非对称，Phase 148 登记。

### C. 原则对照补充

- **"运行中状态可观察"**：Stream 是此原则的核心落实者 ✓（A.1 是读侧缺口）
- **"持久化一切信息到磁盘"**：appendSync 每条事件 ✓（A.2 / A.3 audit 通路 Phase 148 已修复，事件本体丢失 Phase 150）
- **"每种资源只归属唯一模块"**：`stream.jsonl` + `logs/stream/` 归 Stream ✓（Phase 152 已修复 A.1，CLI 读侧改走 `readAll` / `createStreamReader` + `STREAM_FILE` 常量）
- **"模块为自己的业务语义负责"**：Stream 只负责"按时间序列写事件 + 订阅新增"，不理解事件语义 ✓
- **"耦合界面稳定"**：`StreamLog.write` / `createStreamReader` 接口长期稳定；A.1 消费者绕过是**外部**未对齐，不是 Stream 自身破坏界面

## 测试覆盖（验证行为契约）

`tests/foundation/stream.test.ts`（写侧）+ `tests/foundation/stream_reader.test.ts`（读侧）：open/archive/prune/write/close 全路径；reader start/stop idempotent / 增量读取 / 截断 reset / onEvent 隔离。

**覆盖缺口**：
- A.1 架构边界测试（Phase 152 落地）：`grep "'stream\.jsonl'" src/` 仅命中 `foundation/stream/types.ts` 常量定义；CLI 全部走 `readAll` / `createStreamReader` / `STREAM_FILE`。历史读路径测试仍待补（`readAll` 单测覆盖）。
- A.2 修复后需补"未 open 时 write"的结构化行为断言（抛错 or ring buffer flush）
- A.3 修复后需补 `appendSync` 失败的旁路 emergency log 断言
- `IGNORE_PATTERN` 导出常量的消费测试（Snapshot 装配层引用 `Stream.IGNORE_PATTERN`，Stream 改名时编译期捕获 drift）
