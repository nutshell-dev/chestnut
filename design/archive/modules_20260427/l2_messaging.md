# Messaging 接口契约

> **应然 / 实然 split**（2026-04-26，r31 / MessageCodec L1 模块消解）：
>
> - **应然**：Messaging L2 own inbox/outbox 业务 + **内化 inbox/outbox 编解码**（原 MessageCodec L1 的 codec 部分作为模块内部 helper / 不暴露独立模块）；frontmatter 解析沉为项目 utility（不入 modules.md / 不算模块）。Messaging 应然依赖 = FileSystem + AuditLog（**不再含 MessageCodec**）。
> - **实然**：当前仍依赖外部 MessageCodec L1 模块；编解码逻辑物理上仍在 `src/foundation/message-codec/` 下；应然移除该依赖（编解码逻辑物理内化进 Messaging 模块目录）；drift 待 §7 治理（详 §7.Phase phase[TBD]-1 / phase[TBD]-2）。
>
> 本 split 不解构既有契约结构；仅顶部声明应然/实然差距，§2 接口 / §职责边界 / §测试覆盖 等节描述实然形态不动。

> **phase216 迁移通告**（2026-04-22 / r9 分支 B / 合入 main `ee4202c` / 15 文件 +59 -124 净减 65 行）：
>
> **phase150 承诺的 `InboxWriter` class 唯一正道** 14 call sites 已全迁完（src 消费点 = 0）。§2 接口节原登记的 `writeInbox` / `writeInboxMessage` / `readInboxFileMeta` 3 free function 自 phase150 标 `@deprecated`；phase216 消费侧全切 class（async `write` / sync `writeSync` / static `readMeta`），**出口 3 function 定义删 + `foundation/messaging/index.ts` re-export 收敛至仅 `InboxWriter`**；`src/utils/inbox-writer.ts`（deprecated re-export 层）连带删（B.1 整理债消化 1/3）。
>
> **契约 drift 登记**：§2 "接口 / 关键 API" 仍登记 free function 描述（L13-14 / L49-65 / L130-131 / L139 / L224-231），应然形态（phase216 Step 5 后）仅 `InboxWriter` class 为公共 API。完整 §2 修订推迟到独立契约修订 phase（避免 backfill scope 扩散；phase196 模式复用）。
>
> **drift 已消化 by phase223**（2026-04-22 / r10 分支 C）：phase216 合入时 §2 接口节已同步修订为 `InboxWriter` class 形态（class InboxWriter + InboxMessageOptionsBase interface + 失败语义表用 class API）；§A.5 留尾 item 2 推进 + §B.p192-1 部分消化登记（phase213 2/4）；§7.Phase phase223 纪律条目登记。本 blockquote 保留历史；drift 状态字段统一在 §7.Phase。

L2 跨 agent 消息通信的必经之路。服务于"多个 claw 智能体的信息不应当隔绝，允许互相访问"。Messaging 不处理传输（CLI / Transport 负责），只处理**持久化落盘 + 目录生命周期（pending / done / failed）**。

归属：L2 基础设施。

**应然依赖**：FileSystem（L1）、AuditLog（L2，必需）—— inbox/outbox 编解码内化为模块内部 helper / 不再依赖独立 MessageCodec L1 模块。

**实然依赖**：FileSystem（L1）、~~MessageCodec（L1）~~（应然消解 / 待 §7 治理物理内化）、AuditLog（L2，必需——Phase 148 已从可选升级：InboxReader + OutboxWriter 均接 audit 必传）。被调用：写侧 15+ 模块（contract / tools / runtime / task / subagent / cron / CLI 等）；读侧主要是 Runtime（启动 InboxReader 轮询）。

## 职责边界

### 做

1. **Outbox 写入**：`OutboxWriter.write(opts)` → 编码 + 原子落盘到 `<clawDir>/outbox/pending/<ts>_<typeSlug>_<uuid8>.md`，返回路径
2. **Inbox 写入**：`InboxWriter` class 统一入口
   - `new InboxWriter(fs, inboxDir, audit).write(msg, extraFields?)`：异步版
   - `new InboxWriter(fs, inboxDir, audit).writeSync(opts)`：同步版，选项更丰富
   - 两者都落盘到 `<ts>_<priority|tag>_<uuid8>.md`
3. **Inbox 读取与生命周期**：`InboxReader.drainInbox` 读 pending 下所有 `.md` → decode → 按 priority desc + timestamp asc 排序 → 返回；解析失败的文件自动 move 到 failed/
4. **Inbox 归档**：`markDone` / `markFailed` 把 pending 下的单文件 move 到 done/ / failed/，加 `<ts>_<uuid8>_` 前缀避免冲突
5. **目录 ensure**：`InboxReader.init()` 确保 pending / done / failed 三目录存在
6. **Frontmatter meta 读取**：`InboxWriter.readMeta(fs, filePath)` 静态方法，单独读消息 frontmatter 用于轻量状态检查

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
class InboxWriter {
  constructor(fs: FileSystem, inboxDir: string, audit: Audit);
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void>;
  writeSync(opts: InboxMessageOptionsBase): void;
  static readMeta(fs: FileSystem, filePath: string): Result<Record<string, string>, InboxMetaError>;
}

interface InboxMessageOptionsBase {
  type: string;
  source: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  body: string;
  to?: string;
  idPrefix?: string;
  filenameTag?: string;
  extraFields?: Record<string, string>;
}

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
| `InboxWriter.write` / `InboxWriter.writeSync` / `OutboxWriter.write` 写文件失败 | 原样抛出（调用方显式处理）✓ |
| `InboxWriter.writeSync` 同步版抛错 | 调用方必须 try/catch |
| `InboxWriter.readMeta` 任何失败（不存在 / parse error / IO） | 返回 `Result<Record<string, string>, InboxMetaError>`，错误可区分。**A.1 已修复（Result ADT）** |
| `drainInbox` `fs.list` 抛非 `FS_NOT_FOUND` 错 | `audit.write(AUDIT_EVENTS.INBOX_LIST_FAILED, reason=...)` + throw `InboxListFailed`（**phase150 已修复**：throw 方向；ENOENT 路径返 [] 为合法空集设计；A.2 已清零）|
| `drainInbox` 单文件解析失败 | `audit.write(AUDIT_EVENTS.INBOX_FAILED, file=..., reason=<真实原因>)` + move 到 failed/（Phase 148 已修复：携带真实 reason 而非遮蔽）|
| `markDone` move 成功 | `audit.write(AUDIT_EVENTS.INBOX_DONE, file=...)` 正面事件 |
| `markDone` / `markFailed` move 失败 | `audit.write(AUDIT_EVENTS.INBOX_MOVE_FAILED, reason=...)` + throw `InboxMoveFailed`（**phase150 已修复**：throw 方向；A.3 已清零）|
| `OutboxWriter.write` 成功 | `audit.write(AUDIT_EVENTS.OUTBOX_SENT, to=..., type=..., id=...)` 正面事件（Phase 148 已修复）|
| `OutboxWriter.write` 失败 | `audit.write(AUDIT_EVENTS.OUTBOX_SEND_FAILED, to=..., reason=...)` 后 **throw 原错**冒泡给调用方（Phase 148 已修复，audit 不替代错误冒泡）|
| `InboxWriter.write` / `InboxWriter.writeSync` 写文件失败 | 原样抛出（调用方显式处理）✓ |

## 不可消除的耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Messaging 的 InboxReader / InboxWriter / OutboxWriter 工厂模式即 port 范本（消费方 own / FileSystem + AuditWriter 注入）。

- **Messaging → FileSystem（L1）**：所有写 / 读 / move 走 fs，显式依赖
- **Messaging → MessageCodec（L1）**：encodeOutbox / encodeInbox / decodeInbox / parseFrontmatter 都走 MessageCodec，依赖单向 / **应然消解候选**（phase[TBD]：MessageCodec 内化为 Messaging 内部 helper / 消除 L1 顶级模块 / r43+ 评估）
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

**~~A.1 `readInboxFileMeta` 返回 `null` 吞没所有失败原因~~ → phase150+202/216 已清零（`InboxWriter.readMeta()` 返回 `Result<Record<string, string>, InboxMetaError>`）**

违反原则：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——文件不存在 / parse error / IO error 全部被抹平
- "预期失败由调用方显式处理"——调用方拿到 `null` 无法区分"消息还没到"（正常路径）与"消息格式错误"（需要告警）

修复候选：
- **候选 α**：改为 `readInboxFileMeta(...): { meta } | { error: 'not_found' | 'parse_error' | 'io_error'; detail }`
- **候选 β**：抛错，让调用方 try/catch 区分——与 FS 现有 `FS_NOT_FOUND` 错误码风格一致

**A.2 `drainInbox` list 失败后与"空 inbox"不可区分（Phase 148 部分修复，失败语义留 Phase 150）**

Phase 148 已把 `console.error` 替换为 `audit.write(INBOX_LIST_FAILED, reason=...)`，list 失败的降级信号进入结构化事件流。

~~**仍未修**：`drainInbox` 仍返回 `[]`——调用方无法区分"访问失败"与"空"。~~ → **phase150 已清零**（`inbox-reader.ts:62` throw `InboxListFailed`；调用方可显式 catch 区分失败 vs 空）。

原修复候选（保留供 Phase 150 参考）：
- **候选 α**：`drainInbox()` 抛错，调用方显式处理 list 失败
- **候选 β**：返回 `{ entries: InboxEntry[]; warnings?: Array<{kind, detail}> }`，把降级信号交给调用方

**~~A.3 `markDone` / `markFailed` move 失败吞没导致消息重复处理（修复方向已定，待实施）~~ → phase150 已清零（throw new InboxMoveFailed）**

Phase 148 已把 move 失败从 `console.error + audit?.write('inbox_move_error', ...)` 改为 `audit.write(INBOX_MOVE_FAILED, reason=...)`（audit 必传 + 事件名规范化），运行时可观察。

~~**仍未修**：move 失败**仍不抛**——文件仍在 pending，下轮 drainInbox 会重放，业务副作用可能被重复触发。~~

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
2. ~~`writeInbox` / `writeInboxMessage` / `readInboxFileMeta` 三个 free function 已标 `@deprecated Phase 150 Step 5 过渡`——消费者全量迁到 `InboxWriter` class 是 **Phase 155 scope**~~ **已消化** by phase216（main `ee4202c` / 2026-04-22）：14 call sites 全迁 class 直调 + 3 deprecated free function 定义删 + `foundation/messaging/index.ts` re-export 收敛至仅 `InboxWriter`；phase223 登记补齐

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

**~~A.6 Inbox 写入三套 API 名字分裂~~ → phase216 已清零**

原问题：违反编码规范"同一概念用同一名字"。`writeInbox` 和 `writeInboxMessage` 都是"写 inbox"，名字区分为"带什么参数"而非"做什么事"——调用方要记住哪个 API 对应哪个入参形态。同步 / 异步分裂进一步增加认知负担。

修复：
- **已实施**（phase216）：`writeInbox` / `writeInboxMessage` / `readInboxFileMeta` 三 deprecated free function 全部删除；`InboxWriter` class 为唯一入口（`write` / `writeSync` / `readMeta`），与 `OutboxWriter` 对齐

### B. 偏差登记（当前合理或代价过高）

- **广连接代价登记**：15+ 消费者依赖"目录名 `pending/done/failed` + 文件名 `<ts>_<x>_<uuid8>.md` + YAML frontmatter"三重约定。违反编码规范"减少代码间的依赖：改一处不应连带改多处"——未来改任何一层约定会穿透到所有消费者。当前是"文件即消息"范式的固有代价（消息作为持久化记录必须跨进程可读），不是实现 bug。登记为广连接代价；A.5 修复方向能缩小但无法消除此广连接
- **`OutboxWriter.write` 返回写入路径**：调用方用路径作为"消息 id 替身"追踪状态，违反"耦合界面最小"；但当前消费者路径用途有限，暂不修
- **排序规则内部硬编码**：priority desc + timestamp asc 是唯一策略，未来若有"按 type 优先级"或"按 from agent 优先级"需求需改接口
- **目录名 `pending` / `done` / `failed` 硬编码**：调用方传 `inboxDir` 三个目录的路径，但 Messaging 内部依赖这三个名字约定——算"广连接"的一部分
- **同步 / 异步 API 分裂**：`writeInboxMessage` 同步；`writeInbox` / `InboxReader` / `OutboxWriter` 异步。同步版主要为了 `utils/notify.ts` 等简单 utility——异步化改造代价小但涉及所有调用方。登记
- **`modules.md` 索引层漂移**：~~L122 写 `IAuditSink` 接口、L124 写"导出 send" 工具——代码都不存在~~ → **modules.md 已修正**（AuditLog 导出 `AuditWriter` + `Audit`；send 工具实然存在 `tools/builtins/send.ts`）。phase321 drift 核确认 0 残留。
- ~~**`core/communication/` 历史别名路径**（phase173 P2.15 登记）~~（**phase205 已清除**）：原 `src/core/communication/index.ts` re-export `OutboxWriter` + `OutboxWriteOptions` —— phase205 删除 alias 文件/目录 + 5 消费者 import path 改走 `foundation/messaging/`；`rg "from.*core/communication" src/ tests/` 归零。合入 main `f89bbb8`。

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
- `tests/utils/inbox-writer.test.ts`（9 个 `it`）：覆盖 `InboxWriter.writeSync` / `InboxWriter.readMeta` / 文件名约定 / YAML 转义
- `tests/cli/claw-outbox.test.ts`（4 个 `it`）：CLI 视角的 outbox 集成

**注**：A.1 / A.2 / A.3 修复 phase 需补：
- `readInboxFileMeta` 各类失败源的区分性断言
- `drainInbox` list 失败的降级信号断言
- `markDone` / `markFailed` 失败后的"消息重复处理防护"断言——尤其 A.3 的消息重放场景是当前测试漏洞

A.4 OutboxWriter audit 修复后补"outbox_sent 事件写入"断言。A.5 修复后补"消费者统一走 writeInbox"的集成断言。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A ↔ §A 映射

本契约既有 "§与现状的差异 § A. 必修违规" 节已承担 §7.A 角色。**phase192 实测复核**：

- `grep "console\." src/foundation/messaging/` → **0 命中**（`errors.ts` 26 / `inbox-reader.ts` 140 / `inbox-writer.ts` 135 / `outbox-writer.ts` 93 / `index.ts` 47 = 441 行 5 文件）
- audit 写位点 10+：inbox-reader 4（`INBOX_LIST_FAILED` / `INBOX_FAILED` / `INBOX_MOVE_FAILED` ×2）+ inbox-writer 2（字面量 `'inbox_write_failed'` / `'inbox_written'` → `B.p192-1`）+ outbox-writer 成功/失败对
- §A.1（`readInboxFileMeta` 返 null 吞失败源）→ **phase150 + phase202/216 已清零**（`readInboxFileMeta` free function 由 phase216 删除；`InboxWriter.readMeta()` 替代，返回 `Result<Record<string, string>, InboxMetaError>`，三路区分 not_found/read_failed/parse_failed；phase282 drift 核确认）
- §A.2（`drainInbox` 失败 → `[]`）→ **phase150 已清零**（`c7da35b` throw 方向；非 ENOENT 路径：`audit.write(INBOX_LIST_FAILED)` + throw `InboxListFailed`；ENOENT = 目录未创建 = 合法空集设计，返 [] 合规；phase282 drift 核确认）
- §A.3（`markDone` / `markFailed` move 失败吞）→ **phase150 已清零**（`markDone` / `markFailed` 失败路径 `audit.write(INBOX_MOVE_FAILED)` + throw `InboxMoveFailed`；不吞；phase282 drift 核确认）
- §A.4（OutboxWriter 无 audit）→ **phase148 已清零**（ctor 必传 audit + `OUTBOX_SENT` / `OUTBOX_SEND_FAILED` 事件对 + 失败抛原错冒泡）
- §A.5（上层绕 Messaging 写 inbox/outbox）→ **phase152 已清本体**（`fs.writeAtomic('inbox/pending/...')` 0 命中）；路径字面量归 `types/paths.ts` 留 phase155+
- §A.6（Inbox 写入三 API 名字分裂）→ **phase216 已清零**（`writeInbox` / `writeInboxMessage` / `readInboxFileMeta` 三 free function 删除，`InboxWriter` class 为唯一入口）

**§7.A phase192 新增 = 0**（A.1/A.3/A.6 仍缺但既有编号完整登记 + 判据清晰，不重复计数）。

**§7.A phase282 drift 核 = A.1/A.2/A.3 全部 → 已清零**（代码实然领先契约登记 / phase150+202/216 已修 / 契约 §7.A mapping 本次就地更新；A.4/A.5/A.6 历史清零不变）。

**§7.A phase262 新增 = 0**（notify.ts `console.warn` 评估结论：合规保留）。

#### phase262 notify.ts `console.warn` 合规评估

**来源**：phase259 §7.A 评估挂起 → phase262（r19 分支 E）正式评估。

**实然**：`src/foundation/messaging/notify.ts` L27 — `notifyInbox` catch 块写 `console.warn`，未写 `audit.write`。

**4 态判据**：

| 态 | 适用？ | 理由 |
|---|---|---|
| ① lifecycle 必须 audit | ✗ | notifyInbox 是工具函数，非 lifecycle 事件 |
| ② 失败路径必须 audit | ✗ | `InboxWriter.writeSync` 失败路径自身已在 L78 写 `audit.write('inbox_write_failed', ...)` + rethrow；notifyInbox 传入的 `audit` 对象即 InboxWriter 使用的同一对象，audit 链路连续 |
| ③ 状态完整性 | ✗ | notifyInbox 无持久状态 |
| ④ 结构整治 | ✗ | API 清晰无命名混乱 |

**结论**：`console.warn` 属 **β 形态**（上游 InboxWriter 已用相同 `audit` 对象捕获 `inbox_write_failed`；console.warn 是本地可见性补充，非信息损失点）。**合规保留，§7.A 无新增项。**

### 7.B ↔ §B 映射

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 §B 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - 广连接代价 = **design 决策已存**
> - 目录/文件名约定 = **design 决策已存**
> - `OutboxWriter.write` 返回路径作 id = **design 决策已存**
> - 排序规则硬编码 = **drift**（修法明确）
> - `modules.md` 索引漂移 = **drift**（已修订）
> - **B.p344-messaging-reference**（r42 D fork 新发现）= **合规反例 / 升格独立 feedback**：Messaging audit events 100% 走 `MESSAGING_AUDIT_EVENTS` const（10 处 audit.write 0 字符串硬编码）/ 与 contract / cron / subagent / assembly / skill 5 模块 hardcoded 形成对比 / **可作 r42 B 治理参考模板**
> - **B.p344-codec-1 MessageCodec L1 应然消解未执行**（r42 D fork 新发现）= **drift**（应然 silent / 实然 3 处 import `foundation/message-codec/` / 推 r43+ 应然同步 + Stage 2 物理搬迁）

既有 "§与现状的差异 § B. 偏差登记" 已登 6 条 + `modules.md` 漂移 + `core/communication/` 历史别名：
1. 广连接代价登记（15+ 消费者依赖目录/文件名/frontmatter 三重约定）
2. `OutboxWriter.write` 返回路径作消息 id 替身
3. 排序规则 priority desc + timestamp asc 内部硬编码
4. 目录名 `pending`/`done`/`failed` 硬编码（广连接一部分）
5. ~~同步/异步 API 分裂~~（**phase216 已收敛**：`InboxWriter.write` / `InboxWriter.writeSync` 同属一个 class，调用方按需选方法）
6. `modules.md` L122/L124 索引漂移（`IAuditSink` / `send` 不存在）
7. ~~`core/communication/` 历史别名~~（**phase205 已清除** / alias 文件+目录删 + 5 import 改 / main `f89bbb8`）

**phase192 新增 `B.p192-1`**（顺手清理候选）：

#### B.p192-1 — inbox-writer audit 事件用字面量未走 `AUDIT_EVENTS` 常量

- **现状**：`src/foundation/messaging/inbox-writer.ts:46-49`
  ```ts
  this.audit.write('inbox_write_failed', `file=${filename}`, ...);  // L46 字面量
  this.audit.write('inbox_written', `file=${filename}`, ...);       // L49 字面量
  ```
  而 `inbox-reader.ts` 使用 `AUDIT_EVENTS.INBOX_LIST_FAILED` / `AUDIT_EVENTS.INBOX_FAILED` / `AUDIT_EVENTS.INBOX_MOVE_FAILED` 常量
- **违反原则**：Module Logic #7 耦合界面稳定（inbox 模块内部事件命名不统一） + 编码规范"同一概念用同一名字"
- **风险**：若 `AUDIT_EVENTS.INBOX_WRITE_FAILED` / `INBOX_WRITTEN` 常量新增或 rename，inbox-writer 字面量会 drift；tsc 不报
- **owner**：phase148（audit 事件规范化期）/ phase192（backfill 识别）
- **计划 phase**：顺手清理 —— `foundation/audit/events.ts` 新增 `INBOX_WRITE_FAILED: 'inbox_write_failed'` / `INBOX_WRITTEN: 'inbox_written'`；inbox-writer.ts 2 处字面量换常量引用
- **升档条件**：若未来 `AUDIT_EVENTS` rename 触发 drift（inbox 事件日志产出不对齐 inbox-reader 风格）→ 升格 7.A
- **状态**：~~部分消化（2/4，phase213）~~ → **phase288 全消化（4/4）**：`INBOX_WRITE_FAILED` 常量添加 + 2 字面量改常量引用

### 7.C 原则对照（32 条）

全 32 条覆盖（Module Logic 11 + Design 11 / #1 展 4 面 + Philosophy 4 + Path 6）。深度按需。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。Messaging 职责 = 消息落盘 + 目录生命周期；与"传输"（CLI/Transport）+"schema 校验"（MessageCodec）+"业务语义解释"（调用方）独立可变
- **M2 业务语义归属**：合规。消息文件 IO / 目录状态迁移（pending → done/failed）全在 Messaging
- **M3 资源归属**：**灰度**（既有 §B.1 广连接代价登记）—— 名义归 Messaging 但 15+ 消费者依赖目录名约定；phase152 清零 bypass 本体后剩路径字面量归属（phase155+）
- **M4 持久化**：合规。文件即消息；`writeAtomic` 保证原子
- **M5 依赖单向**：合规。`messaging` → `foundation/fs` + `foundation/message-codec` + `foundation/audit`；无反向
- **M6 依赖结构稳定**：合规。InboxReader / OutboxWriter class + `writeInbox` / `writeInboxMessage` free function 自 phase0 稳定；phase148 audit 从可选升必传
- **M7 耦合界面稳定**：**合规**（phase216 收敛为 `InboxWriter` 单一 class 入口；`B.p192-1` inbox-writer 事件字面量留后续顺手清理）
- **M8 耦合界面最小**：**合规**（phase216 收敛为 `InboxWriter` 3 方法 = write / writeSync / readMeta；无 free function 碎片）
- **M9 显式表达编译器可检**：合规。`InboxMessageOptions` / `OutboxWriteOptions` 强类型；错误类 `InboxMoveError` 等命名明确
- **M10 不合理停下**：合规。`drainInbox` 不抛保证 Runtime 轮询可继续
- **M11 边界不对停下**：~~**部分违反**（既有 §A.3 move 失败不抛 → 消息重放；修复方向已定，Phase 150 scope）~~ → **合规**（A.3 phase150 已 throw new InboxMoveFailed / r31 主会话补 r30 E + r31 B 漏 scope）

#### Design Principles（11 条，#1 展 4 面）

- **D1a 信息不丢失**：**部分违反**（既有 §A.1 `readInboxFileMeta` null 吞失败源；§A.3 move 失败重放 audit 可见但调用方不能响应）
- **D1b 状态可观察**：合规。`pending` / `done` / `failed` 目录即状态；`InboxEntry.filePath` 显式路径
- **D1c 中断可恢复**：合规。目录状态进程重启可重建；failed 文件不消费
- **D1d 事后可审计**：合规（phase148 必传 audit + `INBOX_*` / `OUTBOX_*` 事件对齐；`B.p192-1` 仅内部常量命名瑕疵，不影响事件出）
- **D2 不得丢弃/静默**：**部分违反**（既有 §A.1 `readInboxFileMeta` 吞；§A.3 move 失败吞抛协议未定）
- **D3 用户可观察**：合规（`.md` 文件 inbox / outbox 人类可读；audit 事件流可聚合）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：合规（消息 `.md` + audit 事件对）
- **D6a 决策主体**：无关（Messaging 是基础设施）
- **D6b 子代理不阻塞**：无关
- **D7 系统可信路径**：合规（目录在 WRITABLE_PATHS 内）
- **D8 事件驱动**：合规。inbox 监听由 Runtime 装配用 FileWatcher；Messaging 自身被动接收 API 调用
- **D9 多 claw 不隔绝**：**核心落实者**。P1 / P3 哲学的落盘实现；跨 claw 消息通过 outbox → inbox 目录写入
- **D10 motion 特殊**：无关（motion daemon 用同一 Messaging 原语）
- **D11 CLI 唯一对外**：合规（CLI outbox/inbox 查看属不直写）

#### Philosophy（4 条）

- **P1 上下文工程**：合规。跨 agent 上下文通过 outbox/inbox 传递
- **P2 多 agent 复用**：合规。Messaging 单一代码基服务所有 claw
- **P3 Agent 即目录 / 对话即状态**：**核心落实者**。"多个 claw 信息不应隔绝"通过文件即消息 + 目录即状态双约定落实（Messaging 契约 L3 明示）
- **P4 简单优先 / 持久化为主**：合规。无 DB / 无索引；`.md` 文件 + YAML frontmatter；目录分类三态

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ backfill 前 Read 源码 441 行 + 测试 37 it（inbox 15 + outbox 10 + inbox-writer 12）+ 契约全文 304 行
- **Path #2 差距显式登记**：✓ §A 6 条（A.1-A.6）+ §B 6 条 + phase192 补 `B.p192-1`
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = §7 APPEND
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only / 零代码 / 无破坏性
- **Path #5 完成后复盘**：phase192 Step 3 产出
- **Path #6 冲突立即中断**：未触发（分支 C 与 A/B/D 文件零重叠）

### 7.D 关键决策映射表（modules.md 引用 / 2026-04-27 r42 D 结构合规修：补完）

从 `design/modules.md` §关键设计决策章节迁移。原 KD 编号保留供对账。

| KD | modules.md 描述 | 本契约引用位置 | 一致性 |
|---|---|---|---|
| KD（待编号）| Messaging L2 inbox/outbox 通用消息原语 / pending/done/failed 三态目录约定 | §职责边界 + §6 持久化 | ✓ 一致 |
| KD（待编号）| Messaging 类型物理隔离（types/messaging.ts / phase344 D）/ 不依赖 contract 类型 | §head + §不可消除耦合 | ✓ phase344 D 后 100% align |
| KD（待编号）| Audit event const 模块自治（与 H1 收官一致）| §3 audit events 全经 MESSAGING_AUDIT_EVENTS | ✓ 100% 走 const / **B.p344 合规反例 / 跨模块 reference 模板** |
| **KD（r42 audit fork 新发现）**| MessageCodec L1 应然消解 | **§不可消除耦合 + §B.p344-codec-1（待 r43+ 治理）** | **⚠ drift**（实然 3 处仍 import foundation/message-codec/）|

### 7.Phase 执行纪律

#### phase320 纪律 — 契约描述行 drift 修订（r30 分支 E / 2026-04-25 / design only）

- **scope**：§A 必修违规节 A.1 + A.3 描述行补删除线 + 清零标（r30 C phase317 漏 scope 补救）
- **变更**：A.1 标题加 `~~...~~ → phase150+202/216 已清零`；A.3 标题加 `~~...~~ → phase150 已清零` + "仍未修"段加 `~~...~~`
- **性质**：纯 design / 本地 only / 无代码改动

#### phase317 纪律 — 契约 drift 修订核验（r30 分支 C / 2026-04-25 / design only）

- **scope**：§7.A A.1/A.2/A.3 核验 — 表行已标"已修复/已清零" / 状态准 / 无 drift

#### phase192 纪律 — L2 Messaging backfill（2026-04-21，design 本地 only）

- **scope**：既有契约缺 §7 四子节（§A/§B/§C 已独立存在但未纳入 §7 索引）；按 phase187 L1 "APPEND 不解构"模板补齐
- **产出**：§7.A 映射（0 新增 / 既有 A.1-A.6 phase148/152 部分清零索引）/ §7.B 映射 + 新 `B.p192-1`（inbox-writer 字面量换常量顺手清理候选）/ §7.C 32 条 / §7.Phase（本节）
- **对比组**：
  - phase187 L1 8 条 §7.A 聚合登记 / 9 条 §7.B（5 模块）
  - phase192 SessionStore 0 §7.A 新 / 0 §7.B 新（0 代码改动候选）
  - **phase192 Messaging 0 §7.A 新 / 1 §7.B 新**（B.p192-1 顺手清理 2 行代码级别）—— 与 SessionStore 形成"L2 agent 干净 vs 含顺手清理"对比组
- **方法论贡献**：
  - **L2 agent 语义组 backfill 首批**（本 phase）—— 结合分支 B（L2 纯通用 3 模块）完成 L2 × 5 全 backfill
  - **"backfill 零新增"合法形态**（SessionStore）—— phase192 首次实证"既有 §A/§B 充分时 §7 纯索引"是合法产出
  - **顺手清理候选登记为 B 类的 phase187 模式传承**（`B.p192-1` 与 phase187 `B.p187-1 IGNORE_PATTERN`、phase181 类似 2 行级清理同列）
- **升格候选**（观察 phase193+）：
  - **"backfill 零新增"合法形态**（本 phase SessionStore 首次，分支 B 可能出现其他零新增模块）—— 2 次实证后可升格 `feedback_module_contract_structure`
  - **inbox/outbox audit 事件常量规范化**（`B.p192-1` 若 phase193 `B.p192-1` 顺手清理落地 → 补 `INBOX_WRITE_FAILED` / `INBOX_WRITTEN` 常量）

#### phase205 纪律 — communication alias 消除（2026-04-22，代码 phase / 代码组织整理债 C.2）

**代码组织整理债 C.2 消化**：phase173 P2.15 登记"历史别名 drift"至 phase205 兑现（跨 32 phase）。承 phase202 Result ADT 搬 types/ 之后的第 2 个整理债消化。

- **scope**：删 `src/core/communication/index.ts`（7 行 alias re-export）+ 删空目录 + 5 消费者 import path 改走 `foundation/messaging/`
- **diff 规模**：-7 +5 / 5 文件修
- **受影响**：1 产品（`assembly/assemble.ts:29` type-only）+ 4 测试（`tests/core/builtins.test.ts` / `tests/core/communication.test.ts` / `tests/core/runtime-initialize-failures.test.ts` value import + `tests/helpers/task-system.ts` type-only）
- **验收**：`rg "from.*core/communication" src/ tests/` 归零 ✓ / `ls src/core/communication/` 目录不存在 ✓ / tsc 0 errors / vitest 全过
- **合入**：main `f89bbb8`（phase202 `001676b` → phase203 `47d1e2b` → phase205 `f89bbb8`）
- **Path 对照**：
  - Path #1 ✓（Step 1 扫描 5 消费者 + 方向反转核 + `vi.mock` 透穿核 0 命中 + 契约引用核）
  - Path #2 ✓（既有 §B.7 登记至本 phase 兑现）
  - Path #3 ✓（单一意图 = 删 alias + 5 import / 单 commit）
  - Path #4 ✓（5 要素 commit msg：What / Why / Before-After / Risk / Rollback 全覆盖）
  - Path #5 ✓（phase205 纪律复盘 + memory 登记）
  - Path #6 未触发（r6 分支零文件重叠；ff merge 一次成功）
- **方法论贡献**：
  - **"历史别名一步消除模板"首次** —— 与 phase184/188 review_request "两步法非破坏"迁移不同：alias 因无语义差异，可一步删除 + 消费者同步改（phase205 首实证）
  - **r6 代码 phase 模板复用第 2 次**（phase202 首次 / phase205 验证）—— 起步 SHA 冻结 / 5 要素 commit msg / Step 7 节硬结构 / 22 条原则扫描 四要素模板稳定
  - **"副发现登记不越界"模式**（`B.p205-1` 候选：`tests/core/communication.test.ts` 文件名 rename / merge 独立评估）—— phase205 Step 1 识别副发现但不扩 scope，登 B 类候选推迟独立 phase
- **副发现登记**：
  - `B.p205-1` 候选：`tests/core/communication.test.ts`（8 it）文件名引用已删模块 + 与 `tests/core/outbox.test.ts`（10 it）语义可能重叠 —— 独立 phase 评估 rename / merge（r7+ scope）
- **升格候选**（观察 phase206+）：
  - **"历史别名消除模板"**（本 phase 首实证）—— 2 次验证后可升格 feedback；触发判据：alias = re-export 无语义差异（vs review_request 跨模块归属迁移需两步法）

#### phase223 纪律 — drift 修订登记补齐（2026-04-22，r10 分支 C / design 本地 only）

承 phase208 "登记补齐" phase 形态（phase 第 4 类）+ phase196 drift 就地改策略。本 phase 消化 phase216 合入后遗留的契约登记 drift —— §2 已自然修订但头 blockquote 未同步 / A.5 留尾未标已消化 / B.p192-1 状态未推进。

- **scope**：3 处登记同步（头 blockquote / A.5 item 2 / B.p192-1 状态字段）+ §7.Phase 本条登记
- **发现的 drift**：
  - 头 blockquote L5-7 声称 "§2 仍登记 free function 描述" —— phase216 合入时 §2 已自然修订为 InboxWriter class 形态 / blockquote 声明 outdated
  - A.5 留尾 item 2 声称 "3 free function deprecated 未删 / Phase 155 scope" —— phase216 已删 free functions + 收敛 re-export / 留尾声明 outdated
  - B.p192-1 登记 "inbox-writer 2 处字面量" —— phase213 已部分消化（INBOX_WRITTEN 常量 + 2/4 字面量切）/ 状态字段未推进
- **消化处置**：
  - 头 blockquote 加 "drift 已消化 by phase223" 后缀（保留历史 / 标消化）
  - A.5 item 2 加 "~~未完成~~ 已消化 by phase216" 划去 + 推进
  - B.p192-1 加 "**部分消化** by phase213 (f699090 / 2/4)" 状态字段
- **Path 对照**：
  - Path #1 ✓ 4 处 grep 实然核（§2 内容 / 头 blockquote 行号 / inbox-writer.ts 当前字面量 / events.ts INBOX_WRITTEN）
  - Path #2 ✓ drift 登记同步（登记 vs 实然差距兑现）
  - Path #3 ✓ 单一意图 = drift 修订 3 处 / 不扩 scope
  - Path #4 ✓ design 本地 only / 无破坏性
  - Path #5 ✓ phase223 纪律复盘
  - Path #6 部分触发（phase 号 219-222 被占 / Path #6 顺延 4 次）
- **方法论贡献**：
  - **"登记补齐" phase 单模块版**（phase208 全局版 5 项 / phase223 单模块 3 项）—— phase 第 4 类"登记补齐"2 次实证
  - **"drift 登记自 drift"识别**：登记 drift 的 blockquote / 留尾 / 状态字段 本身也会 drift —— 需周期性 Path #1 复核（phase218 G5 纠错 + phase223 blockquote 校准双重实证）
  - **"部分消化"状态字段格式**（B.p192-1 2/4 形态）—— 细粒度进度表达 / 承 phase217 "X/N 已消化" 累进模板
- **升格候选**（观察 r11+）:
  - "drift 登记自 drift"模式（phase218 + phase223 达 2 次阈值 / r11 Meta 可升格 `feedback_verify_facts_before_plan`"登记同步"子节）
  - "登记补齐" phase 单模块版 vs 全局版（规模分层 / 候选扩展）

#### phase259 纪律 — notify.ts 归属迁移（2026-04-24，r18 分支 D / 代码组织整理债 B.1 闭环）

承 phase221 "notify.ts 保留登记 / 绑 B.2 重审归属"，B.2 Monitor 废止完工（phase252 main `e15244c`）后解锁。

- **scope**：`src/utils/notify.ts` → `src/foundation/messaging/notify.ts`（Path #7 归属迁移）+ `notifyInbox` / `notifySystem` re-export 加入 messaging/index.ts + dead `fsNative` import 清理 + 3 消费者 import 路径改 + utils/ 目录删除
- **归属判据**：thin wrapper 二分判据（60 行 + 有 try/catch 降级 + 有预设参数 = 非 thin）→ Path #7 归属评估 → 业务语义 = InboxWriter 的 error-safe wrapper → 归 `foundation/messaging/`
- **消费者**：`src/core/cron/jobs/contract-observer.ts:4` / `src/cli/commands/contract.ts:14` / `src/cli/commands/daemon-loop.ts:29` → 全改走 `foundation/messaging/index.js`
- **整理债 B.1 完工**：utils/ 完全清空（error.ts phase221 / inbox-writer.ts phase216 / notify.ts phase259）
- **D.1 批 4 同步确认**：Heartbeat 早已消化 / WatcherInstaller 不存在 / JsonlLogger 归 B.p248-1 scope → D.1 批 4 闭环
- **§7.A 评估**：notify.ts 内 `console.warn` 属降级通知路径 / 归入 messaging 后 §7.A 评估归契约 backfill 独立 phase

#### phase262 纪律 — notify.ts §7.A 评估（2026-04-24，r19 分支 E）

承 phase259 纪律"§7.A 评估归契约 backfill 独立 phase"挂起，r19 E 正式评估。

- **结论**：§7.A 无新增项 / notify.ts `console.warn` 合规保留（β 形态 / InboxWriter 上游 audit 覆盖）
- **Path #1 实然核**：`writeSync` L78 `audit.write('inbox_write_failed', ...)` + `throw e` — audit 链路连续；`console.warn` 仅本地可见性补充
- **4 态判据**：全 4 态均不适用（见 §7.A phase262 节）
- **性质**：纯 design phase / 零代码 / 零 git / 本地 only

#### phase288 纪律 — B.p192-1 全消化 + l5_runtime dead imports（r23 D / 2026-04-24 / `4616d15`）

- **scope**：l2_messaging B.p192-1 inbox_write_failed 字面量 4/4 全消化 + l5_runtime dead imports 清零（两债合并一 phase）
- **#14 状态**：`INBOX_WRITE_FAILED` 常量缺失 → 范围微扩（+1 行 events.ts），方向不变，继续实施
- **本契约变更**：B.p192-1 → 全消化 4/4（`'inbox_write_failed'` × 2 → `AUDIT_EVENTS.INBOX_WRITE_FAILED`）
- **l5_runtime 联动**：dead imports 4 行删除，l5_runtime.md §7.A 候选.5 同步标清零

#### phase282 纪律 — §7.A drift 修订（2026-04-25，r22 分支 D / design 本地 only）

承 r22 D §7.A 余 7 条识别（phase282）Path #1 全核，发现 Messaging §7.A mapping A.1/A.2/A.3 三条契约落后实然（phase150+202/216 已修复 / 契约从未同步）。

- **drift 核结果**：A.1/A.2/A.3 全部代码已合规 → §7.A mapping 三条标"已清零" + §2 接口表 2 处同步（L137 drainInbox throw 方向 / L140 markDone/markFailed throw）
- **修复 phase**：A.1 = phase150+phase202+phase216（readMeta Result ADT）；A.2/A.3 = phase150 step2（throw 方向）
- **#14 触发**：r22 D Step 1 扫描发现合规反转（分发表假设"3 条代码实施" → 实测"3 条契约 drift"）/ 用户确认后继续
- **性质**：纯 design phase / 零代码 / 零 git / 本地 only

#### phase[TBD] 纪律 — MessageCodec L1 应然消解（2026-04-26，r31，design 本地 only）

承架构决策：MessageCodec L1 模块应然废止 / 消解为两块。本契约登记 Messaging 侧的 drift（实然依赖移除待 Stage 2 物理内化）。

- **drift 1（消解 1）**：MessageCodec L1 应然消解 / inbox/outbox 编解码逻辑应然内化进 Messaging 模块（作为模块内部 helper / 不暴露独立模块）
  - 应然形态：`src/foundation/messaging/codec/` 内部 helper（或同级 `inbox-codec.ts` / `outbox-codec.ts`）/ 仅 Messaging 模块内部 import
  - 实然形态：编解码逻辑物理仍在 `src/foundation/message-codec/` 顶级模块；Messaging 通过外部 import 使用
  - 治理路径：Stage 2 物理搬迁（`message-codec/{inbox,outbox,validation}.ts` → `messaging/codec/`）+ Messaging import 路径改 + `message-codec/` 顶级模块物理删除
  - 影响范围：1 真消费者（Messaging 自身）；其他历史消费者（SkillSystem / memory_search builtin）只用 frontmatter 解析，归 drift 2 治理
- **drift 2（消解 2）**：`parseFrontmatter` 应然沉为项目 utility（不入 modules.md / 不算模块）
  - 应然形态：`src/utils/frontmatter.ts` 或类似 utility 位置 / 通用 YAML frontmatter 解析 / 跨模块复用（SkillSystem skill metadata + memory_search builtin + 未来扩展）
  - 实然形态：`parseFrontmatter` 当前定义在 `src/foundation/message-codec/frontmatter.ts`；既被 Messaging 内部 codec 用，又被外部 SkillSystem / memory_search builtin 用
  - 治理路径：Stage 2 物理搬迁（`message-codec/frontmatter.ts` → `utils/frontmatter.ts`）+ 所有消费者 import 改 + 不入 modules.md（utility 不算模块）
- **性质**：纯 design / 本地 only / 无代码改动 / Stage 2 物理消解独立 phase 实施
