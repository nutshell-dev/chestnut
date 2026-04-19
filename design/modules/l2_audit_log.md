# AuditLog 接口契约

L2 状态迁移审计记录。纯追加写，服务于"运行中产生的所有信息全量记录以供审计"与"事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"。

归属：L2 基础设施。依赖：FileSystem（L1）。被调用：Daemon、Runtime、ContractSystem、SubagentSystem、ContextExec、ToolExecutor、Watchdog、SubAgent、Messaging（inbox+outbox 全链路）、Snapshot、FileWatcher、Stream、ProcessManager、SessionStore（Phase 148 起所有 L2 模块均必需注入）。

## 职责边界

### 做

1. 追加写单条审计记录：`timestamp \t type \t ...cols`，以 `\n` 结尾
2. 时间戳由本模块生成（ISO 8601 via `new Date().toISOString()`），调用方不传
3. 字段转义：`\t` / `\n` 字面写入前转为 `\\t` / `\\n`，保证 TSV 可解析
4. 可选按大小轮转：超过 `maxSizeMb` 时把当前文件 move 到 `<path>.<now>.bak`，新写入从空文件开始
5. 写失败不抛、不冒泡——原则要求"审计不得反过来卡死业务"，失败通过 `console.warn` 暴露

### 不做

- 不解析审计语义（`type` 与 `cols` 对 AuditLog 是 opaque；各消费者自定义 schema）
- 不做 schema 校验（字段数量、类型、顺序由消费者约定）
- 不做查询 / 读取（audit.tsv 的消费是事后 grep / 离线分析，不走 AuditLog 模块）
- 不做跨进程并发写协调（依赖 FS `appendSync` 的原子性；多 writer 同时写要由调用方保证单实例）
- 不做加密 / 签名 / 压缩
- 不做 rotation 历史归档管理（`.bak` 文件的清理归运维 / 未来的 log janitor）

## 接口

```ts
interface Audit {
  /**
   * 追加一条审计。type 为事件类别，cols 为该类事件的字段。
   * 时间戳由实现自动生成，调用方不传。
   * 写失败不抛——见失败语义。
   */
  write(type: string, ...cols: (string | number)[]): void;
}

class AuditWriter implements Audit {
  constructor(fs: FileSystem, filePath: string, maxSizeMb?: number | null);
  // maxSizeMb: undefined / null / 0 = 不轮转；>0 = 超过时 rotate
}

/**
 * 装配助手（Phase 148 Step 9 新增）：构造 `<baseDir>/audit.tsv` 指向的 AuditWriter。
 * 用于 CLI 无 runtime 上下文时（如 motion.ts 的 ProcessManager 装配），
 * 统一 audit.tsv 路径约定，避免调用点各自拼路径。
 */
function createSystemAudit(fs: FileSystem, baseDir: string): Audit;
```

输出格式（TSV）：

```
2026-04-18T10:30:00.000Z\tdaemon_started\tpid=12345\tclawId=motion\n
2026-04-18T10:31:15.123Z\tcontract_transition\tid=abc\tfrom=pending\tto=verifying\n
```

关键约定：
- **字段结构由消费者约定**：AuditLog 不负责定义每种 type 的 cols schema；调用方需在自己的模块契约里声明（如 ContractSystem 契约定义 `contract_transition` 的字段）
- **时间戳总是第一列，type 总是第二列**——调用方不传 ts
- **转义只处理 TSV 必需的两类字符**（`\t` / `\n`），其他字符原样写（调用方传入的 `\\` 不做二次转义）

## 失败语义

| 失败源 | AuditLog 行为 |
|---|---|
| FileSystem `appendSync` 抛错（磁盘满 / 权限 / 路径越界） | catch + `console.error('[AUDIT CRITICAL] ...')` 兜底，**不抛**、不冒泡。**Phase 148 已审定保留**（递归边界例外，见 A.1）|
| rotation 的 `statSync` 抛 `FileNotFoundError`（首次写入） | 静默跳过（正常路径） |
| rotation 的 `statSync` 抛其他错误 | `console.error('[AUDIT CRITICAL] rotation check failed: ...')` 兜底，继续尝试 append（递归边界例外，Phase 148 审定）|
| rotation 的 `moveSync` 抛错 | 向上传到 write 的 catch，走"write failed" warn 路径 |
| `type` / `cols` 为 `undefined` | 按 `String(undefined) = 'undefined'` 写入；无校验 |

## 不可消除的耦合

- **AuditLog → FileSystem（L1）**：显式依赖，通过构造注入。
- **AuditLog ← 众多消费者（广连接但单向）**：Daemon / Runtime / ContractSystem / SubagentSystem / ContextExec / ToolExecutor / Watchdog / SubAgent / Messaging（规划）等多方写同一 `audit.tsv`。每个消费者对自己的事件 schema 负责，AuditLog 不协调。写方向多对一，AuditLog 不知道谁在写——符合"模块为自己的业务语义负责"。
- **时间戳生成权归 AuditLog 独占**：`write(type, ...cols)` 签名里调用方不传时间戳，由 AuditWriter 内部 `new Date().toISOString()` 生成。这是 AuditLog 与所有消费者之间的一条隐含契约——"审计记录的时间以 AuditLog 侧时钟为准"——显式登记为不可消除耦合，避免未来有人想扩 `write(ts, type, ...)` 破坏界面稳定。设计动机：若每个消费者传自己的时间戳，audit.tsv 里会混入不同时钟源，事后重建决策链路时序会错乱。

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `filePath` | 调用方装配期传入 | 本模块不决定路径（通常 `<clawDir>/audit.tsv`） |
| `maxSizeMb` | 调用方装配期传入 | 可选；null / undefined / 0 = 不轮转 |
| 轮转 `.bak` 文件命名（`<path>.<now>.bak`） | 内部实现 | 调用方无法定制 |
| 转义字符集（`\t` / `\n`） | 内部实现 | TSV 格式固有 |
| 时间戳格式（ISO 8601 via `toISOString()`） | 内部实现 | 调用方不传、不定制 |
| `IGNORE_PATTERN` 导出 | **对外导出**（配合 Snapshot A.7 修复） | AuditLog 作为 `audit.tsv` 的归属模块，对外导出供 Snapshot 装配 gitignore 聚合；消费方引用常量而非字面量，让编译器在 AuditLog 改名时捕获 drift |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 写失败只进 console 兜底（Phase 148 已审定保留——递归边界例外）**

违反原则（原登记）：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"——审计失败信息仅进 log 文本
- "事后仅凭日志和记录能完整重建决策链路"——审计自身失败无结构化痕迹
- 编码规范"不可预期失败暴露而非吞没"——write 失败是可预期的（磁盘满、权限），应暴露

**Phase 148 审定结果（2026-04）**：保留 `console.error('[AUDIT CRITICAL] ...')` 兜底。原因：

- AuditWriter 自身是结构化事件流的终点，write 失败若再走 `audit.write()` 记录会无限递归
- 兜底通道必须落在审计系统之外。当前方案是 `[AUDIT CRITICAL]` 前缀的 stderr，便于运维 grep 告警
- 这是 L2 层**唯一**被审定允许保留 console 出口的位置（`writer.ts` 的 `catch` 分支）
- **不扩展到其他 L2 模块**：Phase 148 已把 SessionStore / Snapshot / FileWatcher / Stream / Messaging / ProcessManager 全部 audit 化；未来 L2 新增模块亦不得以"兜底"为由保留 console

未来修复方向（Phase 150+ 可选）：
- **候选 α**：引入独立 emergency log channel（另写一个文件或专用 fd），把 audit 自身失败持久化到非 audit.tsv 通道
- **候选 β**：write 失败切换到内存 ring buffer 暂存直到下次 flush 成功
- **候选 γ**：系统层（Daemon）订阅 audit error stream，触发告警

### B. 偏差登记（当前合理）

- **AuditLog 自身失败无法被 audit 记录**：固有递归边界——审计系统不能用审计系统自己记录自己的失败。`console.error('[AUDIT CRITICAL] ...')` 是当前唯一出口（Phase 148 审定保留，见 A.1）。候选出路：系统层（Daemon）用独立的 emergency log channel（写 stderr 或另一个文件）记录 audit 失败事件。不是违规，是结构性边界。
- **L2 console 出口收口（Phase 148 审定）**：本模块 `writer.ts` 的 2 处 `console.error('[AUDIT CRITICAL] ...')` 是 L2 层**唯一**允许保留的 console 出口。其他 L2 模块（SessionStore / Snapshot / FileWatcher / Stream / Messaging / ProcessManager）在 Phase 148 已全部 audit 化；未来 L2 新增模块不得效仿此例外。
- **rotation 策略简单**：按大小切；不做时间切、不做保留数量限制、不做压缩。当前 MVP 需求不驱动；登记待未来。
- **多消费者并发写**：依赖 `FileSystem.appendSync` 的原子性（POSIX `O_APPEND` 单 write 原子 `< PIPE_BUF` 字节）。对每行几百字节的审计记录通常安全；理论上跨多进程并发写同一文件在极端大行下可能交错。当前被"同 claw 单 daemon"约定兜住（`ProcessManager` 保证单实例）。
- **`maxSizeMb: number | null | undefined` 语义冗余**：`null` 和 `undefined` 都表示不轮转，`0` 也等效。违反编码规范"名字准确反映意图"——同一语义三种表达。未来可统一为 `undefined`。
- **`modules.md` 索引层漂移**：modules.md L110 写"导出 `IAuditSink`（最小接口，供 L2 消费者注入）"——代码里 grep `AuditSink` / `IAuditSink` 零命中，实际导出的 interface 名为 `Audit`。这是索引层对一个从未落地的"计划接口"的遗留描述。Step 13 一致性自检时统一修正索引文本（本 step 不改，避免 step 间交叉改动放大 diff）。

### C. 原则对照补充

- **"持久化一切信息到磁盘"**：audit.tsv 纯追加写 ✓
- **"中断可恢复"**：纯追加 + 每行独立时间戳 → 进程重启后继续追加，历史不受影响 ✓
- **"事后可审计"**：AuditLog 的核心使命，整个模块为此存在 ✓（A.1 是缺口的自身失败路径）
- **"模块为自己的业务语义负责"**：AuditLog 只负责"追加审计记录"，不理解事件语义；schema 归各消费者 ✓
- **"每种资源只归属唯一模块"**：audit.tsv 归 AuditLog ✓；消费者通过 `Audit.write()` 间接访问 ✓

## 测试覆盖现状

`src/foundation/audit/` 共 64 行，未见独立测试文件；行为由消费侧测试间接覆盖。修复 phase 引入结构化 error sink 时需补：rotation 触发、write 失败 sink 回调、转义正确性、多 type 交叉写入的断言。
