# Messaging 接口契约

L2 跨 agent 消息通信的必经之路。服务于"多个 claw 智能体的信息不应当隔绝，允许互相访问"。Messaging 不处理传输（CLI / Transport 负责），只处理**持久化落盘 + 目录生命周期（pending / done / failed）**。

归属：L2 基础设施。依赖：FileSystem（L1）、MessageCodec（L1）、AuditLog（L2，必需——Phase 148 已从可选升级：InboxReader + OutboxWriter 均接 audit 必传）。被调用：写侧 15+ 模块（contract / tools / runtime / task / subagent / cron / CLI 等）；读侧主要是 Runtime（启动 InboxReader 轮询）。

## 职责边界

### 做

1. **Outbox 写入**：`OutboxWriter.write(opts)` → 编码 + 原子落盘到 `<clawDir>/outbox/pending/<ts>_<typeSlug>_<uuid8>.md`，返回路径
2. **Inbox 写入（三种变体）**：
   - `writeInbox(fs, inboxDir, msg, extraFields?)`：异步版
   - `writeInboxMessage(fs, opts)`：同步版，选项更丰富
   - 两者都落盘到 `<ts>_<priority|tag>_<uuid8>.md`
3. **Inbox 读取与生命周期**：`InboxReader.drainInbox` 读 pending 下所有 `.md` → decode → 按 priority desc + timestamp asc 排序 → 返回；解析失败的文件自动 move 到 failed/
4. **Inbox 归档**：`markDone` / `markFailed` 把 pending 下的单文件 move 到 done/ / failed/，加 `<ts>_<uuid8>_` 前缀避免冲突
5. **目录 ensure**：`InboxReader.init()` 确保 pending / done / failed 三目录存在
6. **Frontmatter meta 读取**：`readInboxFileMeta(fs, filePath)` 单独读消息 frontmatter 用于轻量状态检查

### 不做

- 不做消息传输（跨进程 / 跨机通信归 CLI / Transport）
- 不做消息 schema 校验（归 MessageCodec）
- 不做消息的业务语义解释（type / priority 的具体意义归调用方）
- 不做 inbox 监听 / watch（归 Runtime 装配层，用 FileWatcher）
- 不做 outbox 消费 / 分发（归 Runtime / 调度层）
- 不做消息去重（依赖文件名 UUID 保证唯一）

## 接口

```ts
// Outbox
interface OutboxWriteOptions {
  type: 'response' | 'contract_update' | 'status_report' | 'report'
      | 'question' | 'result' | 'error';
  to: string;
  content: string;
  contract_id?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
}

class OutboxWriter {
  constructor(clawId: string, clawDir: string, fs: FileSystem, audit: Audit);  // Phase 148 已修复：audit 必传
  write(options: OutboxWriteOptions): Promise<string>;  // 成功写 OUTBOX_SENT；失败写 OUTBOX_SEND_FAILED 后冒泡
}

// Inbox write
function writeInbox(
  fs: FileSystem, inboxDir: string, msg: InboxMessage,
  extraFields?: Record<string, string>,
): Promise<void>;

interface InboxMessageOptions {
  inboxDir: string;
  type: string;
  source: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  body: string;
  to?: string;
  idPrefix?: string;
  filenameTag?: string;
  extraFields?: Record<string, string>;
}
function writeInboxMessage(fs: FileSystem, opts: InboxMessageOptions): void;  // 同步

function readInboxFileMeta(
  fs: FileSystem, filePath: string,
): Record<string, string> | null;

// Inbox read/lifecycle
interface InboxEntry { message: InboxMessage; filePath: string; }

class InboxReader {
  constructor(
    pendingDir: string, doneDir: string, failedDir: string,
    fs: FileSystem, audit: Audit,  // Phase 148 已修复：audit 必传
  );
  init(): Promise<void>;
  drainInbox(): Promise<InboxEntry[]>;
  markDone(filePath: string): Promise<void>;
  markFailed(filePath: string): Promise<void>;
}
```

**关键约定**：
- **每条消息 = 一个 `.md` 文件**：文件即消息，没有 DB / 索引
- **文件名格式 = `<ts>_<discriminator>_<uuid8>.md`**：timestamp 前缀保证时序，uuid 防冲突
- **目录即状态**：pending / done / failed 三态通过文件位置表达
- **写入原子性**：`writeAtomic` 保证消息要么完整可见、要么不可见（无半写）
- **排序语义**：`drainInbox` 返回 priority desc → timestamp asc；调用方按此顺序处理

### 工厂（装配期入口）

`src/foundation/messaging/index.ts` 导出 `createInboxReader` 与 `createOutboxWriter`，是 Assembly / Runtime 装配期的推荐构造入口：

```ts
export function createInboxReader(
  fs: FileSystem,
  audit: Audit,
  baseDir: string,      // inbox 基目录（通常 'inbox'）；工厂内部固定 pending/done/failed 三子目录
): InboxReader;
// 内部等价于：new InboxReader(`${baseDir}/pending`, `${baseDir}/done`, `${baseDir}/failed`, fs, audit)

export function createOutboxWriter(
  clawId: string,
  clawDir: string,
  fs: FileSystem,
  audit: Audit,
): OutboxWriter;
```

**行为承诺**：构造代理；与 `new InboxReader(...)` / `new OutboxWriter(...)` 完全等价——
- 不缓存、不单例：每次调用返回新实例
- 不注入默认值（默认归 ctor 本身）
- 不做参数校验 / 不触发副作用

**β 签名收敛**：工厂签名 `(fs, audit, baseDir)` 单目录参数；工厂内部固定拼 `<baseDir>/pending`、`<baseDir>/done`、`<baseDir>/failed` 三子目录后调用 ctor。

**为何收敛**：原签名暴露 3 个 `string` 目录参数违反 Module Logic #9（"不可消除耦合应让编译器检查"）——调用方把 `doneDir` 与 `pendingDir` 传反编译期无法捕获，运行时会把待处理消息当已完成，静默丢消息（违反 Design Principle "运行中信息不丢失"）。phase148 契约已锁 `pending` / `done` / `failed` 为 Messaging 模块不可变约定，不应作为通用目录参数对外暴露。

**ctor 保持不变**：`InboxReader` ctor 仍是 `(pendingDir, doneDir, failedDir, fs, audit)`，以支持未来三子目录名非默认的场景（目前无此需求）；工厂是当前唯一推荐入口。

装配方应通过工厂而非 `new` 构造，以便未来依赖组合扩展时单点修改。

## 失败语义

| 失败源 | Messaging 行为 |
|---|---|
| `writeInbox` / `writeInboxMessage` / `OutboxWriter.write` 写文件失败 | 原样抛出（调用方显式处理）✓ |
| `writeInboxMessage` 同步版抛错 | 调用方必须 try/catch |
| `readInboxFileMeta` 任何失败（不存在 / parse error / IO） | 返回 `null`，错误区分信息丢失。**A.1（Phase 150 scope）** |
| `drainInbox` `fs.list` 抛非 `FS_NOT_FOUND` 错 | `audit.write(AUDIT_EVENTS.INBOX_LIST_FAILED, reason=...)` + 返回 `[]`（Phase 148 已修复原 `console.error`；返 [] 歧义留 Phase 150——见 A.2）|
| `drainInbox` 单文件解析失败 | `audit.write(AUDIT_EVENTS.INBOX_FAILED, file=..., reason=<真实原因>)` + move 到 failed/（Phase 148 已修复：携带真实 reason 而非遮蔽）|
| `markDone` move 成功 | `audit.write(AUDIT_EVENTS.INBOX_DONE, file=...)` 正面事件 |
| `markDone` / `markFailed` move 失败 | `audit.write(AUDIT_EVENTS.INBOX_MOVE_FAILED, reason=...)`（Phase 148 已修复原 `console.error`，事件名 `inbox_move_error` → `INBOX_MOVE_FAILED`）；**当前仍不抛**，文件仍在 pending → 下次 drainInbox 重复处理。**A.3 失败语义拆分留 Phase 150** |
| `OutboxWriter.write` 成功 | `audit.write(AUDIT_EVENTS.OUTBOX_SENT, to=..., type=..., id=...)` 正面事件（Phase 148 已修复）|
| `OutboxWriter.write` 失败 | `audit.write(AUDIT_EVENTS.OUTBOX_SEND_FAILED, to=..., reason=...)` 后 **throw 原错**冒泡给调用方（Phase 148 已修复，audit 不替代错误冒泡）|
| `writeInbox` / `writeInboxMessage` 写文件失败 | 原样抛出（调用方显式处理）✓ |

## 不可消除的耦合

- **Messaging → FileSystem（L1）**：所有写 / 读 / move 走 fs，显式依赖
- **Messaging → MessageCodec（L1）**：encodeOutbox / encodeInbox / decodeInbox / parseFrontmatter 都走 MessageCodec，依赖单向
- **Messaging → AuditLog（L2，必需——Phase 148 已从可选升级）**：InboxReader + OutboxWriter 构造均接 `audit: Audit` 必传；inbox 状态迁移（INBOX_DONE / INBOX_FAILED / INBOX_LIST_FAILED / INBOX_MOVE_FAILED）与 outbox 发送（OUTBOX_SENT / OUTBOX_SEND_FAILED）全链路审计
- **目录名与文件名格式约定**：消费者（尤其 CLI tail / watchdog）依赖 `pending/done/failed` 目录结构和 `<ts>_..._<uuid>.md` 文件名约定——属**不可消除的广连接**（文件即消息的代价）。显式登记
- **消息 schema（`InboxMessage` / `OutboxMessage`）**：定义在 `types/contract.ts`，被 Messaging 和 15+ 消费者共享——类型层耦合非运行时耦合

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `inboxDir` / `pendingDir` / `doneDir` / `failedDir` | 调用方传入 | Messaging 不决定路径策略 |
| `OutboxWriter` 内部 `<clawDir>/outbox/pending` 拼接 | 内部硬编码 | 这是 OutboxWriter 唯一对路径策略的假设 |
| 文件名格式 `<ts>_<x>_<uuid8>.md` | 内部硬编码 | 调用方无法定制 |
| 排序规则（priority desc + timestamp asc） | 内部硬编码 | 调用方无法定制；见 B 类登记 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 `readInboxFileMeta` 返回 `null` 吞没所有失败原因**

违反原则：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——文件不存在 / parse error / IO error 全部被抹平
- "预期失败由调用方显式处理"——调用方拿到 `null` 无法区分"消息还没到"（正常路径）与"消息格式错误"（需要告警）

修复候选：
- **候选 α**：改为 `readInboxFileMeta(...): { meta } | { error: 'not_found' | 'parse_error' | 'io_error'; detail }`
- **候选 β**：抛错，让调用方 try/catch 区分——与 FS 现有 `FS_NOT_FOUND` 错误码风格一致

**A.2 `drainInbox` list 失败后与"空 inbox"不可区分（Phase 148 部分修复，失败语义留 Phase 150）**

Phase 148 已把 `console.error` 替换为 `audit.write(INBOX_LIST_FAILED, reason=...)`，list 失败的降级信号进入结构化事件流。

**仍未修**：`drainInbox` 仍返回 `[]`——调用方无法区分"访问失败"与"空"。失败语义拆分（抛 vs. Result）属 Phase 150 "失败语义原语" scope。

原修复候选（保留供 Phase 150 参考）：
- **候选 α**：`drainInbox()` 抛错，调用方显式处理 list 失败
- **候选 β**：返回 `{ entries: InboxEntry[]; warnings?: Array<{kind, detail}> }`，把降级信号交给调用方

**A.3 `markDone` / `markFailed` move 失败吞没导致消息重复处理（修复方向已定，待实施）**

Phase 148 已把 move 失败从 `console.error + audit?.write('inbox_move_error', ...)` 改为 `audit.write(INBOX_MOVE_FAILED, reason=...)`（audit 必传 + 事件名规范化），运行时可观察。

**仍未修**：move 失败**仍不抛**——文件仍在 pending，下轮 drainInbox 会重放，业务副作用可能被重复触发。

**修复方向（候选 α）**：`markDone` / `markFailed` 在 `audit.write(INBOX_MOVE_FAILED, ...)` 后**抛原错**（带 cause）；调用方必须处理——典型决策是"阻塞该消息继续处理 + 告警，直到 FS 问题解决"。

依据原则分工：
- move 失败源是 FS I/O（权限 / 磁盘满 / 目标目录缺失），属**不可预期失败**，按编码规范"暴露而非吞没"必须上浮
- audit 是**观察通道**，不替代**处理通道**——消费者必须在调用链上看见失败，才能决定是否继续拉下一条
- 候选 β（in-memory `processingSet`）驳回理由：进程重启 set 丢失，消息仍会重放，根本问题未解；且把状态从磁盘（pending 目录即事实）搬进内存违反"磁盘即权威"

**实施检查清单**：
1. `markDone` / `markFailed` 签名保持 `Promise<void>`（现有），但行为改为失败抛出
2. Runtime / SubagentSystem / ContractSystem 等调用方补 try/catch，典型处理：记录到 stream 事件 + 终止本轮 drain + 等待下一 tick
3. 测试补"move 失败后消息不被重复处理"断言（现测试漏洞）

**A.4 OutboxWriter 不接入 AuditLog，跨 agent 通信发出端无审计痕迹（Phase 148 已修复）**

Phase 148 修复：OutboxWriter 构造加 **`audit: Audit` 必传**；`write` 成功 `audit.write(OUTBOX_SENT, to=..., type=..., id=...)`；失败 `audit.write(OUTBOX_SEND_FAILED, to=..., reason=...)` 后**抛原错**冒泡给调用方（audit 不替代错误传播）。InboxReader 同步纠正为必传。

选择方案 α（OutboxWriter 自担审计）而非装配层外包，理由：与 InboxReader 对等，保持 Messaging 模块边界闭合。测试用 `InMemoryAudit` 断言事件，不提供 NoopAudit——与 Snapshot A.5 / SessionStore A.2 同原则：审计事件是行为契约的一部分，无合理"不审计"场景。

事件重命名登记：`inbox_move_error` → `INBOX_MOVE_FAILED`（规范 `<module>_<action>_<outcome>`，禁用 `_error` 后缀）。

**A.5 上层模块绕过 Messaging 直接 `fs.writeAtomic('inbox/pending/...')`** → **Phase 152 已修复（bypass 本体）；路径字面量归属留尾**

违反原则：
- 模块逻辑"每种资源只归属唯一模块，其他模块通过该模块的对外入口间接访问"——inbox / outbox 资源归 Messaging，但多处上层模块绕过 Messaging 写入接口，直接操作目录和文件名约定
- 编码规范"减少代码间的依赖：改一处不应连带改多处"——文件名格式、YAML frontmatter、目录结构等约定散落到上层；未来改格式要连带改多处

**现状**（grep 确认）：
- `core/task/system.ts` 多处：`await this.fs.writeAtomic('inbox/pending/${filename}', buildFileContent(...))` + 自带注释"bypass transport path issues"（L850 / L940）。等于**显式承认绕过 Messaging**
- `core/contract/manager.ts` L822 / L841：传 `inboxDir: path.join(this.clawDir, 'inbox', 'pending')` 给其他模块，把路径约定泄漏到配置
- `core/heartbeat.ts` L52：`const inboxDir = path.join(this.baseDir, 'motion', 'inbox', 'pending')` 同样泄漏路径
- `types/paths.ts` 把 `inbox/pending` / `outbox/pending` 当公共常量导出——路径约定脱离 Messaging

这是 Messaging 模块边界**显著被侵蚀**的证据。`task/system.ts` 注释"bypass transport path issues"提示**历史上有过尝试走 Messaging 但遇到路径配置问题放弃**——说明 Messaging 接口对消费者场景的适配性不足。

**Phase 152 Step 1 落地情况**：

- `core/task/system.ts` 5 处 `fs.writeAtomic('inbox/pending/${filename}', buildFileContent(...))` 手拼全部改调 `writeInbox(fs, 'inbox/pending', msg, auditWriter)`，"bypass transport path issues" 注释删除
- `contract/manager.ts` / `heartbeat.ts` Phase 150 Step 5 已迁到 `new InboxWriter(fs, inboxDir, audit)` class
- `grep "fs\.writeAtomic\(['\"]inbox/(pending|done|failed)" src/` 0 命中——bypass 本体已归零

**留尾（非 Phase 152 scope）**：

1. `types/paths.ts` 仍导出 `'inbox/pending'` / `'outbox/pending'` 作为公共路径常量；`contract/manager.ts` / `heartbeat.ts` 仍用 `path.join(clawDir, 'inbox', 'pending')` 手拼 inboxDir。修复路径：Messaging 新增 `inboxPendingDir(clawDir)` / `outboxPendingDir(clawDir)` helper，消费者改 import；`types/paths.ts` 对应条目删除
2. `writeInbox` / `writeInboxMessage` / `readInboxFileMeta` 三个 free function 已标 `@deprecated Phase 150 Step 5 过渡`——消费者全量迁到 `InboxWriter` class 是 **Phase 155 scope**

**原调查记录（保留供历史追溯）**：

**调查结论**：`task/system.ts` 的 "bypass transport path issues" 注释是 Messaging 还走 Transport（UDS socket）投递时期的遗留，文件投递范式切换后 bypass 失去动机但代码未清理。对比证据：

| 调用点 | 当前写法 | API 是否够用 |
|---|---|---|
| `task/system.ts` L850 / L940 / L1008（3 处） | `fs.writeAtomic('inbox/pending/${filename}', buildFileContent(...))` 手拼 frontmatter | **够用**：`writeInbox(fs, inboxDir, msg, extraFields)` 异步版文件名格式 `${ts}_${priority}_${uuid8}.md` 与手拼完全一致，`encodeInbox` 等价于 `buildFileContent` |
| `contract/manager.ts` L841 | 已走 `writeInboxMessage(fs, {inboxDir, source, to, priority, body, extraFields})` ✓ | 已用 API；但 `inboxDir: path.join(clawDir, 'inbox', 'pending')` 路径字面量泄漏 |
| `heartbeat.ts` L62 | 已走 `writeInboxMessage(fs, {inboxDir, type:'heartbeat', ...})` ✓ | 已用 API；跨 claw 目录（`motion/inbox/pending`）可直接用；路径字面量泄漏 |
| `types/paths.ts` L14 / L17 | 导出 `'inbox/pending'` / `'outbox/pending'` 作为"公共路径常量" | 路径约定脱离 Messaging，破坏资源归属 |

**结论**：API 完全够用（候选 α），不需要 β 扩接口。剩余问题是路径字面量散落，修复方案：

1. **task/system.ts 3 处 bypass 改调 `writeInbox(fs, 'inbox/pending', msg, extraFields)`**；注释 "bypass transport path issues" 删除；`sendFallbackError` L1008 同步清理
2. **Messaging 新增路径 helper**（内部常量 + 导出函数）：
   ```ts
   // foundation/messaging/paths.ts（新增）
   export function inboxPendingDir(clawDir: string): string;
   export function outboxPendingDir(clawDir: string): string;
   ```
   `contract/manager.ts` / `heartbeat.ts` 改 import `inboxPendingDir(clawDir)` 替换 `path.join(clawDir, 'inbox', 'pending')`
3. **`types/paths.ts` 清理**：删除 `inbox/pending` / `outbox/pending` 条目（或迁入 Messaging 内部）
4. **架构边界测试**：grep 断言 `fs.writeAtomic` 的 path 参数不再出现 `inbox/pending` / `outbox/pending` 字面量（`task/system.ts` / `manager.ts` / `heartbeat.ts` 外任何 `src/**` 路径）

**修复依据的原则**：
- 资源只归属唯一模块（inbox / outbox 归 Messaging）✓
- 改一处不应连带改多处（目录名 / 文件名 / frontmatter 约定收敛到 Messaging）✓
- 模块边界与实际依赖对上——调查证实 API 边界已正确，问题是消费者绕过，不是边界重构场景

**状态**：Phase 152 Step 1 实施 bypass 本体；路径字面量归属待续（无独立 phase，并入 Phase 155 或 Phase 156 modules.md drift 整改）。

**A.6 Inbox 写入三套 API 名字分裂**

违反编码规范"同一概念用同一名字"。`writeInbox` 和 `writeInboxMessage` 都是"写 inbox"，名字区分为"带什么参数"而非"做什么事"——调用方要记住哪个 API 对应哪个入参形态。同步 / 异步分裂进一步增加认知负担。

修复候选：
- **候选 α**：统一为 `writeInbox(fs, inboxDir, msg | opts, options?)`，选项对象含 `{ extraFields?, sync?: boolean, idPrefix?, filenameTag? }`
- **候选 β**：把 `writeInbox` / `writeInboxMessage` 合并成 `InboxWriter` class，与 `OutboxWriter` 对齐

### B. 偏差登记（当前合理或代价过高）

- **广连接代价登记**：15+ 消费者依赖"目录名 `pending/done/failed` + 文件名 `<ts>_<x>_<uuid8>.md` + YAML frontmatter"三重约定。违反编码规范"减少代码间的依赖：改一处不应连带改多处"——未来改任何一层约定会穿透到所有消费者。当前是"文件即消息"范式的固有代价（消息作为持久化记录必须跨进程可读），不是实现 bug。登记为广连接代价；A.5 修复方向能缩小但无法消除此广连接
- **`OutboxWriter.write` 返回写入路径**：调用方用路径作为"消息 id 替身"追踪状态，违反"耦合界面最小"；但当前消费者路径用途有限，暂不修
- **排序规则内部硬编码**：priority desc + timestamp asc 是唯一策略，未来若有"按 type 优先级"或"按 from agent 优先级"需求需改接口
- **目录名 `pending` / `done` / `failed` 硬编码**：调用方传 `inboxDir` 三个目录的路径，但 Messaging 内部依赖这三个名字约定——算"广连接"的一部分
- **同步 / 异步 API 分裂**：`writeInboxMessage` 同步；`writeInbox` / `InboxReader` / `OutboxWriter` 异步。同步版主要为了 `utils/notify.ts` 等简单 utility——异步化改造代价小但涉及所有调用方。登记
- **`modules.md` 索引层漂移**：L122 写 `IAuditSink` 接口、L124 写"导出 send" 工具——代码都不存在（`IAuditSink` 在 AuditLog 契约已登记；`send` 从未实现）。Step 13 统一修正

### C. 原则对照补充

- **"多个 claw 智能体的信息不应当隔绝"**：Messaging 是此原则的核心落实者 ✓（目录即邮箱，文件即消息）
- **"持久化一切信息到磁盘"**：所有消息通过 `.md` 文件落盘 ✓
- **"中断可恢复"**：pending / done / failed 目录状态进程重启可重建 ✓；A.3 是缺口
- **"事后可审计"**：InboxReader + OutboxWriter 全链路走 audit ✓（Phase 148 已升级必传，A.4 已闭环；A.2 / A.3 audit 通路已补齐，失败语义留 Phase 150）
- **"模块为自己的业务语义负责"**：Messaging 只负责"消息落盘 + 目录生命周期"，不解释业务语义 ✓
- **"每种资源只归属唯一模块"**：inbox / outbox 目录**名义**归 Messaging；A.5 明确多处绕过
- **"耦合界面稳定最小"**：接口异构（class + 函数 + 同步 / 异步）违反最小性（A.6）

## 测试覆盖现状

- `tests/core/inbox.test.ts`（10 个 `it`）：覆盖 InboxReader drain / markDone / markFailed / 排序 / 解析失败自动归档等契约主行为
- `tests/core/outbox.test.ts`（10 个 `it`）：覆盖 OutboxWriter.write 文件命名 / frontmatter 编码 / 路径返回
- `tests/utils/inbox-writer.test.ts`（9 个 `it`）：覆盖 `writeInboxMessage` 同步版 / 文件名约定
- `tests/cli/claw-outbox.test.ts`（4 个 `it`）：CLI 视角的 outbox 集成

**注**：A.1 / A.2 / A.3 修复 phase 需补：
- `readInboxFileMeta` 各类失败源的区分性断言
- `drainInbox` list 失败的降级信号断言
- `markDone` / `markFailed` 失败后的"消息重复处理防护"断言——尤其 A.3 的消息重放场景是当前测试漏洞

A.4 OutboxWriter audit 修复后补"outbox_sent 事件写入"断言。A.5 修复后补"消费者统一走 writeInbox"的集成断言。
