# Stream 接口契约

L2 执行过程的实时观察窗口。服务于"用户可以观察运行过程中的所有状态"——把 agent 的思考、工具调用、LLM 往返、子代理生命周期等事件按时间序列落盘，供 TUI / CLI / watchdog 实时 tail 观察，也供事后审计重建运行时序。

归属：L2 基础设施。依赖：FileSystem（L1）、FileWatcher（L2，读侧用）。被调用（写侧）：Runtime、SubagentSystem、SubAgent、Snapshot、Daemon、Notify、CLI 命令。读侧：Gateway 正确通过 `StreamReader` 订阅；部分 CLI 消费者绕过 `StreamReader` 直接读文件路径，见"与现状的差异"A.1。

## 职责边界

### 做

**写侧（StreamWriter）**：

1. `open()`：daemon 启动期归档现有 `stream.jsonl` 到 `logs/stream/stream.<now>.jsonl`，作为"session 边界"。归档失败降级：继续 append 到现有文件 + 写 `session_boundary, reason=archive_failed` 事件
2. `write(event)`：`JSON.stringify(event) + '\n'` appendSync 到 `stream.jsonl`。事件 schema 最小约束（`ts: number`、`type: string`，其他字段任意）
3. `close()`：标记关闭（无 flush；append 本身已同步落盘）
4. 归档裁剪：`open()` 时按 `maxFiles`（保留最新 N 份）+ `maxDays`（时间窗口）prune `logs/stream/`
5. 归档失败用"数据流内事件"暴露（`session_boundary, reason=archive_failed`）——让观察者知道数据完整性降级

**读侧（StreamReader）**：

6. `createStreamReader(fs, onEvent)`：订阅 `stream.jsonl` 的新追加事件；基于 `FileWatcher` 的 `stability: 'immediate'` 监听文件变化，按 byte offset 增量读取、JSON.parse 每行后回调。保证 <50ms 事件延迟
7. `start()` 从当前文件尾 offset 起订阅（不 replay 历史）；`stop()` 关闭 watcher，idempotent
8. 文件被截断 / 替换（`size < offset`） → 自动 reset offset；文件 unlink → `console.error` 报告 + reset
9. `onEvent` 回调抛错 → `console.error` 不冒泡（错误隔离）；JSON parse 失败 → `console.error` 不冒泡（跳过该行）

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
  audit: Audit,                   // 必传；Step 5 透传至 FileWatcher
): StreamReader;
```

关键约定：
- **`ts` 由写入方传入**：与 AuditLog"时间戳归本模块独占生成"相反——Stream 事件的 `ts` 是业务事件发生时间，不同于审计记录的落盘时间，归调用方生成更准确
- **事件 schema 归调用方**：`type` 与其余字段由各写入方自定义；Stream 不协调 schema 命名空间
- **`open()` 是 daemon 生命周期绑定点**：每次 daemon 启动恰好一次；多次调用 idempotent（靠 `isOpen` 标志）
- **`close()` 不 flush**：`appendSync` 已同步落盘，不需要额外 flush

## 失败语义

| 失败源 | Stream 行为 |
|---|---|
| `open()` 归档 move 失败 | audit `stream_archive_failed(reason=...)`；继续 append 到现有 `stream.jsonl`；write `session_boundary, reason=archive_failed` 事件让观察者知道降级（Phase 148 已修复） |
| `open()` 重复调用 | 第二次起 no-op（`isOpen` 守卫） |
| `write(event)` 未先 open | audit `stream_write_dropped(type=...)`；事件不写入文件（Phase 148 已修复） |
| `write(event)` `appendSync` 失败 | audit `stream_append_failed(reason=...)`；事件丢失但后续 write 继续尝试（Phase 148 已修复） |
| `pruneArchives` 列目录 / parse 失败 | audit `stream_archive_prune_failed(reason=...)`；继续主流程（Phase 148 已修复） |
| `pruneArchives` 删除单文件失败 | audit `stream_archive_prune_failed(path=..., reason=...)`；继续下一个（Phase 148 已修复） |
| `close()` | 纯状态切换，不抛 |
| `StreamReader.start()` 重复调用 | 抛 `Error('StreamReader already started')`（预期失败由调用方处理） |
| `StreamReader.stop()` 未 start | no-op，idempotent |
| `StreamReader` 增量读取 FS 失败 | audit `stream_reader_read_failed(reason=...)`；继续下次触发（Phase 148 已修复） |
| `StreamReader` JSON.parse 单行失败 | audit `stream_reader_parse_failed(line_prefix=..., reason=...)`；跳过该行继续解析后续（Phase 148 已修复） |
| `StreamReader` `onEvent` 回调抛错 | audit `stream_reader_callback_failed(reason=...)`；不冒泡（错误隔离）；其他事件继续（Phase 148 已修复） |
| `StreamReader` 检测到 `size < offset`（文件被截断 / 替换） | reset offset + pending 从 0 重新跟 |
| `StreamReader` 检测到 `unlink` | audit `stream_reader_unlinked(path=stream.jsonl)` + reset offset（Phase 148 已修复） |
| `StreamReader` watcher 层错误 | audit `stream_reader_watcher_failed(reason=...)` + 置 `active=false`（`isActive()` 反映降级）（Phase 148 已修复） |

## 不可消除的耦合

- **Stream → FileSystem（L1）**：显式依赖，构造注入
- **Stream ← 众多写入方（广连接但单向）**：多个 L3 / L4 模块通过 `StreamLog.write` 写同一 `stream.jsonl`。schema 命名空间由各写入方自己负责——Stream 不协调。与 AuditLog 广连接同构
- **`ts` 语义归调用方**：Stream 不生成时间戳，反映"业务事件时间不是落盘时间"的原则选择。显式登记
- **Stream → FileWatcher（L2，读侧依赖）**：`StreamReader` 通过 `createWatcher` 订阅 `stream.jsonl` 变化，传 `stability: 'immediate'`。显式依赖，读侧构造期内部调用。L2 → L2 跨子模块依赖显式允许
- **读侧路径泄漏**：Gateway 正确通过 `StreamReader` 订阅；但 CLI 消费者（claw.ts / chat-viewport.ts / watchdog.ts / daemon-loop.ts / watchdog-utils.ts）仍直接用 `stream.jsonl` 文件路径消费——**部分违反"每种资源只归属唯一模块"**。A.1 覆盖

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `STREAM_FILE = 'stream.jsonl'` | 内部硬编码 | 相对 fs 根；绝对路径由调用方装配 fs 时决定 |
| `ARCHIVE_DIR = 'logs/stream'` | 内部硬编码 | 同上 |
| archive 文件名 `stream.<now>.jsonl` | 内部硬编码 | 调用方无法定制 |
| `retention.maxFiles` / `maxDays` | 调用方装配期传入 | null / undefined = 不裁剪 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 部分读侧消费者绕过 `StreamReader`，直接用文件路径消费 `stream.jsonl`**

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

**此违规属模块边界不完整而非实现偏差**：按 Module Logic "模块设计中出现依赖问题就要停止当前任务先讨论模块重构"原则，修复应进独立模块重构 phase，不混在契约补齐 phase 中。当前契约只负责**把此缺陷登记为已发现**，为未来重构 phase 提供起点。

**A.2 `write` 前未 `open()` 事件静默丢弃** → **Phase 148 已修复**

修复详情（Step 6）：
- `write` 未 open → audit `stream_write_dropped(type=...)`；事件不写入文件
- commit 锚点：`185da37..fcee4a6`

违反原则（修复前）：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——事件进 `console.warn` 后丢弃
- "持久化一切信息到磁盘"——未落盘
- "事后可审计"——事件本身消失，无从重建

剩余 open 项：
- 未 open 时是否抛错（候选 α）或 ring buffer（候选 β）——Phase 148 保留 audit 化但不改抛出语义，留 Phase 150 决策

**A.3 `appendSync` 写失败事件丢失** → **Phase 148 已修复**

修复详情（Step 6）：
- `appendSync` 失败 → audit `stream_append_failed(reason=...)`；事件丢失但后续 write 继续尝试
- commit 锚点：`185da37..fcee4a6`

违反原则（修复前）：同 A.2。事件已生成但未落盘，`console.error` 后返回——事件信息彻底丢失。

剩余 open 项：
- 与 AuditLog A.1 同构（递归边界），Phase 148 保留 audit 化；旁路 emergency log（候选 α）或 `write` 返回 boolean（候选 β）留 Phase 150 决策

### B. 偏差登记（当前合理或代价过高）

- **`open()` 归档失败用数据流内事件（`session_boundary, reason=archive_failed`）暴露**：这是**正面设计决策**——用数据流自身报告数据流降级，符合"运行中状态可观察"。在失败语义表标注不作为违规
- **`retention.maxFiles: null` 与 `undefined` / `0` 语义冗余**：三种值都表示"不裁剪"，违反"名字准确反映意图"。未来可统一
- **`StreamLog` interface 极薄**：仅 `write`；读侧拆到独立 `StreamReader`——写 / 读分离合理，但 `StreamReader` 能力不足见 A.1
- **`close()` 无 flush 操作**：`appendSync` 已同步；`close()` 只标记 `isOpen=false`。合理
- **`pruneArchives` 的裁剪失败只 warn**：裁剪是"清理"类副作用失败，不影响主数据流；但单文件 / 列目录失败都走 `console.warn` 而非结构化事件——与 A.3 同构但优先级低
- **`ts` 由写入方传入**：与 AuditLog 相反；设计动机合理（事件发生时间 ≠ 落盘时间），但"多个写入方用不同时钟"理论上可能漂移——当前同进程内 `Date.now()` 无此风险，登记以防未来跨进程写
- **`modules.md` 索引层漂移**：L96 写"写入、实时流订阅、历史读取"——订阅 / 读取在代码里不存在。Step 13 统一修正

### C. 原则对照补充

- **"运行中状态可观察"**：Stream 是此原则的核心落实者 ✓（A.1 是读侧缺口）
- **"持久化一切信息到磁盘"**：write 事件通过 append 落盘 ✓（A.2 / A.3 是缺口）
- **"事后可审计"**：stream.jsonl + 归档 `logs/stream/` 支持事后 tail / grep 重建 ✓
- **"中断可恢复"**：Stream 事件流是 Runtime 启动期恢复决策链路的重要输入（AgentExecutor 重放 tool_use 状态前需要看到上次运行的事件序列）——整个事件归档机制支持此原则 ✓
- **"模块为自己的业务语义负责"**：Stream 只负责"事件按时序落盘"，不理解事件语义 ✓
- **"每种资源只归属唯一模块"**：stream.jsonl 名义归 Stream；Gateway 正确通过 `StreamReader` 访问 ✓；CLI 消费者绕过（A.1）❌
- **"耦合界面稳定最小"**：写侧 `StreamLog` 仅 `write` ✓；读侧 `StreamReader` 仅 start / stop / isActive ✓；但读侧能力不覆盖"历史读"需求，导致 CLI 绕过（A.1）

## 测试覆盖现状

`tests/cli/stream-writer.test.ts`（3 个 `it`）覆盖写侧 open / write / 归档基础路径。未见独立 `StreamReader` 测试——读侧由 Gateway 集成测试间接覆盖。

**注**：A.1 / A.2 / A.3 修复 phase 需补：未 open 时的行为断言、write 失败的可观察性断言、`StreamReader` 的 truncate/unlink/JSON 错误等边界断言、历史读扩展接口的契约测试。当前覆盖明显不足，登记为测试欠账。
