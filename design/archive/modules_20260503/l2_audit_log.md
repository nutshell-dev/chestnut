# AuditLog 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2a.md](../interfaces/l2a.md) AuditLog 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §6「AuditLog 本质：状态迁移审计记录的追加写服务 / L2 通用基础设施 / 在 L1 FileSystem 之上提供 audit 追加写能力 / 多模块共用 / 自己不知任何业务语义」加 M#1 / M#2 / M#3 / M#4 / Design Principle「事后可审计」加「不得丢弃或静默忽略」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），AuditLog 的单一职责 = **状态迁移审计记录追加写的统一入口加格式约束**：

- **审计记录追加写**：调用方提交 `{event, fields}` 加本模块产出 timestamp / 经统一 TSV 格式持久化 — 这是「事后可审计」原则要求的全量记录持久化。
- **时间戳权威生成**：本模块内部生成 ISO 8601 timestamp / 调用方不传 — 让事后重建决策链路时序以 AuditLog 时钟为准（避免多写入方时钟漂移）。
- **TSV 格式约束**：字段转义 `\t` / `\n` 让 TSV 可解析 — 这是格式自治（事后 grep 加分析的最低保证）。
- **rotation 加历史保留**：可选按大小切割归档为 `.bak` / 不删除（derive 自 Design Principle「事后可审计」要求 audit 历史永久保留）。
- **写失败不阻塞业务**：best-effort 写 / 失败不抛错 — 原则要求「审计不得反过来卡死业务」（递归边界经 console.error 兜底 / 见 §7.A）。

> 具体 API 形态归 [interfaces/l2a.md](../interfaces/l2a.md) AuditLog 节。

### 不做

- **不 own 任何 clawforum 业务概念**（type 与 fields 对 AuditLog opaque / event 命名空间归各调用方业务模块）— derive 自 M#2 业务语义归属 + M#5 单向依赖（底层不预设上层语义）
- **不 own event 名清单维护**（合法 event 列表归各调用方自治命名）— derive 自 M#2
- **不 own 字段 schema 校验**（字段数量 / 类型 / 顺序由各消费者业务约定）— derive 自 M#1 + M#2
- **不 own 业务因果链构造**（哪个 event 关联哪个归各调用方业务）— derive 自 M#2
- **不 own 查询 / 读取**（audit.tsv 的消费是事后 grep 加离线分析 / 不走 AuditLog 模块）— derive 自 M#1 独立可变职责
- **不 own 跨进程并发写协调**（依赖 FS append 原子性 / 多 writer 协调归调用方）— derive 自 M#1
- **不 own 加密 / 签名 / 压缩**（消费者侧 / 安全层职责）— derive 自 M#1
- **不 own rotation 历史归档管理**（`.bak` 文件清理归运维 / 未来的 log janitor）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），AuditLog 的业务语义边界：

- **own**：审计记录持久化的统一形态约束 — 时间戳权威加 TSV 字段转义加 append-only 写约束。这些是 AuditLog 唯一懂的「业务」（持久化原语级，不是 clawforum 业务级）。
- **角色定位**：AuditLog 是「**通用 generic writer**」非「**业务事件解读器**」。多对一被动写入 / 不预设调用者集合 / 各 L2+ 模块多方写同一文件 / 各调用方在自有命名空间自治 event 名加 fields schema。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），AuditLog 独占的资源：

- **审计文件追加写入口**：clawforum 内部任何审计追加写必经 AuditLog 间接访问 — 是 clawforum 对 audit.tsv 这个跨进程消费点的唯一调用入口（多 L2+ 业务模块共用同一文件，由 AuditLog 保证 TSV 格式加时间戳权威加 append 原子性约束）。
- **`<filePath>`**：构造期参数 / 通常 `<clawDir>/audit.tsv` / 加 rotation `.bak` 文件。
- **时间戳生成权独占**：`new Date().toISOString()` 内部生成 / 不允许调用方传 — 时序权威单源。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），AuditLog 自身就是「持久化对象」— 跟 FileSystem 等访问通道角色不同，AuditLog 的输出 artifact 本身是 clawforum 「事后可审计」的关键存储。

### 磁盘布局

```
<filePath>                       ← audit.tsv（调用方传入 / 通常 <clawDir>/audit.tsv）
<filePath>.<ts>.bak              ← rotation 后的旧文件（按 maxSizeMb 触发 / 无清理策略）
<filePath>.<ts2>.bak
...
```

### 文件格式

每行一条记录 / TSV 制表符分隔 / `\n` 结尾：

```
<ISO8601 timestamp>\t<event type>\t<col1>\t<col2>\t...\n
```

示例：

```
2026-04-18T10:30:00.000Z\tdaemon_started\tpid=12345\tclawId=motion\n
2026-04-18T10:31:15.123Z\tcontract_transition\tid=abc\tfrom=pending\tto=verifying\n
```

### 重建语义

- **进程重启**：纯追加写 / 重启后继续追加 / 历史不受影响
- **rotation 触发**：超过 `maxSizeMb` 时当前文件 move 到 `<path>.<now>.bak` / 新写入从空文件开始
- **磁盘即权威**：内存无状态 / 全部审计记录以磁盘为准
- **跨进程并发**：依赖 POSIX `O_APPEND` 原子性（小行 < PIPE_BUF）/ 同 claw 单 daemon 约定兜住

## 5. 审计事件清单

**AuditLog 自身不产生 audit 事件**（应然 / generic writer / 不知模块语义）。

**event names + payload schemas 归各上游模块业务**：每个 caller 在自己模块契约 §5 声明所产事件（如 ContractSystem 的 `contract_transition` / DialogStore 的 `DIALOG_*` / Stream 的 `STREAM_*` 等）。

> A.1 递归边界例外：AuditLog 自身写失败时由 `console.error('[AUDIT CRITICAL] ...')` 兜底（不通过自身 audit 通道 / 防递归）/ 详 §7.A。

## 6. 层级声明

L2 通用基础设施层（与 Snapshot / ProcessManager 同子层 / generic writer / 不预设调用者集合 / 自己不知任何业务语义）。下游所有需要审计的 L2+ 模块通过 createAuditWriter 工厂消费 + 注入 deps。详见 [architecture.md](../architecture.md) 加 [interfaces/l2a.md](../interfaces/l2a.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环 + 结构性边界）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 write 失败 console.error `[AUDIT CRITICAL]` 兜底 | 结构性边界 | 审定保留（非违规）| AuditLog 是事件流终点 / 自身失败不能递归用 audit / 候选 α/β/γ 修复方向见下 |
| AUDIT_EVENTS 集中定义（违反 M2/M5）| drift / 已大致闭环 | 各模块自治 audit-events.ts 已分散（contract / cron / messaging / process-manager / 等）/ 中央 events.ts 已切除 | r37 B / phase334-336 接力分散 |
| Monitor 模块废止 | drift | **闭环 phase381**（main `01aff8b`）| `src/foundation/monitor/` 物理删除完成（4 文件 / 227 行 / 业务 0 caller / barrel re-export 同步删 / 测试套件同步删 / 死 import 1 处删）/ Monitor 应然废止落地完成 |
| caller audit event 字符串硬编码（5 模块）| drift | **phase375 清零**（main `01aff8b9931e3ebc8e5205c170e9a1653f68bd44`）| contract / cron / disk-monitor 经 phase345 治理改用 const ✓ / subagent / assembly / runtime 经 phase375 治理改用 const ✓ / caller 风格并轨第 5 次复用 / γ 同源复制跨模块共享 event（裁决 2）|
| ~~**factories.ts `assemble_failed` 字面量保留**~~ ✓ closed（framing 推翻 / phase379）| design-gap / false positive | **已闭环（phase379 / Path #1 全推翻）** | factories.ts 0 audit.write 调用 / 0 字面量 caller / 仅 JSDoc 2 处提及（L15 marker + L77 caller 包装 hint）/ α 物理迁 L4+ 无 cross-layer-up import 对象 / β L1 接纳与 M#5 永久冲突 / γ 自治 audit-events.ts 无 const 消费需求 / 三路径全无对象 / δ false positive 闭环 / phase375 收尾期 framing 错位产生的虚假 drift 登记 |
| `new AuditWriter` 直实例化 16 处 | drift / 中 | **phase355 清零**（main `9a7aec2f5dcd52c814e81b0a18ac8b2cdb17eb2d`）| 16 caller 改 createSystemAudit / createAuditWriter（factory 内化）/ M#3 资源唯一归属 + M#7 编码规范结构稳定 / 字符串值 + writer instance 完全等价 / 升格 caller 风格并轨第 4 次复用模板 / 模板成熟极致 |
| §B chat-viewport 事件 JSDoc 暂存 audit events.ts | drift / 已闭环 | viewport-audit-events.ts 自治定义已迁出 audit 模块 / phase 闭环（cli/commands/viewport-audit-events.ts）|
| §配置常量 `IGNORE_PATTERN` 对外导出承诺 | 双向 mutual drift / 已闭环（r44 A）| 历史 A.7 修复时承诺 AuditLog 导出供 Snapshot 装配 / 实施时 Snapshot 改用自治 `SNAPSHOT_IGNORE_PATTERNS` / 契约 §配置常量长期未跟新 / r44 A 删契约承诺（不实现导出 / Snapshot 自治模式确认采纳）|
| ~~modules.md 索引层 `IAuditSink` 残留~~ | drift | **✅ closed（phase321）** | `IAuditSink` 0 命中 / 索引层修订完成 |
| ~~code interface 名 `Audit` ↔ 应然 `AuditLog`~~ | naming drift / 中 | **✅ closed（phase417 / main `3048340d`）** | **应然权威 = architecture.md §6 + 表 1「AuditLog」**。phase417 实施：interface `Audit` → `AuditLog`（src/foundation/audit/index.ts）+ `AuditWriter implements AuditLog`（writer.ts）+ 51 caller files word-boundary rename `\bAudit\b` → `AuditLog`（38 src + 11 tests）+ 3 阶段同 commit（rename source + shim alias / mass rename / 删 shim）/ 0 行为改 / 1370+ 测试 PASS / 同 phase378 ShellTool 同型治理（rename 反向 / 第 2 例）|

#### A.1 修复方向（候选 α/β/γ / 非必修）

- **α**：独立 emergency log channel（独立文件 / 专用 fd）持久化 audit 自身失败
- **β**：write 失败切换内存 ring buffer 暂存到下次 flush 成功
- **γ**：系统层（Daemon）订阅 audit error stream / 触发告警

> A.1 是 L2 **唯一**审定保留 console 出口（writer.ts 的 catch 分支）/ 不扩展到其他 L2 模块。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| L2 console 出口收口（writer.ts 唯一）| 审定保留 | 其他 L2 新增模块不得以「兜底」为由保留 console |
| rotation 策略简单（按大小切 / 不做时间切 / 保留数 / 压缩）| MVP 不驱动 | 磁盘告警 / 保留窗口需求 |
| 多消费者并发写依赖 POSIX `O_APPEND` 原子性 | **应然 rule 显式登记**：跨进程多 writer 协调依赖 OS POSIX `O_APPEND`（小行 < PIPE_BUF 原子）+ 同 claw 单 daemon 约定 + 跨 daemon 场景（如 watchdog + main daemon 同写 audit.tsv）依赖 PIPE_BUF 兜底 / 应然不内化 fcntl flock 等跨进程协调机制（不属 generic writer 职责）/ 升档：跨进程并发写极端大行（> PIPE_BUF）频繁 / 或多 daemon 同写 audit.tsv 出现交错 corruption / 推 r51+ 评估 fcntl flock 或 per-process audit.tsv |
| `maxSizeMb: number \| null \| undefined` 三值冗余 | 命名冗余 | 配置 typo 导致 runtime bug |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场（实然合规判定不登记）。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：单一职责 = 审计事件追加 + 字段转义 + rotation
- **M2 业务语义归属**：generic writer / 不预设事件名清单 / event names + payload schemas 归各上游模块业务（违反点 AUDIT_EVENTS 集中定义 / 部分闭环）
- **M3 资源归属**：`audit.tsv` 归 AuditLog
- **M4 持久化**：`appendSync` 纯追加
- **M5 依赖单向**：AuditLog → L1 FileSystem（per arch §6 表 1）/ 不预设 L2+ 业务事件 / 0 反向
- **M6 依赖结构稳定**：`Audit.write` 接口稳定
- **M7 耦合界面稳定**：工厂 `createSystemAudit` + `createAuditWriter` 同层并存
- **M8 耦合界面最小**：单方法 `write(type, ...fields)`
- **M9 显式表达编译器可检**：事件 type 是 string 约定 / 编译期不可检是**结构性限制**
- **M10-M11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：A.1 审定保留递归边界（非违反）
- **D1b 状态可观察**：audit.tsv 纯文本可 tail / grep
- **D1c 中断可恢复**：纯追加重启后继续
- **D1d 事后可审计**：**核心使命**
- **D2 不得丢弃/静默**：A.1 递归边界审定保留非软吞
- **D3 用户可观察**：`clawforum audit` CLI 可读
- **D5 日志重建**：**驱动原则**（audit.tsv 是重建态的权威来源）
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：事件驱动的终点写入
- **D9 多 claw 不隔绝**：灰度（每 agent 独立 audit.tsv）
- **D4 / D6 / D10 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：audit.tsv 在 agent dir
- **P2 上下文工程**：audit 是 agent 执行历史的完整记录
- **P3 分多个智能体加分子任务**：单一代码基服务全部 agent
- **P4 系统为智能体服务**：**驱动**（所有模块失败 / 关键决策均经 audit 留痕）

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase148 / phase173 / phase193 / phase212 / phase321 / phase334-336 各 phase 收尾报告。

关键里程碑：
- phase148：A.2 audit 必传升级（OutboxWriter / InboxReader / InboxWriter）+ 大量 console → audit 化（统一收口）
- phase173 决策：Monitor 模块废止登记（应然方向 / 物理删待独立 phase）
- phase193 L2 AuditLog backfill（既有 §A/§B 节保留 / 补 §7.C 32 条原则对照）
- phase212：`createAuditWriter` 工厂引入（main `5968b3a`）
- phase321：modules.md 索引 `IAuditSink` drift 修订（0 命中）
- phase334-336：AUDIT_EVENTS 集中定义分散到各模块自治 audit-events.ts（contract / cron / messaging / process-manager / session-store / skill / stream / file-watcher 等 8+ 模块）/ 中央 events.ts 已切除
- r44 A：契约结构升 9 节模板 / IGNORE_PATTERN 双向 mutual drift 闭环 / `new AuditWriter` 直实例化升档至中
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2a.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#10 Stream + AuditLog 拆分 | ✓（cross-ref / 详 l2_stream.md §7.E 主登记）/ 本模块承担「事后审计」职责 / 与 Stream 实时观察独立可变 |
| KD（应然）generic writer / 各模块 own audit-events.ts | ✓ phase334-336 闭环 |
| KD（r44 A）`IGNORE_PATTERN` 对外导出承诺撤销 | ✓ |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **write 失败 console.error 兜底**：磁盘满 / 权限 / 路径越界场景 / 不抛 / 不冒泡
- **rotation 触发条件**：`maxSizeMb` 阈值触发 + `.bak` 文件命名 + 新文件继续写入
- **字段转义**：`\t` → `\\t` / `\n` → `\\n` / 其他字符不二次转义
- **多 type 交叉写入**：generic writer 不区分 / 顺序保留
- **时间戳 ISO 8601 自动生成**：调用方不传 / 内部 `toISOString()` 注入
- **FileNotFoundError 静默跳过**（rotation 首次写）
- **rotation 其他错误**：console.error 兜底 + 继续 append

> A.1 递归边界例外的修复方向（候选 α/β/γ）见 §7.A 表 / 非必修。
