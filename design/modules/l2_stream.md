# Stream 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2b.md](../interfaces/l2b.md) Stream 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §10「Stream 本质：执行过程事件流服务 / L2 LLM 语义基础设施 / 在 L1 FileSystem 之上把执行过程事件流封装成可重用基础服务 / Stream 知 LLM 协议层 event types / 不知 agent 业务（不绑 agent identity）」加 M#1 / M#2 / M#3 / M#4 / Design Principle「状态可观察」加「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Stream 的单一职责 = **执行过程事件流追加写加订阅加回放的统一入口**：

- **事件追加写**：write 单事件 / append-only 持久化 — 事件不可篡改加严格时序（D「不丢弃 / 静默」derive）。
- **事件订阅加回放**：增量订阅新追加事件 + 全量回放历史 — 让事后审计加跨进程 observability 可达（D「事后可审计」加「状态可观察」derive）。
- **session 边界归档**：daemon 启动期归档现有 stream.jsonl 到 archive — 跨 session 历史可保留（不删除原则）。
- **字节安全 parse 内部封装**：StringDecoder 跨 chunk UTF-8 边界 parse 在 StreamReader 内部 / 不暴露公共 parseBytes 方法（应然 silent on 公共 API / 跨进程订阅经 createStreamReader 工厂 own FileWatcher 间接订阅）。
- **corruption 防护**：连续 parse 失败达阈值 → 标记 corrupt + audit + 关闭 watcher / 不自动重建 / 调用方决策。

> 具体 API 形态归 [interfaces/l2b.md](../interfaces/l2b.md) Stream 节。具体实现细节（StreamWriter / StreamReader / readAll 拆分加 byte offset 增量读加 session 归档归命名 等）的存在依据是「事件流读写 + schema 解析 + pub/sub」原语 — 实然采纳的细节差异（如 LLM_OUTPUT_EVENTS Set 跨模块共享 / byte offset 字节安全）登记 §7.B。

### 不做

- **不 own 任何 clawforum agent 业务概念**（不知 agent / claw / motion / sub-agent identity 等业务）— derive 自 M#2 业务语义归属（Stream 业务语义仅事件流原语级）加 M#5 单向依赖
- **不 own 业务事件 schema**（type 加 fields 对 Stream opaque / schema 命名空间归各写入方业务模块）— derive 自 M#2
- **不 own agent 身份关联**（事件归属哪个 claw 归调用方决定）— derive 自 M#2
- **不 own 跨进程实时通知**（跨进程订阅者自己 own FileWatcher 监听 stream.jsonl 追加 + 用本模块 parseBytes 解析）— derive 自 M#1 独立可变职责 + M#5
- **不 own session 语义**（只知 open 时归档 / session 时长加触发条件归调用方）— derive 自 M#2
- **不 own 跨进程并发写协调**（依赖 FS appendSync 原子性 / 同 claw 单 daemon 约定兜住）— derive 自 M#1
- **不 own 加密 / 签名 / 压缩**（消费者侧 / 安全层职责）— derive 自 M#1
- **不 own 归档清理策略**（archive/ 保留窗口加清理触发归运维）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Stream 的业务语义边界：

- **own**：执行过程事件流读写 + 解析 + 订阅原语 — write / read / subscribe / parseBytes / archive 等。这些是 Stream 唯一懂的「业务」（事件流原语级，不是 clawforum agent 业务级）。
- **角色定位**：Stream 是「**通用 generic event stream**」非「**业务事件解读器**」。多 caller publish 同一 stream / schema 归各 caller 自治 / Stream 仅保证 ts + type 最小约束加 append-only 不可篡改。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Stream 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<clawDir>/stream.jsonl` | 当前 session 事件流（独占 / 纯追加 JSONL）| ✓ appendSync |
| `<clawDir>/logs/stream/stream.<ts>.jsonl` | 归档 session 边界 | ✓ |

**执行过程事件流持久化加订阅入口** — clawforum 内部任何事件流的发布+订阅+回放必经 Stream 间接访问 / 是 stream.jsonl 跨进程 observability 通道唯一调用入口。

> 注：type-level 资源 `STREAM_FILE: 'stream.jsonl'` 常量（消费者引用 / 改名 tsc 自动捕获 drift）+ `LLM_OUTPUT_EVENTS: Set<string>` 跨模块共享（M#9 不可消除耦合显式 / 实施细节 / 非 M#3 业务资源）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Stream 持久化整个事件流（append-only JSONL）— 是 clawforum 「事后可审计」加「状态可观察」双原则的关键 artifact（用户加跨进程订阅者经事件流回放重建任一时刻执行状态）。

### 磁盘布局

```
<clawDir>/
├── stream.jsonl                ← 当前 session 事件流（纯追加 JSONL）
└── logs/stream/
    ├── stream.<ts>.jsonl       ← 归档 session 边界
    └── ...                     ← 按 retention.maxFiles / maxDays 裁剪
```

### 文件格式

每行一个 JSON 对象 / `\n` 结尾：

```jsonl
{"ts": 1234567890, "type": "text_delta", "content": "..."}
{"ts": 1234567891, "type": "tool_call", "name": "read", ...}
```

### 重建语义

- 进程重启：`open()` 归档当前 stream.jsonl → `logs/stream/stream.<now>.jsonl` / 新 session 从空文件开始
- 历史读：`readAll(fs, streamPath, audit)` 一次性读全部 / 文件不存在返 []
- 增量订阅：`createStreamReader` 从当前文件尾 offset 起 / 不 replay 历史
- 文件 truncate / replace：reader 检测 `size < offset` 自动 reset offset
- 文件 unlink：reader 写 `STREAM_READER_UNLINKED` audit + reset offset

## 5. 审计事件清单

事件常量集中定义于 `STREAM_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

### 写侧事件

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `STREAM_APPEND_FAILED` | write 时 appendSync 失败 | `type=<event.type>`, `reason=...`, `body=<JSON>` |
| `STREAM_ARCHIVE_FAILED` | open 时归档 move 失败 | `from=`, `to=`, `reason=` |
| `STREAM_ARCHIVE_PRUNE_FAILED` | open 时归档裁剪失败 | `dir=`, `reason=` |
| `session_boundary`（数据流内事件 / 非 audit）| 归档失败 | `reason=archive_failed` |

### 读侧事件

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `STREAM_READER_FILE_MISSING` | start 时 streamPath 不存在 | `path=`, `reason=start_existsSync_false` |
| `STREAM_READER_READ_FAILED` | 增量读 fs 失败 | `path=`, `reason=` |
| `STREAM_READER_PARSE_FAILED` | 单行 JSON.parse 失败 | `line_prefix=<≤80 字符>`, `reason=` |
| `STREAM_READER_CORRUPT` | 连续 parse_failed 阈值触发 | `path=`, `consecutive=`, `trigger=consecutive_fail\|ratio_high`, `recent_total=`, `recent_fail=` |
| `STREAM_READER_CALLBACK_FAILED` | onEvent 抛错 | `reason=` |
| `STREAM_READER_UNLINKED` | 检测到 unlink | `path=` |
| `STREAM_READER_WATCHER_FAILED` | watcher 层错误（caller bridge 自 FileWatcher）| `path=`, `reason=` |
| `READER_WATCHER_FAILED` | FileWatcher onError context='watch' | `path=`, `reason=` |
| `READER_WATCHER_CALLBACK_FAILED` | FileWatcher onError context='callback' | `path=`, `type=`, `reason=` |

> 写侧 `STREAM_*` / 读侧 `STREAM_READER_*` 命名前缀非对称：StreamWriter / StreamReader 是两个独立 class / audit.tsv 中以前缀区分诊断路径（数据入口 vs 订阅链路）。

## 6. 层级声明

L2 LLM 语义基础设施层（与 DialogStore / LLMOrchestrator / ToolProtocol 同子层 / 事件流读写原语 / 知 LLM 协议层 event types / 不绑 agent business identity）。下游所有需要发布或订阅或回放执行过程事件的模块通过 StreamWriter / StreamReader / readAll 消费。详见 [architecture.md](../architecture.md) 加 [interfaces/l2b.md](../interfaces/l2b.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 CLI 消费者绕过 StreamReader 直读 stream.jsonl | drift | 已闭环（phase148/152/161）| `readAll` + `createStreamReader` 入口 + STREAM_FILE 常量；CLI 全部走 readAll / createStreamReader / streamPath 显式参数化 |
| A.2 write 前未 open 静默丢弃 | drift | 已闭环（phase298）| throw `Error('StreamWriter: write() called before open()')` 替代 silent drop |
| A.3 appendSync 写失败事件本体丢失 | drift | 已闭环（phase298）| `audit.write(STREAM_APPEND_FAILED, type=, reason=, body=)` body 完整进 emergency audit log |
| A.4 retention.maxFiles 三值同语义 | 命名冗余 | 降级 §7.B（phase317）| 命名一致性偏差 / 不丢信息 / 不软吞 |
| A.5 字节/字符索引 mismatch | drift | 已闭环（phase165）| readBytesSync + StringDecoder('utf-8') / 连续 parse_failed 阈值升 STREAM_READER_CORRUPT + 停订阅 |
| **A.6 chokidar FSEvents 静默停火**（**phase352 实施合规 / 应然位置错**）| drift / 软吞 | ✅ **closed phase 469 (`ec412a1e`)** | macOS FSEvents backend 下 chokidar `stability: 'immediate'` 对 stream.jsonl 快速连续 append 静默停止触发 change callback / phase352 实施 fallback poll setInterval(500ms) 在 StreamReader / 实施约束下合规（功能不丢 + 测试 PASS）。**应然位置错（phase 448 design 重审）**：fallback poll 是 L1 FileWatcher OS 抽象抹平范围（macOS 不可靠兜底）/ 不应在 L2 Stream / 真合规修复推 phase 469（fallback poll 移 L1 + L2 删 setInterval / 同 l1_file_watcher §A.5 联动）/ 删原「与 A.X-1 反向 trade-off / 合并消化」框架（在 L2 内绕弯 / 真根因 L1 应然不完整）|
| **A.X-1 StreamReader subscribe chain 含 L1 OS detail leak（应然位置错）** | drift / 应然层 / 中 | ✅ **closed phase 469 (`ec412a1e`)** | **framing 修订（phase 448 design 重审）**：subscribe chain 真组成 = L1 part（watch + fallback poll + unlink）+ L2 业务 part（offset+truncate+parse+corrupt）/ 原 sharpen「StreamReader 退化纯解析器 / 消费者 own FileWatcher」字面解过激（业务 part 误归 L1）。**真合规**：(1) L1 part = createWatcher 订阅 + fallback poll 内置（同 l1_file_watcher §A.5）/ (2) L2 业务 part = StreamReader own（offset 增量读 + truncate detection + parse + corrupt 升级）/ 不退化纯解析器。**leak 部分**：fallback poll 现实然在 L2 Stream / 应移 L1（同 §A.6 + l1_file_watcher §A.5 联动）。源：phase 448 design 重审 / 用户拍板根因 L1 / 删原 4 候选（α/β/γ/δ）框架（在 L2 内绕弯）|
| ~~A.X-2 e2e chat-viewport-regression 测试文件缺失~~ | ~~drift~~ | **✅ closed phase404**（design stale 同步 / Path #1 实测推翻分发表 estimate）| **drift 描述本身错误**：`tests/e2e/chat-viewport-regression.test.ts` **实然存在**（550 行 / phase165 起 `d97e6054 Phase 165: stream reader byte/char mismatch + chat-viewport audit 归属修正` git log 锚点）/ 6/6 基线全覆盖 align §8 应然承诺：基线 1 多行中文 chunk 边界（L222）+ 基线 2 turn 序列 Spinner lifecycle + VIEWPORT histogram（L262）+ 基线 3 连续 10 轮 tool_call+result（L346）+ 基线 4 畸形 JSON STREAM_READER_CORRUPT 哨兵（L399）+ 基线 5 VIEWPORT_* 写 agentDir（L439）+ 基线 6 Spinner start/stop 配对 elapsed_ms（L477）/ 应然完全实施 / 多轮未发现 stale 同 phase399 §8.A vs §8.E + phase401 元 drift 同型 |
| §配置常量 `IGNORE_PATTERN` 对外导出承诺 | 双向 mutual drift / 已闭环（r44 A）| 历史承诺 Stream 导出供 Snapshot 装配 / 实施时 Snapshot 改用自治 `SNAPSHOT_IGNORE_PATTERNS` / 删契约承诺 / 不实现导出 |

#### A.6 治理方向（chokidar 静默停火 / 高优）

- **现象**：chat-viewport 渲染中途卡住 / streaming cursor `▋` 残留 / 用户可见输出不完整
- **根因**：chokidar FSEvents backend 在 macOS 下对快速连续 append 静默停止触发 callback
- **影响**：跨进程 StreamReader 全量受影响（chat-viewport / CLI / 任何 createStreamReader 消费者）
- **修复方向**：StreamReader.start() 内增 `setInterval`（建议 500ms）定期调 `readIncrement()` 作 fallback poll / chokidar 正常时 readIncrement 返回 0 事件（无开销）/ chokidar 停火时 fallback 接管事件交付 / stop() 时 clearInterval

**phase352 实施**（main `4703d203116c175682c76498a15767af67e36e92`）：
- StreamReader.start() / stop() / triggerCorrupt fallback poll setInterval(500ms) + clearInterval
- 反向 3 项强反向（硬编码 assertion / 升格硬约束第 6 次执行 / 6 次连续 PASS）
- 行为契约扩（chokidar 正常 + fallback 双链路 / 0 重复事件 / size===offset return）
- ~~**r48+ design phase 候选**：A.6 + A.X-1 合并消化~~ **superseded by phase 448**：合并消化框架在 L2 内绕弯 / 真根因 = L1 FileWatcher OS 抽象不完整（用户拍板根因归 L1）/ 真合规修复推 phase 449+（fallback poll 移 L1 + L2 删 setInterval / 同 l1_file_watcher §A.5）

#### A.X-1 治理方向（**framing 修订 phase 448 / 旧字面 superseded**）

- ~~**旧应然**：StreamReader 退化为纯解析器 `parse(bytes) → events[]` / 不内化 fs watch~~（字面解过激 / 业务 part 误归 L1）
- **新 framing（phase 448 design 重审）**：subscribe chain 真组成 = L1 part（watch + fallback poll + unlink / 应然位置 L1）+ L2 业务 part（offset+truncate+parse+corrupt / StreamReader own 合规）
- **实然**：StreamReader 构造期持 FileWatcher createWatcher 订阅 + 内置 fallback poll setInterval（phase352 leak 部分）
- **影响范围**：跨进程订阅者（chat-viewport / Gateway / 任何 createStreamReader caller）
- **治理路径（phase 469 已闭环）**：(1) L1 FileWatcher createWatcher options 加 fallback poll 内置（G1-G3 derive 详 `coding plan/phase469/derive.md`）/ (2) L2 Stream reader.ts 删 fallbackTimer + setInterval / (3) StreamReader 接口语义不变（offset+truncate+parse+corrupt 仍 own）/ commit `ec412a1e`
- **协同**：l1_file_watcher §A.5（fallback poll 移 L1 应然修订）+ §A.6（实施位置错）+ §A.X-1（subscribe chain L1 part vs L2 业务 part 区分）三处 cross-ref / 同 phase 449+ 联动落地

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `open()` 归档失败用数据流内事件（`session_boundary, reason=archive_failed`）| 正面设计决策（数据流自报降级）| 如未来需要硬中断 → 升级为错误 |
| `StreamLog` interface 极薄（仅 write）| 写/读分离合理 | 跨进程订阅协议变化 |
| `close()` 无 flush | 合理（appendSync 已同步）| 切异步 append → 必须 flush |
| `ts` 由写入方传入 | 合理（事件发生时间 ≠ 落盘）| 跨进程写出现时钟漂移 → 升 A |
| 写侧 `STREAM_*` / 读侧 `STREAM_READER_*` 命名前缀非对称 | 设计决策（诊断路径区分）| 引入新 _READER_ 事件冲突时再评 |
| A.4 `retention.maxFiles: number \| null \| undefined` 三值同语义 | 命名冗余 | 用户配置错导致 runtime bug |
| `LLM_OUTPUT_EVENTS` 经 stream/types.ts 而非 stream/index.ts 导出 | 默认 export 路径偏差 | consumer（claw / chat-viewport / watchdog）需 deep import from types.js / 升档：增加 index.ts re-export 收敛入口 |
| **L2b.G1 (stream)** arch 表 2「事件 schema 解析（bytes 到 events[]）」描述精度 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2b.md line 222 自承认「应然 silent on `parseBytes` 公共方法（应然幻象 / 实然不暴露 / 字节安全 parse 仅 reader 内部用）」/ arch 表 2 Stream row 列「事件 schema 解析（bytes 到 events[]）」当顶层能力 / interfaces 与 arch 描述精度不一致 | **业务决策性 / 用户拍板候选**：α arch 表 2 改「事件 schema 解析（reader 内部封装 / 不暴露公共 API）」/ β 保留现状（interfaces 自 sharpen 已显式声明应然幻象）|
| **L2b.G2 (stream)** arch 表 2「同进程 in-process pub/sub callback」可能 stale | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：arch 表 2 Stream row 列「同进程 in-process pub/sub callback」/ interfaces/l2b.md 暴露 createStreamReader = FileWatcher 跨进程订阅模式 + StreamWriter.write 同步直写 / 无显式 in-process pub/sub method / arch 此条与 interfaces 现态对应不上 | **业务决策性 / 用户拍板候选**：α arch 表 2 改「跨进程订阅 callback（FileWatcher 驱动）」/ β 实然加 in-process pub/sub method（如同进程 listener registry）/ γ 保留现状（如实然有 in-process callback 路径但未在 interfaces 暴露则 interfaces 补 sharpen）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：「事件流读写 + schema 解析」与「跨进程通知机制」独立可变（违反点 A.X-1 / 实然 leak fs watch）
- **M#2 业务语义归属**：StreamLog.write / createStreamReader / readAll 业务发起方
- **M#3 资源归属**：stream.jsonl + logs/stream/ 归 Stream 独占
- **M#4 持久化**：appendSync 每条事件 / 文件即权威
- **M#5 依赖单向**：Stream → L1 FileSystem + L1 FileWatcher（StreamReader createWatcher 订阅 / phase 469 后 fallback poll 移 L1 / 双层 derive align：L1 part = watch+fallback poll+unlink / L2 业务 part = offset+truncate+parse+corrupt）+ L2 AuditLog（per arch §10 表 1 / arch 表 1 dep 列暂未含 FileWatcher / cross-doc audit candidate）/ ~~应然不依赖 FileWatcher（违反点 A.X-1 / phase 449+ 治理）~~ ✅ closed by phase 469（`ec412a1e`）
- **M#6 依赖结构稳定**：StreamLog / StreamReader / StreamEvent 接口稳定
- **M#7 耦合界面稳定**：write / createStreamReader / readAll / STREAM_FILE 常量四面稳定
- **M#8 耦合界面最小**：StreamLog 仅 write（caller-facing 抽象 / `close` 在 StreamWriter impl class lifecycle 层）/ StreamReader 仅 start/stop/isActive
- **M#9 显式表达编译器可检**：phase161 streamPath 显式 / phase165 Buffer vs string 类型区分
- **M#10-M#11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D2 不得丢弃/静默**：A.6 chokidar 静默停火违反（事件已落盘但未送达消费者 / 待修）
- **D1b 状态可观察**：readAll 历史 + createStreamReader 增量双入口
- **D1c 中断可恢复**：纯追加磁盘为权威态 / 重启后 readAll 重建
- **D1d 事后可审计**：A.5 phase165 闭环 + e2e 基线
- **D3 用户可观察**：chat-viewport TUI 从 stream.jsonl 渲染
- **D5 日志重建**：stream.jsonl 纯追加 + logs/stream/ 归档
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：**驱动原则**（事件驱动核心设施）
- **D9 CLI 唯一外部入口**：N/A（本模块 L2 内部基础服务 / 0 外部入口）
- **D10 多 claw 不隔绝**：每 agent 独立 stream.jsonl / 跨进程订阅可达
- **D4 / D6 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：stream.jsonl 在 agent dir
- **P2 上下文工程**：事件流是 agent 执行历史的权威来源
- **P3 分多个智能体加分子任务**：每 agent 独立事件流 / 单一代码基服务多 agent
- **P4 系统为智能体服务**：**驱动**（TUI / chat-viewport / 审计皆从 Stream 消费）

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase148 / phase152 / phase161 / phase165 / phase193 / phase298 / phase317 / phase346 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：audit 必传升级（StreamWriter / StreamReader / readAll）+ 大量 console → audit 化
- phase152：A.1 CLI 绕过初步修复（readAll + STREAM_FILE 常量）
- phase161：streamPath 显式参数化（消除 fs.root 隐式约定）+ STREAM_READER_FILE_MISSING 一次性事件
- phase165：A.5 字节/字符 mismatch 修复（readBytesSync + StringDecoder + STREAM_READER_CORRUPT）
- phase298：A.2 / A.3 完全闭环（write throw + audit body 保全 / SHA `f6ba12e`）
- phase317：A.4 降级为命名一致性偏差
- phase346：LLM_OUTPUT_EVENTS 从 watchdog-utils 迁入 stream/types.ts
- phase404：A.X-2 design stale 同步（实然 phase165 起 e2e/chat-viewport-regression.test.ts 已存在 6/6 基线全覆盖 / drift 描述本身错误 / Path #1 实测推翻分发表 estimate / pseudo_decision_filter dominant choice 自决 / design only / 0 commit）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2b.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / Design Principles D9 verbatim「CLI 唯一外部入口」N/A + D10「多 claw 不隔绝」编号修 align principles.md / §3 资源改 table 「stream.jsonl + logs/stream/」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim 已正确）
- 2026-05-04 / interfaces/l2b.md cross-doc audit 后 modules 同步：§1.做「parseBytes 解析能力对外开放」措辞 stale 修订为「字节安全 parse 内部封装」align interfaces 应然幻象消解 / §M#8「StreamLog 仅 write/close」措辞精化「close 在 StreamWriter impl class lifecycle 层」align interfaces StreamLog 实然形态
- 2026-05-04 / phase 469 code 闭环（`ec412a1e`）：§A.6 + §A.X-1 同时 closed / L1 watcher.ts 内置 fallback poll + L2 reader.ts 删 fallbackTimer / tsc 0 error / vitest 1358+ PASS（1 flaky 无关）/ StreamReader 接口语义不变（offset+truncate+parse+corrupt 仍 own）/ M#5 单向依赖修复（Stream 不再 leak L1 OS detail）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_stream.md vs arch §10 + 表 1/2 + interfaces/l2b.md Stream 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7+**D8 驱动**+D10 + D9 N/A + D4/D6/D11 无关 + Philosophy P1+P2+P3+**P4 驱动** + Path #1-#7）/ 6 主能力 align arch 表 2 / 资源 stream.jsonl+logs/stream/ align arch 表 1 / 修 §7.C M#5 line 182 stale 描述（phase 469 closed / Stream → L1 FileSystem + L1 FileWatcher（双层 derive） + L2 AuditLog 真合规）/ arch 表 1 Stream row dep 列暂未含 FileWatcher 是 cross-doc audit candidate（实然 createStreamReader 用 / 推 r+1 同步）/ phase148+152+161+165+193+298+317+346+404+448+469 多里程碑稳态保留 / L2b.G1 + L2b.G2 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#10 Stream + AuditLog 拆分（实时观察 vs 事后审计）| ✓（独立可变 / 关联 l2_audit_log.md）|
| KD（应然）Stream 不 own 跨进程通知 / 跨进程通知归 FileWatcher | ✅ **closed by phase 469（`ec412a1e`）**：A.X-1 leak 修复 / L2 reader.ts 删 fallbackTimer + setInterval / fallback poll 移 L1 watcher.ts 内置 / Stream 不再 leak L1 OS detail / M#5 单向依赖修复 / StreamReader 接口语义不变（offset+truncate+parse+corrupt 仍 own）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **写侧路径**：open / archive / prune / write / close 全路径 + retention 配置
- **读侧路径**：createStreamReader 增量订阅 + readAll 历史读
- **生命周期**：start/stop idempotent / 截断 reset / unlink reset / corrupt 升级
- **失败语义**：write 未 open throw / append 失败 audit body / parse 失败 skip / 连续 parse_failed 升 corrupt
- **多字节 UTF-8 incremental**：chunk 边界拆中文 / emoji 不错位（phase165 §M9）
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言
- **e2e 回归基线**（6 基线 / CI 凡 PR 动 reader / chat-viewport / createMainTurnUI 必跑全绿 / 基线语义不可删改）：chat-viewport 渲染 + Spinner lifecycle + 连续 tool_call/result + 畸形 JSON corrupt + VIEWPORT 写 agentDir + Spinner elapsed 一致
