# Stream 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md ~~§8~~ §7 align）：事件流的 schema + 读写 + 同进程 in-process pub/sub。Stream 业务边界 = 「事件流读写 + schema 解析」/ **不 own「跨进程实时通知」业务**。M1 反向测试：「事件流读写」vs「跨进程通知机制」独立可变（改 schema 不影响通知 / 改通知机制不影响 schema）；「跨进程通知」业务归 FileWatcher（fs watch）/ Stream **应然不依赖 FileWatcher**。跨进程订阅者自己 own FileWatcher 监听 `stream.jsonl` 追加 + 用 Stream 的 bytes → events[] 解析能力组合实现实时订阅。

**实然**：StreamReader 内化 fs watch（构造期 `createWatcher` 订阅 stream.jsonl 追加 + byte offset 增量读 + JSON.parse + onEvent callback）/ 把「跨进程通知」leak 进 Stream 内部 / 应然层 leak 待 §7 登记 drift（待 Stage 2 治理：StreamReader 退化为纯解析器 `parse(bytes) → events[]` / chat-viewport 等跨进程 reader 自己持 FileWatcher 调用 Stream 解析）。

L2 执行过程的实时观察窗口。服务于"用户可以观察运行过程中的所有状态"——把 agent 的思考、工具调用、LLM 往返、子代理生命周期等事件按时间序列落盘，供 TUI / CLI / watchdog 实时 tail 观察，也供事后审计重建运行时序。

归属：L2 基础设施。
- **应然依赖**：FileSystem（L1）、AuditLog（L2，必需——Phase 148 已从"可选"升级为必传，写侧 + 读侧均注入）
- **实然依赖**：FileSystem + AuditLog + **FileWatcher（L2，读侧 StreamReader 内化 fs watch / 应然移除 / drift 待 §7 登记）**

被调用（写侧）：所有需要发布执行过程事件的模块（持 StreamWriter 通过入口写 / 实然含 Runtime / SubagentSystem / SubAgent / Snapshot / Daemon / Notify / CLI 命令 / Assembly / TaskSystem / ContractSystem 等）。读侧：所有需要订阅或回放执行过程事件的模块（应然：跨进程订阅者自己 own FileWatcher + 用 Stream 解析；同进程订阅者用 Stream 提供的 in-process pub/sub callback）。实然：Gateway 通过 `StreamReader` 订阅；部分 CLI 消费者绕过 `StreamReader` 直接读文件路径，见"与现状的差异"A.1。

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

6. `createStreamReader(fs, streamPath, onEvent, audit)`：订阅 `streamPath`（相对 `fs.root`）的新追加事件；基于 `FileWatcher` 的 `stability: 'immediate'` 监听文件变化，按 byte offset 增量读取、JSON.parse 每行后回调。保证 <50ms 事件延迟。`streamPath` 由调用方显式传入——Stream 模块不假设 `fs.root` 语义（phase161 §M9 收口；典型值 `STREAM_FILE = 'stream.jsonl'`）
6.b `readAll(fs, streamPath, audit)`：一次性读取 `streamPath` 全部历史事件（< few MB），返 `Promise<StreamEvent[]>`。文件不存在返空数组；read 失败 audit + throw；单行 parse 失败 audit + skip
7. `start()` 从当前文件尾 offset 起订阅（不 replay 历史）；`stop()` 关闭 watcher，idempotent
8. 文件被截断 / 替换（`size < offset`） → 自动 reset offset；文件 unlink → `audit.write(STREAM_READER_UNLINKED, ...)` + reset（Phase 148 由 console.error 升级）
9. `onEvent` 回调抛错 → `audit.write(STREAM_READER_CALLBACK_FAILED, ...)` 不冒泡（错误隔离）；JSON parse 失败 → `audit.write(STREAM_READER_PARSE_FAILED, ...)` 跳过该行（Phase 148 由 console.error 升级）
9.b `start()` 时 `existsSync(streamPath) === false` → `audit.write(STREAM_READER_FILE_MISSING, path, reason=start_existsSync_false)` 一次性事件；watcher 仍照常建立（chokidar 等文件后续出现继续生效）。订阅链路最早环节有证据，避免错配 fs.root 时静默 silence

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

export interface StreamRetentionOptions {
  maxFiles?: number | null;
  maxDays?: number | null;
}

// 写侧
interface StreamLog {
  /**
   * 写一条事件。ts 由调用方生成（各写入方在产生事件时取 Date.now()）。
   * type 标识事件类别，其他字段调用方自定义。
   * 未 open 时抛 Error——见失败语义 A.2（phase298）。
   */
  write(event: StreamEvent): void;
}

class StreamWriter implements StreamLog {
  constructor(
    fs: FileSystem,
    audit: Audit,                 // 必传；Phase 148 已修复
    retention?: StreamRetentionOptions,
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
  streamPath: string,           // 相对 fs.root；Stream 不假设 fs.root 语义（phase161）
  onEvent: (event: StreamEvent) => void,
  audit: Audit,                 // 必传；Phase 148 已修复
  options?: { persistent?: boolean },
): StreamReader;

/** 历史读入口（phase152 引入；phase161 显式 streamPath） */
function readAll(
  fs: FileSystem,
  streamPath: string,
  audit: Audit,
): Promise<StreamEvent[]>;

/** LLM 输出事件类型集合（phase346 从 watchdog-utils 迁出） */
export const LLM_OUTPUT_EVENTS: Set<string>;
```

关键约定：
- **`ts` 由写入方传入**：与 AuditLog"时间戳归本模块独占生成"相反——Stream 事件的 `ts` 是业务事件发生时间，不同于审计记录的落盘时间，归调用方生成更准确
- **事件 schema 归调用方**：`type` 与其余字段由各写入方自定义；Stream 不协调 schema 命名空间
- **`open()` 是 daemon 生命周期绑定点**：每次 daemon 启动恰好一次；多次调用 idempotent（靠 `isOpen` 标志）
- **`close()` 不 flush**：`appendSync` 已同步落盘，不需要额外 flush
- **audit 必传（Phase 148）**：写侧 appendSync / archive / prune 失败，读侧 callback / parse / read / unlink / watcher error 均写结构化 audit 事件；不再走 console
- **`streamPath` 由调用方显式传入（phase161 §M9）**：StreamReader / readAll 不持有"fs.root 必须是 agent dir"的隐式假设；调用方对路径解析负全责。典型值用 `STREAM_FILE` 常量（`foundation/stream/types.ts:8`），让 tsc 在常量改名时捕获 drift

### 工厂（装配期入口）

`src/foundation/stream/index.ts` 导出 `createStreamWriter`，是 Assembly / Runtime 装配期的推荐构造入口：

```ts
export function createStreamWriter(
  fs: FileSystem,
  audit: Audit,
  retention?: StreamRetentionOptions,
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
| `write(event)` 未先 open | `throw Error('StreamWriter: write() called before open()')` —— 事件本体由 throw 传递给上层（phase298，替代 phase148 drop + audit） |
| `write(event)` `appendSync` 失败 | `audit.write(STREAM_APPEND_FAILED, type=, reason=, body=)` —— 事件内容完整进 emergency audit log（phase298 补全） |
| `pruneArchives` 列目录 / parse / 删除失败 | `audit.write(STREAM_ARCHIVE_PRUNE_FAILED, ...)`（Phase 148 由 console.warn 升级） |
| `StreamReader` 增量读取 FS 失败 | `audit.write(STREAM_READER_READ_FAILED, ...)`（Phase 148 由 console.error 升级） |
| `close()` | 纯状态切换，不抛 |
| `StreamReader.start()` 时 `streamPath` 不存在 | `audit.write(STREAM_READER_FILE_MISSING, path, reason=start_existsSync_false)` 一次性；watcher 照常建立等待文件出现（phase161） |
| `StreamReader.start()` 重复调用 | 抛 `Error('StreamReader already started')`（预期失败由调用方处理） |
| `StreamReader.stop()` 未 start | no-op，idempotent |
| `StreamReader` JSON.parse 单行失败 | `audit.write(STREAM_READER_PARSE_FAILED, line_prefix, reason)`（Phase 148 由 console.error 升级；parse 失败走**外层** try/catch——该行不再进入 callback，不会同时写 CALLBACK_FAILED） |
| `StreamReader` 连续 parse_failed 达阈值（consecutive ≥ 5 或近 10 次 parse 中 fail 占比 > 50%）| `audit.write(STREAM_READER_CORRUPT, path, consecutive, trigger=consecutive_fail\|ratio_high, recent_total, recent_fail)` + `active=false` + `watcher.close()`（fire-and-forget，不 await）；后续 readIncrement 调用哨兵返回。**不自动重建**——调用方通过 `isActive()===false` 感知或观察 audit 决策是否 `stop()`+ 新建实例（phase165） |
| `StreamReader` `onEvent` 抛错 | `audit.write(STREAM_READER_CALLBACK_FAILED, reason)` 隔离不冒泡（Phase 148 由 console.error 升级；位于 parse try **内层**——仅 JSON 合法时才会触发） |
| `StreamReader` 检测到 `unlink` | `audit.write(STREAM_READER_UNLINKED, ...)` + reset offset（Phase 148 由 console.error 升级） |
| `StreamReader` 检测到 `size < offset`（文件被截断 / 替换） | reset offset + pending 从 0 重新跟 |
| `StreamReader` watcher 层错误 | `audit.write(STREAM_READER_WATCHER_FAILED, ...)` + `active=false`（Phase 148 由 console.error 升级） |

## 不可消除的耦合

- **Stream → FileSystem（L1）**：显式依赖，构造注入
- **Stream ← 众多写入方（广连接但单向）**：多个 L3 / L4 模块通过 `StreamLog.write` 写同一 `stream.jsonl`。schema 命名空间由各写入方自己负责——Stream 不协调。与 AuditLog 广连接同构
- **`ts` 语义归调用方**：Stream 不生成时间戳，反映"业务事件时间不是落盘时间"的原则选择。显式登记
- ~~**Stream → FileWatcher（L2，读侧依赖）**：`StreamReader` 通过 `createWatcher` 订阅 `stream.jsonl` 变化，传 `stability: 'immediate'`。显式依赖，读侧构造期内部调用。L2 → L2 跨子模块依赖显式允许~~ — **2026-04-26 应然修订作废**：跨进程通知不归 Stream 业务（M1 反向测试 + M2 业务语义负责）/ Stream 应然不依赖 FileWatcher / 跨进程订阅者自己 own FileWatcher 调用 Stream 解析 / 实然 leak 待 §7 登记 drift
- **读侧路径泄漏**：Gateway 正确通过 `StreamReader` 订阅；但 CLI 消费者（claw.ts / chat-viewport.ts / watchdog.ts / daemon-loop.ts / watchdog-utils.ts）仍直接用 `stream.jsonl` 文件路径消费——**部分违反"每种资源只归属唯一模块"**。A.1 覆盖
- **`streamPath` 显式参数（phase161）**：StreamReader / readAll 接收 `streamPath: string`，调用方对"fs.root + streamPath 拼接结果是否真实指向 stream.jsonl"负全责。M9 收口——隐式约定 → 编译器可检参数
- **`StreamCallbacks` 协议归 Stream 定义**：作为"执行过程事件的发布协议"，上游 StepExecutor / AgentExecutor / Runtime 通过此接口发布事件。签名变更驱动力在 Stream。显式登记（modules.md 已登记"定义的协议"字段）
- **字节 vs 字符索引单位（phase165 M9 收口）**：`StreamReader` 增量读取涉及"字节偏移（与 `FileSystem.statSync().size` 匹配）+ 字符串行切分（`pending.indexOf('\n')`）"的联用。phase165 前 reader 用 `fs.readSync(): string` + `string.slice(byteOffset, byteSize)` 造成多字节 UTF-8 场景字节/字符单位混用错切（根因见 §A.5）。修复方案：`FileSystem.readBytesSync(path, start, end): Buffer`（字节安全范围读）+ `node:string_decoder.StringDecoder` 跨 chunk 解码缓冲。显式登记：reader 闭包内 `offset: 字节` / `pending: 字符串（decoder 产出）` / `buf: Buffer（字节容器）` 三种变量单位在注释和 §A.5 中说明，编译期由 Buffer 与 string 类型区分（M9 优先编译器可检）。

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `STREAM_FILE = 'stream.jsonl'` | **对外导出**（phase152 / phase161） | 文件名归 Stream，但路径解析归调用方：StreamReader / readAll 通过 `streamPath` 参数显式接收（phase161 §M9）；调用方典型用 `STREAM_FILE` 常量传入，让 tsc 在改名时捕获 drift |
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

**phase161 进一步收口（M9）**：
- `createStreamReader` / `readAll` 签名加 `streamPath: string` 必传，消除"fs.root 必须是 agent dir"的隐式约定
- 新增 `STREAM_READER_FILE_MISSING` 启动期探测事件，让"调用方传错 fs / 路径"从 silent return 升级为 audit 告警
- 调用点全部跟随：`assemble.ts:371`（systemFs/STREAM_FILE）、`chat-viewport.ts:457/471`（taskFs/fs + STREAM_FILE，并修复 L64 `createDirContext(options.baseDir)` → `options.agentDir` 根因 bug）、`claw.ts:46`、`watchdog-utils.ts:26`
- A.1 候选 α 完整闭环：CLI 既不绕过资源归属，也不依赖隐式 fs.root 约定

**A.2 `write` 前未 `open()` 事件静默丢弃** → **Phase 298 完全修复（throw）**

**Phase 148 部分修复**：write 前调用已写 `STREAM_WRITE_DROPPED` 审计事件——audit 通路闭环；但"事件本体不得丢弃"完整语义留 Phase 150 收口。

**Phase 298 完全修复**：`write()` 在未 open 时抛 `Error('StreamWriter: write() called before open()')`；调用方 bug 强制暴露，不吞没。

违反原则（修复前）：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——事件进 `console.warn` 后丢弃
- "持久化一切信息到磁盘"——未落盘
- "事后可审计"——事件本身消失，无从重建

修复理由：编码规范「预期失败由调用方显式处理」——daemon 启动期序错乱是调用方 bug，暴露而非吞没；不引入 ring buffer——"早于 open 的事件"在当前装配顺序下不是合理场景。

**A.3 `appendSync` 写失败事件丢失** → **Phase 298 完全修复（audit body 保全）**

**Phase 148 部分修复**：`appendSync` 失败已写 `STREAM_APPEND_FAILED`；事件本体仍丢失，归 Phase 150 收口。

**Phase 298 完全修复**：`audit.write(STREAM_APPEND_FAILED, type=, reason=, body=)` 补 `type` + `body` 字段，事件内容完整进 emergency audit log。

违反原则（修复前）：同 A.2。事件已生成但未落盘，`console.error` 后返回——事件信息彻底丢失。

与 LLMService A.1 / AuditLog A.1 / Transport A.1 的"引入结构化事件通道"同构——但 Stream 自己就是事件通道，其自身的失败无处记录（递归边界，类似 AuditLog）。

**A.4 `retention.maxFiles: null / undefined / 0` 三种值同语义** → **降级 §7.B（phase317 drift 修订 / 命名一致性偏差非软吞 / 不丢信息）**

违反原则：命名一致性是接口契约的一部分；同一概念用同一名字。

修复方向：统一为 `maxFiles?: number`（`undefined` = 不裁剪）。删除 `null` / `0` 的特殊处理。

降级理由：A 类标准是「软吞/丢信息/不可恢复」/ A.4 是命名一致性偏差 / 不丢信息 / 不软吞 / 属 B 类。

**A.5 `StreamReader` 增量读字节/字符索引 mismatch（phase164 observability 发现，phase165 修复）** → **Phase 165 已修复**

违反原则：
- **M9「不可消除耦合显式表达，优先编译器可检」**：`fs.readSync(path): string` 返回 UTF-16 string，`fs.statSync(path).size` 返回字节数；两者以 `string.slice(byteOffset, byteSize)` 联用时对多字节 UTF-8 文件（中文 / emoji）错切——隐式单位约定，tsc 不可检
- **Design「未经显式设计决策不得丢弃或静默忽略」**：reader 连续 37 次 `STREAM_READER_PARSE_FAILED` 但行为不变（继续 work），上层消费者（chat-viewport）感知不到；audit 事件写了但无升级机制
- **连锁后果**：事件流大规模丢失 → handleEvent 未被调 → Spinner `Thinking...` 从未启动 → TUI 缺失 text_delta / tool_result 渲染 → 用户体验"TUI 卡"、"回复不完整"（phase164 chat-viewport audit 暴露）

**Phase 165 修复**：
- FileSystem L1 扩 `readBytesSync(path, start, end): Buffer` 字节安全范围读（Step 1）
- `STREAM_READER_CORRUPT` audit 事件（Step 2）
- reader 切 `readBytesSync + StringDecoder('utf-8')`——offset 保持字节累加，pending 由 decoder 产出字符，行切分在 string 上做（Step 3）
- 连续 parse_failed 升级 corrupt + 停订阅——硬化「不静默」原则（Step 4）
- 字节/字符单位区分登记 §不可消除的耦合（Step 5，本 Step）

**验证**：
- `tests/foundation/stream-reader.test.ts` 新增多字节 UTF-8 incremental 单元（phase165 Step 7）+ 连续 parse_failed 升级单元（Step 8）
- `tests/e2e/chat-viewport-regression.test.ts` 6 条基线（phase165 Step 9-15）——从此 chat-viewport / reader / pi-tui 相关 PR 合并前强制跑过

### B. 偏差登记（当前合理或代价过高）

- **`open()` 归档失败用数据流内事件（`session_boundary, reason=archive_failed`）暴露**：这是**正面设计决策**——用数据流自身报告数据流降级，符合"运行中状态可观察"。在失败语义表标注不作为违规
- **`StreamLog` interface 极薄**：仅 `write`；读侧拆到独立 `StreamReader`——写 / 读分离合理，但 `StreamReader` 能力不足见 A.1
- **`close()` 无 flush 操作**：`appendSync` 已同步；`close()` 只标记 `isOpen=false`。合理
- ~~`pruneArchives` 的裁剪失败只 warn~~ → Phase 148 已修复：`STREAM_ARCHIVE_PRUNE_FAILED`（裁剪失败 audit 化）
- **`ts` 由写入方传入**：与 AuditLog 相反；设计动机合理（事件发生时间 ≠ 落盘时间），但"多个写入方用不同时钟"理论上可能漂移——当前同进程内 `Date.now()` 无此风险，登记以防未来跨进程写
- **事件命名前缀非对称（写侧 `STREAM_*` / 读侧 `STREAM_READER_*`）**：StreamWriter 与 StreamReader 是两个独立 class，事件归属在 audit 流里以前缀精准区分——写侧失败归"数据入口"、读侧失败归"订阅链路"，诊断路径不同。对称化为 `STREAM_WRITER_*` 会冗长且语义无额外收益；去掉读侧 `_READER_` 会与潜在未来写侧 callback 事件命名冲突。**设计决策**：保留非对称，Phase 148 登记。

### C. 原则对照补充

- **"运行中状态可观察"**：Stream 是此原则的核心落实者 ✓（A.1 是读侧缺口）
- **"持久化一切信息到磁盘"**：appendSync 每条事件 ✓（A.2 / A.3 phase298 完全闭环：throw + body 保全）
- **"每种资源只归属唯一模块"**：`stream.jsonl` + `logs/stream/` 归 Stream ✓（Phase 152 已修复 A.1，CLI 读侧改走 `readAll` / `createStreamReader` + `STREAM_FILE` 常量）
- **"模块为自己的业务语义负责"**：Stream 只负责"按时间序列写事件 + 订阅新增"，不理解事件语义 ✓
- **"耦合界面稳定"**：`StreamLog.write` / `createStreamReader` 接口长期稳定；A.1 消费者绕过是**外部**未对齐，不是 Stream 自身破坏界面
- **"不可消除耦合显式表达，优先编译器可检" (M9)**：phase161 `streamPath` 显式参数是第一层 M9 收口（fs.root 路径 → 参数化）；phase165 `readBytesSync` Buffer 返回 + StringDecoder 是第二层收口（字节/字符单位 → 类型区分）。两层 ✓；A.5 phase165 闭环前仍违规

## 测试覆盖（验证行为契约）

**单元（`tests/foundation/stream-reader.test.ts`）**：open/archive/prune/write/close 全路径；reader start/stop idempotent / 增量读取 / 截断 reset / onEvent 隔离；**多字节 UTF-8 incremental 不错位（phase165 Step 7，3 it）**；**连续 parse_failed 升级 STREAM_READER_CORRUPT（phase165 Step 8，2 it，consecutive_fail + ratio_high 双分支）**。

**e2e 回归基线（phase165 Step 9-15 产出）**：`tests/e2e/chat-viewport-regression.test.ts`——6 条 chat-viewport 回归基线（1 骨架 + 6 基线 = 7 it）：
- 基线 1：多字节 UTF-8 incremental（chunk 边界拆中文 / emoji）
- 基线 2：完整 turn + Spinner lifecycle（Thinking + tool_name + elapsed）
- 基线 3：连续 10×tool_call/result 不漏（防 `[4/100]` 回归）
- 基线 4：连续 ≥5 畸形 JSON 触发 corrupt + 停订阅 + 哨兵
- 基线 5：VIEWPORT_* 写 agentDir/audit.tsv（防 baseDir 归属漂回）
- 基线 6：Spinner start/stop 配对 + elapsed_ms 一致（±100ms）

**CI 维护义务**：凡 PR 动 `src/foundation/stream/reader.ts` / `src/cli/commands/chat-viewport*.ts` / `createMainTurnUI` —— CI 必须跑 `tests/e2e/chat-viewport-regression.test.ts` 全绿；基线用例语义不可删改（`feedback_test_delete_requires_justification`）。

**legacy 保留**：`tests/e2e/chat-viewport-subscribe.test.ts`（phase165 Step 16 删 phase161 it 1 冗余；保留 phase161 it 2 STREAM_READER_FILE_MISSING 防线 + phase162 scope 隔离 5 it）；`tests/cli/chat-viewport-observability.test.ts`（phase164 observability 工厂单元，5 it）。

**覆盖缺口**：
- A.1 架构边界测试（phase152 落地）：`grep "'stream\.jsonl'" src/` 仅命中 `foundation/stream/types.ts` 常量定义；CLI 全部走 `readAll` / `createStreamReader` / `STREAM_FILE`
- 残留缺口：`readAll` 单测仍未补（phase152 引入时跳过；建议下个触碰 readAll 的 phase 顺手）
- ~~A.2 修复后需补"未 open 时 write"的结构化行为断言~~ → phase298 已补（`toThrow` 断言）
- ~~A.3 修复后需补 `appendSync` 失败的旁路 emergency log 断言~~ → phase298 已补（body/type 字段断言）
- `IGNORE_PATTERN` 导出常量的消费测试（Snapshot 装配层引用 `Stream.IGNORE_PATTERN`，Stream 改名时编译期捕获 drift）

---

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**当前未修复必修违规：1 条**（A.6）。

既有 §A 条目修复闭环（按 phase181/187 判据：软吞 → 必修；已修复则零条 ≠ 缺漏）：

| §A 条 | 状态 | 修复 phase | 佐证 |
|---|---|---|---|
| A.1 CLI 绕过 `StreamReader` | phase148/152/161 三层闭环 | 148 / 152 / 161 | `grep "'stream\.jsonl'" src/` 仅 `types.ts` 常量；CLI 全走 `readAll` / `createStreamReader` + `STREAM_FILE`；`streamPath` 显式参数化 |
| A.2 write 前未 open 丢弃 | **phase298 完全修复（throw）** | 148 / 298 | phase148 audit 通路；phase298 `throw new Error('StreamWriter: write() called before open()')` —— 事件本体由 throw 强制上层处理 |
| A.3 appendSync 失败丢失 | **phase298 完全修复（audit body 保全）** | 148 / 298 | phase148 STREAM_APPEND_FAILED audit；phase298 补 `type=` + `body=` 字段，事件内容进 audit emergency log |
| A.4 retention.maxFiles 三值同语义 | 未修复（§7.B 合规偏差方向） | — | 降级为 B 类"命名冗余"（未来统一 `undefined`），非软吞 |
| A.5 字节/字符 mismatch | phase165 完全修复 | 165 | `readBytesSync + StringDecoder('utf-8')`；`STREAM_READER_CORRUPT` 升级事件 + 停订阅；`tests/e2e/chat-viewport-regression.test.ts` 6 基线 |
| **A.6 chokidar FSEvents 静默停火** | **未修复** | — | 见下 |

**A.6 诊断详情**（2026-04-27 viewport 卡住实测）：

- **现象**：chat-viewport 渲染中途卡住 / streaming cursor `▋` 残留 / 不再更新 / 用户可见输出不完整
- **根因**：macOS FSEvents backend 下 chokidar `stability: 'immediate'` 对 `stream.jsonl` 快速连续 append 静默停止触发 `change` callback。StreamReader 100% 依赖 chokidar watcher 驱动 `readIncrement()` / 无 fallback poll / watcher 停火 = 事件链断裂
- **证据**：`stream.jsonl` 尾行含完整 `text_end` + `turn_end`（数据完整落盘）；`audit.tsv` 最后 viewport 事件为 `viewport_render_batch` 后静默 / 无 `STREAM_READER_*` / 无 `WATCHER_*` 错误（chokidar 不报停火）
- **影响面**：**软吞**（D1a 信息不丢失 / D2 不得静默丢弃）。事件已落盘但未送达消费者 / 无错误信号 / 用户不可知。跨进程 StreamReader 全量受影响（chat-viewport / CLI / 任何 `createStreamReader` 消费者）
- **修复方向**：StreamReader.start() 内增 `setInterval`（建议 500ms）定期调 `readIncrement()` 作 fallback poll / chokidar 正常时 `readIncrement()` 返回 0 事件（无开销）/ chokidar 停火时 fallback 接管事件交付 / stop() 时 clearInterval

### 7.B ↔ §与现状的差异 节

映射既有 §B 6 条偏差（保留不解构，各条附升档条件）：

| §B 条 | 当前判定 | 升档条件 |
|---|---|---|
| `open()` 归档失败用数据流内事件 | 正面设计决策（合规） | 如未来需要硬中断，则升级为错误 |
| `StreamLog` interface 极薄 | 合理（写/读分离） | 若 A.1 候选 γ（拆 `StreamHistoryReader`）落地则扩面 |
| `close()` 无 flush | 合理（`appendSync` 已同步） | 如切异步 append 则必须 flush |
| `ts` 由写入方传入 | 合理（事件发生时间 ≠ 落盘） | 跨进程写出现漂移 → 升为 A 类 |
| 事件命名前缀非对称（`STREAM_*` / `STREAM_READER_*`）| 保留（phase148 审定） | 引入其他 `_READER_` 事件 → 再评 |
| A.4 `retention.maxFiles` 三值同语义 | 合规偏差（待统一） | 用户配置错导致 runtime bug → 升 A |

### 7.C 原则对照（32 条，合规一行按需扩展）

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。单一职责 = 时间序列事件写 + 订阅新增
- **M2 业务语义归属**：合规。`StreamLog.write` / `createStreamReader` / `readAll` 全由 Stream 发起；消费方不遍历 jsonl 自解析
- **M3 资源归属**：合规。`stream.jsonl` + `logs/stream/` 归 Stream 独占；phase152/161 闭环
- **M4 持久化**：合规。`appendSync` 每条事件落盘
- **M5 依赖单向**：合规。L2 Stream → L1 FileSystem + 共享 types；无反向
- **M6 依赖结构稳定**：合规。`StreamLog` / `StreamReader` / `StreamEvent` 自 phase148+ 稳定
- **M7 耦合界面稳定**：合规。`write` / `createStreamReader` / `readAll` / `STREAM_FILE` 常量四面稳定
- **M8 耦合界面最小**：合规。`StreamLog` 仅 `write` / `close`；`StreamReader` 仅 `start` / `stop`；`readAll` 函数式入口
- **M9 显式表达编译器可检**：**phase161/165 两层收口合规**。`streamPath: string` 显式消除 `fs.root` 隐式约定；`readBytesSync: Buffer` + `StringDecoder` 显式字节/字符单位区分
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面 = 14）

- **D1a 信息不丢失**：**A.6 drift**（A.2/A.3 phase298 闭环 / A.6 chokidar 静默停火导致事件已落盘但未送达消费者 / 待修）
- **D1b 状态可观察**：合规。`readAll` 历史 + `createStreamReader` 增量双入口
- **D1c 中断可恢复**：合规。纯追加磁盘为权威态；重启后 `readAll` 重建
- **D1d 事后可审计**：合规。A.5 phase165 闭环 + e2e 基线
- **D2 不得丢弃/静默**：**A.6 drift**（同 D1a / A.6 chokidar 静默停火 = 无错误信号的静默丢失 / 待修）
- **D3 用户可观察**：合规（`chat-viewport` TUI 从 stream.jsonl 渲染）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：合规。stream.jsonl 纯追加 + logs/stream/ 归档
- **D6 智能体决策主体**：无关（基础设施）
- **D7 系统可信路径**：合规
- **D8 事件驱动**：**驱动原则**。Stream 是事件驱动的核心设施
- **D9 多 claw 不隔绝**：灰度（每 agent 独立 stream.jsonl；跨 agent 事件消费由消费方聚合）
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规（stream.jsonl 在 agent dir）
- **P2 上下文工程**：合规（事件流是 agent 执行历史的权威来源）
- **P3 多 agent 利用**：合规（每 agent 独立事件流）
- **P4 系统为智能体服务**：**驱动**（TUI / chat-viewport / 审计皆从 Stream 消费）

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ phase148/152/161/165 修复 SHA 逐条佐证
- **Path #2 差距显式登记**：✓ §A 5 条皆标"phaseN 已修复"
- **Path #3 语义一致最小变更单元**：✓ 本 phase APPEND 不解构既有 §A/§B/§C
- **Path #4 可回滚 + 破坏性论证**：design 本地 only；无破坏性
- **Path #5 完成后复盘**：phase193 Step 5
- **Path #6 冲突立即中断**：触发 3 次（phase190/191/192 占号）

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#10（原 modules.md）Stream + AuditLog 拆分**：Stream(实时观察)服务于"状态可观察",AuditLog(事后审计)服务于"全量审计",独立可变  
  关联模块：l2_audit_log.md（cross-ref / 主登记在本模块）

---

### 7.Phase 执行纪律

#### phase317 纪律 — 契约 drift 修订（r30 分支 C / 2026-04-25 / design only）

- **scope**：A.4 `retention.maxFiles` 从 §7.A 降级至 §7.B（命名一致性偏差非软吞/不丢信息）

#### phase298 纪律 — Phase 150 失败语义原语 Stream A.2/A.3 真清零（r26 分支 B / 2026-04-25）

- **scope**：`writer.ts` write() 双修（A.2 throw + A.3 audit body 保全）+ 测试 3 文件改写（tests/foundation/ + tests/cli/ stream-writer.test.ts）
- **A.2**：`audit.write(STREAM_WRITE_DROPPED) + return` → `throw Error('StreamWriter: write() called before open()')`；调用方核：assemble.ts open() 先于 write() / task/system.ts optional chaining 正常路径不触发
- **A.3**：`audit.write(STREAM_APPEND_FAILED, reason=)` → 补 `type=` + `body=` 字段；事件本体进 emergency audit log
- **N1（计划外）**：`tests/cli/stream-writer.test.ts` 亦含同语义 it（A.2 not.toThrow + A.3 无 body 断言）→ 同步改写（正确处置）
- **§7.A 状态**：A.2/A.3 全部升为"完全修复"；Stream §7.A 5/5 全清零（A.1 phase148/152/161 / A.2 phase148+298 / A.3 phase148+298 / A.4 B类 / A.5 phase165）
- **§7.C cascade**：D1a / D2 "部分合规" → "合规"
- **SHA**：`f6ba12e`

#### phase193 纪律 — L2 Stream backfill（2026-04-22，design 本地 only）

- **scope**：既有契约缺 §7 四子节正式结构，按 phase187 L1 模式补齐（APPEND 不解构既有 §A/§B/§C）
- **产出**：§7.A 零条 / §7.B 6 条映射 / §7.C 32 条 / §7.Phase（本节）
- **对比定位**：
  - **L2 纯通用组 1/3**（配套 FileWatcher + AuditLog）
  - 与 FileWatcher（A.1/A.2 皆修复）共组"双层修复闭环" L2 样本
  - 与 AuditLog（A.1 审定保留递归边界）对照：Stream 是事件通道**消费者**，AuditLog 是事件通道**终点**，两者 recursion 边界不同（Stream 自身失败可走 audit；AuditLog 自身失败走 console）
- **方法论贡献**：L2 模块"phase148+ 治理已闭环 → §7.A 零条 ≠ 缺漏"判据第 2 次验证（phase187 L1 ProcessExec / MessageCodec / FileSystem 立范；本 phase 3 模块再次验证）

### 7.编号 drift 表

| modules.md 实然 § | 本契约 § | delta | 说明 |
|---|---|---|---|
| §7 | §7（含子节 7.A/7.B/7.C/7.D/7.Phase） | 0 | modules.md §7 = Stream / 本契约 §7 同步 |
