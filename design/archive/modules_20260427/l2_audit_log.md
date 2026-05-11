# AuditLog 接口契约

L2 状态迁移审计记录。纯追加写，服务于"运行中产生的所有信息全量记录以供审计"与"事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"。

归属：L2 基础设施。依赖：FileSystem（L1）。

**应然**（2026-04-26 修订 / 跟 modules.md ~~§9~~ §8 align）：
- **装配归属**：按需（任何需要审计追加写的 daemon 装 / audit.tsv 路径由调用方指定）
- **被谁调用**：所有需要审计的模块（generic writer / 不预设调用者集合）
- AuditLog 是 generic writer / 不知模块语义；event names + payload schemas 归各上游模块自己业务（在各 modules/*.md §3 审计事件清单声明）

**实然**：Phase 148 起所有 L2 模块均必需注入；当前已知调用者 Daemon、Runtime、ContractSystem、SubagentSystem、ContextExec、ToolExecutor、Watchdog、SubAgent、Messaging（inbox+outbox 全链路）、Snapshot、FileWatcher、Stream、ProcessManager、SessionStore。详 §7。

## 职责边界

### 做

1. 追加写单条审计记录：`timestamp \t type \t ...cols`，以 `\n` 结尾
2. 时间戳由本模块生成（ISO 8601 via `new Date().toISOString()`），调用方不传
3. 字段转义：`\t` / `\n` 字面写入前转为 `\\t` / `\\n`，保证 TSV 可解析
4. 可选按大小轮转：超过 `maxSizeMb` 时把当前文件 move 到 `<path>.<now>.bak`，新写入从空文件开始
5. 写失败不抛、不冒泡——原则要求"审计不得反过来卡死业务"，失败通过 `console.warn` 暴露

### 不做

- 不解析审计语义（`type` 与 `cols` 对 AuditLog 是 opaque；各消费者自定义 schema）
- 不维护 event name 清单 / 不预设调用方模块的事件命名空间（event names 归各上游模块业务）
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

/**
 * 装配工厂（phase212 新增）：与 createSystemAudit 同层并存；filePath-style 与 baseDir-style 语义分层。
 * - `createSystemAudit(fs, baseDir)` — CLI no-runtime 场景；内部 `path.join(baseDir, 'audit.tsv')` 绝对路径
 * - `createAuditWriter(fs, filePath, maxSizeMb?)` — Assembly 装配场景；filePath 相对 fs.baseDir（默认 `'audit.tsv'`）；支持大小轮转阈值
 *
 * 合入 main `5968b3a`（r8 分支 D / D.1 工厂批 1 / 3 工厂并行切换首次）
 */
function createAuditWriter(fs: FileSystem, filePath: string, maxSizeMb?: number | null): Audit;
```

输出格式（TSV）：

```
2026-04-18T10:30:00.000Z\tdaemon_started\tpid=12345\tclawId=motion\n
2026-04-18T10:31:15.123Z\tcontract_transition\tid=abc\tfrom=pending\tto=verifying\n
```

关键约定：
- **字段结构由消费者约定**：AuditLog 不负责定义每种 type 的 cols schema；调用方需在自己的模块契约里声明（如 ContractSystem 契约定义 `contract_transition` 的字段）
- **event name 是 generic string**：AuditLog 不维护事件名清单 / 不知道 event 含义；event name 命名空间归调用方业务模块（如 `WATCHER_*` 归 FileWatcher / `SESSION_*` 归 SessionStore）
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

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。AuditLog 自身就是 port 范本（消费方 = 所有 caller / 协议 = AuditWriter interface / FileSystem 注入实现）。

- **AuditLog → FileSystem（L1）**：显式依赖，通过构造注入。
- **AuditLog ← 众多消费者（广连接但单向）**：所有需要审计的模块多方写同一 `audit.tsv`（generic writer / AuditLog 不知道谁在写、写什么 event）。每个消费者对自己的 event name + payload schema 负责，AuditLog 不协调。写方向多对一，符合"模块为自己的业务语义负责"。
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
- **`modules.md` 索引层漂移**：~~modules.md L110 写"导出 `IAuditSink`（最小接口，供 L2 消费者注入）"——代码里 grep `AuditSink` / `IAuditSink` 零命中，实际导出的 interface 名为 `Audit`。这是索引层对一个从未落地的"计划接口"的遗留描述。~~ → **modules.md 已修正**（导出 `AuditWriter` + `Audit` type alias）。phase321 drift 核确认 `IAuditSink` 0 命中。
- **chat-viewport 事件 schema 暂存 `events.ts` JSDoc**（phase164）：chat-viewport (CLI L6) 作为 audit 消费者，按本契约 §接口声明 4 事件（`VIEWPORT_EVENT_INGEST` / `VIEWPORT_RENDER_BATCH` / `VIEWPORT_SPINNER_LIFECYCLE` / `VIEWPORT_SHUTDOWN`）字段。原计划第 5 事件 `VIEWPORT_STREAM_DETACHED` 已于 phase164 Step 11 移除——streamReader 不暴露 onError/onEnd hook，无生产触发路径；对外承诺「要能兑现」原则优先于「事件清单完整性」。未来 streamReader 扩 hook 或独立 l6 契约落地时重建。
- **Monitor 模块废止迁移登记**（2026-04-21 phase173 决策；代码未动，登记应然方向）：`foundation/monitor/`（JsonlLogger，226 行 / 写 `logs/monitor.jsonl`）是 Phase 148 audit 化后的**残留 debug 日志通道**。职责上与 AuditLog 的"内部错误记录"段语义重合，违反 Design Principle "事后仅凭日志和记录能完整重建运行状态和决策链路"要求的**单一事实源**。决策：**未来独立 phase 废止 Monitor 模块，74 处 `monitor.log('error', ...)` 调用点迁移到 `audit.write('<event>', ..., stack=err.stack)`；stack trace 走 audit 的 escape 机制全量存，肉眼可读性由未来 CLI `clawforum audit --scope debug` 视图命令承担**。迁移 scope：
  - 新增 ~15-20 个 debug-scoped audit 事件（在 `foundation/audit/events.ts`，可选单独 namespace 或分类元信息表 `EVENT_CATEGORIES: Record<AuditEventName, 'business' | 'debug'>`）
  - 74 处 call site 重构（TaskSystem 44 / ContractManager 17 / Dispatch 5 / Status 3 / SubAgent 3 / Runtime 1 / Heartbeat 1）
  - 删 `foundation/monitor/` + `Logger` 字段从 10+ 处 interface / ctor 移除
  - Assembly 不再 new JsonlLogger
  - 可选同 phase 或后续 phase 加 CLI `audit` 视图命令（按 event category / event name / claw / since 过滤 + 可读格式化）
  - 迁移可分 3 个 sub-phase：(A) TaskSystem 单独（60% call site）/ (B) ContractManager + 工具层（35%）/ (C) 零散 + 框架删除
  - 本契约在迁移 phase 落地后更新 §3 审计事件清单（本 contract 原以业务事件为主，扩展到 business + debug 双类别）
  - 与 Monitor 并存期间（当前状态）：Monitor 作为"废止 grace period"存在，本契约 B 类登记后 modules.md 不把 Monitor 登记为正式 L2 模块（永远不会登记）

#### B.p173-1 — AUDIT_EVENTS 集中定义违反 M2/M5

- **现状**：`src/foundation/audit/events.ts`（115 行）集中登记其他模块的事件常量：`SESSION_*`（SessionStore）/ `SNAPSHOT_*`（Snapshot）/ `WATCHER_*`（FileWatcher）/ `STREAM_*`（Stream）/ `INBOX_*` / `OUTBOX_*`（Messaging）/ ProcessManager 事件等
- **违规判据**：AuditLog（L2 记录设施）**预设了其他模块的业务事件集合**——"SessionStore 会失败于 load/save/corrupted 这些场景"是 SessionStore 自己的业务语义（M2「模块为自己的业务语义负责」），"记录什么内容"归调用方业务模块发起；集中定义违反 M2 + M5 亲属原则"模块不预设别模块语义"
- **phase 148 原当理由**（驳回）：
  - "命名冲突避免 / 单一事实源" → 实际文件注释已规定命名约定 `<module>_<action>_<outcome>`，约定即可去重，不需集中
  - "CLI 消费时全集映射" → 装配期聚合各模块导出的事件集即可（同 Snapshot `ignorePatterns` 聚合模式）
- **修复方向**：
  - AuditLog 回归纯原语 `write(name: string, meta)`——name 是 generic string，不维护事件名清单
  - 各业务模块导出自己的事件常量集：SessionStore 导出 `SESSION_EVENTS`、Snapshot 导出 `SNAPSHOT_EVENTS` 等；同构 `IGNORE_PATTERN` 的归属方式
  - `AUDIT_EVENTS` 作为聚合器由 Assembly 或 audit viewer 侧装配时从各模块导出的事件集拼合
  - 与 B 类 Monitor 废止迁移同 phase 推进（都涉 audit 事件集重整）
- **owner**：未定，归属下一轮 audit 相关重构（phase17x+）
- **升档条件**：若在 audit viewer 接入或 debug 事件扩展时暴露更多维护困境，升 7.A

### C. 原则对照补充

- **"持久化一切信息到磁盘"**：audit.tsv 纯追加写 ✓
- **"中断可恢复"**：纯追加 + 每行独立时间戳 → 进程重启后继续追加，历史不受影响 ✓
- **"事后可审计"**：AuditLog 的核心使命，整个模块为此存在 ✓（A.1 是缺口的自身失败路径）
- **"模块为自己的业务语义负责"**：AuditLog 只负责"追加审计记录"（generic writer），不理解 event 语义；event name + payload schema 归各消费者业务 ✓（应然；实然 §7 §B.p173-1 登记 `AUDIT_EVENTS` 集中常量违反此条）
- **"每种资源只归属唯一模块"**：audit.tsv 归 AuditLog ✓；消费者通过 `Audit.write()` 间接访问 ✓

## 测试覆盖现状

`src/foundation/audit/` 共 64 行，未见独立测试文件；行为由消费侧测试间接覆盖。修复 phase 引入结构化 error sink 时需补：rotation 触发、write 失败 sink 回调、转义正确性、多 type 交叉写入的断言。

---

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**当前未修复必修违规：零条**。

既有 §A.1 状态特殊说明：

| §A 条 | 状态 | 决策 phase | 性质 |
|---|---|---|---|
| A.1 write 失败 console 兜底 | phase148 **审定保留**（非违规） | 148 | **递归边界例外**：AuditLog 是事件流终点，自身失败不能再走 audit.write（无限递归）；`console.error('[AUDIT CRITICAL]')` 是 L2 **唯一**允许保留的 console 出口；不扩展到其他 L2 |

**判据说明**（phase181/187 立范）：
- 一般 L2 软吞 console → 必修违规（§A）
- AuditLog A.1 属**结构性递归边界**，非软吞 → 审定保留 → 不登 §7.A
- 未来修复方向（§B.1）：独立 emergency log channel / ring buffer / 系统层订阅，三选一；非必修

### 7.B ↔ §与现状的差异 节

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 §B 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - AuditLog 自身递归边界 = **design 决策已存**（非 drift / 非 design-gap）
> - L2 console 出口收口 = **design 决策已存**
> - rotation 策略简单 / multi-writer / maxSizeMb 三值 / chat-viewport JSDoc = **drift**（修法明确）
> - `IAuditSink` 索引漂移 = **drift**
> - **B.p344-X caller audit event 字符串硬编码扩散**（r42 D fork 新发现 / 5 模块 = contract + cron + subagent + assembly + 待核 runtime / drift type / r42 B 治理并轨候选 / 「模块 audit event const 自治」升格独立 feedback 候选）
> - **B.p344-Y `new AuditWriter` 7 处直实例化**（应统一经 createAuditWriter / createSystemAudit 工厂 / drift type / 推 r43+）

映射既有 §B 6 条 + `B.p173-1`（保留不解构，各条附升档条件）：

| §B 条 | 当前判定 | 升档条件 |
|---|---|---|
| AuditLog 自身失败无法被 audit 记录（递归边界） | 结构性边界（非违规） | 候选 α/β/γ 任一落地则解除 |
| L2 console 出口收口（writer.ts 唯一出口） | 审定保留 | 其他 L2 新增模块不得以"兜底"为由保留 console |
| rotation 策略简单（按大小切） | 合规（MVP 不驱动） | 磁盘告警 / 保留窗口需求 → 扩时间切 / 保留数 / 压缩 |
| 多消费者并发写（POSIX `O_APPEND`） | 合规（当前被 ProcessManager 单 daemon 约定兜住） | 跨进程并发写 → 升级 lock / FIFO |
| `maxSizeMb: number \| null \| undefined` 三值 | 命名冗余（合规偏差） | 配置 typo 导致 runtime bug → 升 A |
| `modules.md` 索引层漂移（`IAuditSink` 不存在） | 文档 drift（低优先级） | 索引层一致性自检 phase 统一修 |
| chat-viewport 事件 schema 暂存 events.ts JSDoc | phase164 决策保留 | l6_chat_viewport 契约落地 → 迁出 |
| **B.p173-1** Monitor 废止迁移登记 | 应然方向登记（代码未动） | 启动 Monitor 废止 phase（TaskSystem/ContractManager/工具层三子 phase）|
| **B.p173-1** AUDIT_EVENTS 集中定义违反 M2/M5 | 当前合规偏差 | audit viewer 接入或 debug 事件扩展暴露维护困境 → 升 A |

### 7.C 原则对照（32 条，合规一行按需扩展）

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。单一职责 = 审计事件追加 + 字段转义 + rotation
- **M2 业务语义归属**：**部分违反**（B.p173-1）。`AUDIT_EVENTS` 集中定义预设其他模块业务事件；修复方向回归纯 `write(name: string, meta)` 原语 + 各模块导出自己事件集
- **M3 资源归属**：合规。`audit.tsv` + `audit/` 目录归 AuditLog
- **M4 持久化**：合规。`appendSync` 纯追加
- **M5 依赖单向**：**部分违反**（B.p173-1 亲属）。集中事件定义 = 底层预设上层；修复方向同 M2
- **M6 依赖结构稳定**：合规。`Audit.write` 接口稳定
- **M7 耦合界面稳定**：合规（phase212 `createAuditWriter(fs, filePath, maxSizeMb?)` 工厂切换后对外接口走工厂；与 `createSystemAudit` 同层并存 / 见 §2 装配工厂；main `5968b3a`）
- **M8 耦合界面最小**：合规。单方法 `write(type, ...fields)`
- **M9 显式表达编译器可检**：合规（事件 type 是 string 约定，需约定文档 + grep 核；编译期不可检是**结构性限制**）
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面 = 14）

- **D1a 信息不丢失**：合规（A.1 审定保留递归边界；非违反）
- **D1b 状态可观察**：合规。audit.tsv 纯文本可 tail / grep
- **D1c 中断可恢复**：合规。纯追加重启后继续
- **D1d 事后可审计**：**核心使命**。AuditLog 存在的根本原则
- **D2 不得丢弃/静默**：合规（A.1 递归边界审定保留非软吞）
- **D3 用户可观察**：合规（`clawforum audit` CLI 可读；未来 debug 视图命令规划中）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：**驱动原则**。audit.tsv 是重建态的权威来源
- **D6 智能体决策主体**：无关
- **D7 系统可信路径**：合规
- **D8 事件驱动**：合规。AuditLog 是事件驱动的终点写入
- **D9 多 claw 不隔绝**：灰度（每 agent 独立 audit.tsv；跨 agent 审计由消费方聚合）
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规（audit.tsv 在 agent dir）
- **P2 上下文工程**：合规（audit 是 agent 执行历史的完整记录）
- **P3 多 agent 利用**：合规
- **P4 系统为智能体服务**：**驱动**（所有模块失败 / 关键决策均经 audit 留痕）

#### Path Principles（6 条）

- **Path #1**：✓ phase148 审定 SHA + B.p173-1 phase173 登记 SHA 双源佐证
- **Path #2**：✓ §A.1 审定保留性质显式说明 / §B.p173-1 升档条件登记
- **Path #3**：✓ APPEND 不解构既有 §A/§B/§C
- **Path #4**：本地 only 无破坏性
- **Path #5**：phase193 Step 5
- **Path #6**：触发 3 次（同 Stream / FileWatcher）

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#10（原 modules.md）Stream + AuditLog 拆分**（cross-ref）：详 l2_stream.md §7.D 主登记。本模块承担「事后审计」职责，与 Stream 实时观察独立可变。

---

### 7.Phase 执行纪律

#### phase193 纪律 — L2 AuditLog backfill（2026-04-22，design 本地 only）

- **scope**：承 phase187 L1 模式，APPEND §7 四子节
- **产出**：§7.A 零条（A.1 审定保留非违规）/ §7.B 6+1 条映射（B.p173-1 当前合规偏差）/ §7.C 32 条 / §7.Phase（本节）
- **A.1 特殊说明**：phase148 审定"递归边界例外"，L2 唯一被允许保留 console 的模块。**判据（phase187 立范扩展）**：
  - 一般 L2 软吞 console → 登 §7.A 必修违规
  - 结构性递归边界（事件流终点自身失败不能递归用事件流）→ 审定保留，**不登 §7.A**，登 §7.B 特殊偏差 + 未来候选修复方向
- **对比定位**：
  - **L2 纯通用组 3/3**（配套 Stream + FileWatcher）
  - 与 Stream / FileWatcher 对比：后两者是消费者 / 事件源，失败可走 audit；AuditLog 是终点，失败无处可走（结构性差异）
  - 与其他 L2 模块（SessionStore / Snapshot / Messaging / ProcessManager）对比：phase148 统一收口时全 audit 化；AuditLog 特例保留
- **方法论贡献**：
  - "审定保留 ≠ 违规" 判据首次系统化登记（此前散落在 phase148 注释与 §B 条目）
  - **B.p173-1 双条目**模式：同一个 scope 登记 2 层（第 1 层应然方向 Monitor 废止 / 第 2 层 AUDIT_EVENTS 重构）
  - "事件名集中定义 vs 分散导出" 判据：集中 = M2/M5 违反风险；分散 + 装配聚合 = 合规（同 IGNORE_PATTERN 模式）

### 7.编号 drift 表

| modules.md 实然 § | 本契约 § | delta | 说明 |
|---|---|---|---|
| §8 | §7（含子节 7.A/7.B/7.C/7.D/7.Phase） | -1 | Stream 前置 §7 / AuditLog 为 §8；本契约 §7 为内部 drift 子节结构（非 modules.md § 号） |
