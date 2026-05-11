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
- **TSV 格式约束**：字段转义 `\\` `\t` `\n` `\r` `\0`（`\\` 先转防歧义）/ 所有列（含 ts / type）统一经 `esc()` 转义 — 这是格式自治（事后 grep 加分析的最低保证）。
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

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<filePath>` audit.tsv（通常 `<clawDir>/audit.tsv` / 构造期参数）| 持久化（独占 / appendSync 纯追加）| ✓ |
| `<filePath>.<ts>.bak` | rotation 归档（独占 / 无清理策略）| ✓ |

**审计文件追加写入口** — clawforum 内部任何审计追加写必经 AuditLog 间接访问 / 是 audit.tsv 跨进程消费点唯一调用入口（多 L2+ 业务模块共用同一文件 / 由 AuditLog 保证 TSV 格式 + 时间戳权威 + append 原子性约束）。

> 注：**时间戳生成权独占** — `new Date().toISOString()` 内部生成 / 不允许调用方传（时序权威单源 / 实施细节归 §1.做 / 概念性资源归属）。

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
- **rotation 触发**：超过 `maxSizeMb` 时当前文件 move 到 `<path>.<uuid-8>.bak`（randomUUID 前 8 位 / collision-free）/ 新写入从空文件开始
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
| A.1 write 失败 console.error `[AUDIT CRITICAL]` 兜底 | 结构性边界 | **closed by phase 586**（C fork r70 / main `c9646efc` / merge `90171eee`）/ G fork r69 phase 582 ratify α dominant + Step A 4 子决策落地 | AuditLog 是事件流终点 / 自身失败不能递归用 audit / **α at-exit fallback（内部 buffer + process.on('exit') dump /tmp）** / D1「信息不丢失」+D5「事后可重建」derive 需超越 console.error / M#7+M#8 不违（内部实现 / 0 接口变）/ design report `coding plan/r69/G/G.2`。**phase 586 Step A 4 子决策锁定（5/5 原则一致 dominant）**：(D1.b) buffer cap=1000 FIFO drop-oldest + 首溢出 1 次 console.error meta（M#10 不 OOM + best-effort soft degrade）/ (D2.a) 单 module-level shared buffer（YAGNI / D5 行级 grep 区分 / D2.b 多 instance Set 过度抽象违 phase 461 模板）/ (D3.a) 仅 `process.on('exit')` 单事件覆盖所有可捕获场景（YAGNI / D3.b SIGTERM+SIGINT 重复触发需 guard / D3.c 漏 process.exit() 路径）/ (D4.a) sync writeFileSync（'exit' 事件语义强制 / async 在 'exit' 中无效 / D4.b 物理不可行）/ dump 直用 `node:fs` sync API 不走 FileSystem L1 抽象（fallback 是 audit 故障路径 / 不应依赖可能同样故障的抽象层 / 直 OS API 是 design intent）/ fallback path = `/tmp/clawforum-audit-fallback-<pid>-<ts>.tsv` |
| AUDIT_EVENTS 集中定义（违反 M2/M5）| drift / 已大致闭环 | 各模块自治 audit-events.ts 已分散（contract / cron / messaging / process-manager / 等）/ 中央 events.ts 已切除 | r37 B / phase334-336 接力分散 |
| Monitor 模块废止 | drift | **闭环 phase381**（main `01aff8b`）| `src/foundation/monitor/` 物理删除完成（4 文件 / 227 行 / 业务 0 caller / barrel re-export 同步删 / 测试套件同步删 / 死 import 1 处删）/ Monitor 应然废止落地完成 |
| caller audit event 字符串硬编码（5 模块）| drift | **phase375 清零**（main `01aff8b9931e3ebc8e5205c170e9a1653f68bd44`）| contract / cron / disk-monitor 经 phase345 治理改用 const ✓ / subagent / assembly / runtime 经 phase375 治理改用 const ✓ / caller 风格并轨第 5 次复用 / γ 同源复制跨模块共享 event（裁决 2）|
| ~~**factories.ts `assemble_failed` 字面量保留**~~ ✓ closed（framing 推翻 / phase379）| design-gap / false positive | **已闭环（phase379 / Path #1 全推翻）** | factories.ts 0 audit.write 调用 / 0 字面量 caller / 仅 JSDoc 2 处提及（L15 marker + L77 caller 包装 hint）/ α 物理迁 L4+ 无 cross-layer-up import 对象 / β L1 接纳与 M#5 永久冲突 / γ 自治 audit-events.ts 无 const 消费需求 / 三路径全无对象 / δ false positive 闭环 / phase375 收尾期 framing 错位产生的虚假 drift 登记 |
| `new AuditWriter` 直实例化 16 处 | drift / 中 | **phase355 清零**（main `9a7aec2f5dcd52c814e81b0a18ac8b2cdb17eb2d`）| 16 caller 改 createSystemAudit / createAuditWriter（factory 内化）/ M#3 资源唯一归属 + M#7 编码规范结构稳定 / 字符串值 + writer instance 完全等价 / 升格 caller 风格并轨第 4 次复用模板 / 模板成熟极致 |
| §B chat-viewport 事件 JSDoc 暂存 audit events.ts | drift / 已闭环 | viewport-audit-events.ts 自治定义已迁出 audit 模块 / phase 闭环（cli/commands/viewport-audit-events.ts）|
| §配置常量 `IGNORE_PATTERN` 对外导出承诺 | 双向 mutual drift / 已闭环（r44 A）| 历史 A.7 修复时承诺 AuditLog 导出供 Snapshot 装配 / 实施时 Snapshot 改用自治 `SNAPSHOT_IGNORE_PATTERNS` / 契约 §配置常量长期未跟新 / r44 A 删契约承诺（不实现导出 / Snapshot 自治模式确认采纳）|
| ~~modules.md 索引层 `IAuditSink` 残留~~ | drift | **✅ closed（phase321）** | `IAuditSink` 0 命中 / 索引层修订完成 |
| ~~code interface 名 `Audit` ↔ 应然 `AuditLog`~~ | naming drift / 中 | **✅ closed（phase417 / main `3048340d`）** | **应然权威 = architecture.md §6 + 表 1「AuditLog」**。phase417 实施：interface `Audit` → `AuditLog`（src/foundation/audit/index.ts）+ `AuditWriter implements AuditLog`（writer.ts）+ 51 caller files word-boundary rename `\bAudit\b` → `AuditLog`（38 src + 11 tests）+ 3 阶段同 commit（rename source + shim alias / mass rename / 删 shim）/ 0 行为改 / 1370+ 测试 PASS / 同 phase378 ShellTool 同型治理（rename 反向 / 第 2 例）|

#### A.1 修复方向（候选 α/β/γ）

> **phase 582 G fork ratify**：α at-exit fallback dominant 唯一（D1+D5 derive 必满足 / β γ 双输 reject 详 design report `coding plan/r69/G/G.2`）。
> **phase 586 C fork r70 落地中**：4 子决策已锁（D1.b cap=1000 + D2.a 单 buffer + D3.a 'exit' 单事件 + D4.a sync writeFileSync）。

- ~~**α 旧 framing**：独立 emergency log channel（独立文件 / 专用 fd）~~ / **新 framing**：内部 module-level buffer + process.on('exit') dump `/tmp/clawforum-audit-fallback-<pid>-<ts>.tsv`（phase 582 ratify / phase 586 落地 / D1+D5 唯一满足）
- ~~**β**：write 失败切换内存 ring buffer 暂存到下次 flush 成功~~ — **reject**（崩溃即丢 / 违 D1+D5 / β ring buffer 模板 + getter API 引接口扩展违 M#8）
- ~~**γ**：系统层（Daemon）订阅 audit error stream / 触发告警~~ — **reject**（仍依赖 console / 未实质解决持久化）

> A.1 是 L2 **唯一**审定保留 console 出口（writer.ts 的 catch 分支）/ 不扩展到其他 L2 模块。**phase 586 α 增补 buffer + dump / 不替代 console.error**（保留 `[AUDIT CRITICAL]` 行 / fallback 是补丁不是替换 / §7.B 立场不动）。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| L2 console 出口收口（writer.ts 唯一）| 审定保留 | 其他 L2 新增模块不得以「兜底」为由保留 console |
| rotation 策略简单（按大小切 / 不做时间切 / 保留数 / 压缩）| MVP 不驱动 | 磁盘告警 / 保留窗口需求 |
| 多消费者并发写依赖 POSIX `O_APPEND` 原子性 | **应然 rule 显式登记**：跨进程多 writer 协调依赖 OS POSIX `O_APPEND`（小行 < PIPE_BUF 原子）+ 同 claw 单 daemon 约定 + 跨 daemon 场景（如 watchdog + main daemon 同写 audit.tsv）依赖 PIPE_BUF 兜底 / 应然不内化 fcntl flock 等跨进程协调机制（不属 generic writer 职责）/ 升档：跨进程并发写极端大行（> PIPE_BUF）频繁 / 或多 daemon 同写 audit.tsv 出现交错 corruption / 推 r51+ 评估 fcntl flock 或 per-process audit.tsv |
| rotation filename 用 randomUUID 唯一后缀 | **✅ closed by phase 532**：同进程 sync 天然序列化 / 跨进程被单 daemon 约定兜住 / randomUUID 防 collision | 不再适用（已闭环）|
| `maxSizeMb: number \| null \| undefined` 三值冗余 | 命名冗余 | 配置 typo 导致 runtime bug |
| **audit event 值命名一致性（snake_case vs sub-namespace dot notation）**（phase 697 / r93 F fork Sub-C 实测登记）| drift / 低（latent / 仅 1 例外） | ⚓ accepted-stable / 推 user 拍板：21 audit-events.ts file 全 snake_case + 单例 `src/foundation/file-tool/audit-events.ts:7` `BACKUP_FAILED: 'file_tool.backup_failed'` dot 注「silent_x_audit_kit §2 audit 注入 α 模板（mirror phase 669）」intentional / 升档条件：(a) 出现第 2 处 sub-namespace dot 形态 → 升 design phase 评估 α 保 dot 作 sub-namespace 语义（如 `<module>.<event>` 双层）/ β 改 `file_tool_backup_failed` 严格 snake_case 统一 / 任一触发 → r94+ design phase 评估 / payload 字段命名已 100% snake_case 一致 / 仅 event 值层 1 例外 |
| **dead barrel re-export vs caller sub-path 不对称**（phase 697 / r93 F fork Sub-B 实测登记 + r94 B fork phase 701 + r95 E fork phase 707 兑现）| drift / 中（5 module hygiene cluster 多 fork batch cleanup） | **partial closed（r94 B fork phase 701 4 删 + r95 E fork phase 707 2 删）** / 残余 file-tool 6 individual tools Tier β partial mixed accept-stable（推 r96+ 评估 ROI）：5 module barrel 有 dead re-export（caller 走 sub-path / barrel 0 caller）/ llm-provider/index.ts:22-25 ~~4 Adapter classes~~ ✅ r94-B + :27-32 ~~5 abort helpers~~ 部分（r95-E 删 CombinedAbortHandle + classifyFetchAbortError / 保 withCombinedAbortSignal+AbortReason+makeExternalAbortError 真用 / orchestrator.ts:29 改走 barrel 修正 deep-bypassing）/ file-tool/index.ts:20-21 ~~READ_TOOL_NAME~~ ✅ r94-B + 6 individual tools Tier β mixed（2 test 走 barrel / 3 test 走 sub-path / accept-stable 推 r96+）/ tools/index.ts:8,19 ~~ToolRegistryImpl + ToolExecutorImpl~~ ✅ r94-B / llm-orchestrator/index.ts:12 LLMOrchestratorImpl（**保留** / src/index.ts:20 走 barrel public API）/ skill-system/index.ts:12 ~~SKILL_AUDIT_EVENTS~~ ✅ r94-B / Sub-B 12 候选 main spot-check 浮 4 framing 错位 phantom（LLMOrchestratorImpl + ToolRegistryImpl + SKILL_AUDIT_EVENTS + 6 tool exports）→ Tier 1 拆为 callerTypeToProfile + AsyncToolTaskArgs barrel 加 export（phase 697 land）+ withCombinedAbortSignal+AbortReason+makeExternalAbortError orchestrator caller cascade（phase 707 land / 修正 value-import deep-bypassing barrel anti-pattern）/ 升格成 2 NEW feedback：value_import_deep_bypassing_barrel + dead_barrel_reexport_caller_subpath_asymmetry（N=2 / Meta 47 自然触发达 110）|
| ~~**B.fallback-buffer-origin-tag** module-global pendingFallback 跨多 AuditWriter 实例 commingle / 0 origin / subagent task isolation 真破坏~~ | drift / 中 / r74 H boundary fork phase 615 derive | **✅ closed by phase 615**（commit `6776e339` / merge `fc08cdd9`）| **触发**：r74 fan-out 浮 P1.13 / Path #1 实测 module-global pendingFallback 跨 ≥ 4 AuditWriter 实例 commingle（assemble.ts:126+562 system + diskMonitor / subagent-executor.ts:55 task-isolated `<taskResultDir>/audit.tsv` / watchdog.ts:92）/ subagent task isolation (D7 智能体即目录) 真破坏 / dump path 仅 pid+ts 0 origin / fallback line 内容 pure tsv 0 归属 / **phase 615 决策（28 原则核 9/9 dominant α vs β 多文件 7/9 + γ 不动 3/9）**：α entry shape 扩 `{origin: string, line: string}` + dumpFallback `${esc(origin)}\t${entry.line}` 作 synthetic col 0 prepend / pushFallback signature +origin / AuditWriter.write catch 块传 `this.filePath` / 0 NEW const / 0 文件数变 / replay parse 直接（split tsv col 0 = origin path / col 1+ = original audit cols）/ overflow log 不动 / 模板：phase 586 audit fallback buffer + 600 runtime regime recovery dump → 615 origin tag 扩 第 N+1 实证 / **「audit fallback dump 模板」N+1 实证**（buffer → regime → origin 三阶段成熟）/ **「module-global state commingle / origin tag」首发模板** |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场（实然合规判定不登记）。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：单一职责 = 审计事件追加 + 字段转义 + rotation
- **M#2 业务语义归属**：generic writer / 不预设事件名清单 / event names + payload schemas 归各上游模块业务（违反点 AUDIT_EVENTS 集中定义 / 部分闭环）
- **M#3 资源归属**：`audit.tsv` 归 AuditLog
- **M#4 持久化**：`appendSync` 纯追加
- **M#5 依赖单向**：AuditLog → L1 FileSystem（per arch §6 表 1）/ 不预设 L2+ 业务事件 / 0 反向
- **M#6 依赖结构稳定**：`AuditLog.write` 接口稳定（phase417 rename align）
- **M#7 耦合界面稳定**：工厂 `createSystemAudit` + `createAuditWriter` 同层并存
- **M#8 耦合界面最小**：单方法 `write(type, ...fields)`
- **M#9 显式表达编译器可检**：事件 type 是 string 约定 / 编译期不可检是**结构性限制**
- **M#10-M#11**：未触发

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
- **D9 CLI 唯一外部入口**：N/A（本模块 L2 内部基础服务 / `clawforum audit` CLI 命令读 audit.tsv 经独立路径）
- **D10 多 claw 不隔绝**：灰度（每 agent 独立 audit.tsv）
- **D4 / D6 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：audit.tsv 在 agent dir
- **P2 上下文工程**：audit 是 agent 执行历史的完整记录
- **P3 分多个智能体加分子任务**：单一代码基服务全部 agent
- **P4 系统为智能体服务**：**驱动**（所有模块失败 / 关键决策均经 audit 留痕）

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

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
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / Design Principles D9 verbatim「CLI 唯一外部入口」N/A + D10「多 claw 不隔绝」编号修 align principles.md / §3 资源改 table 「<filePath> + .bak」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim 已正确）
- 2026-04-28 / phase355 new AuditWriter 直实例化 16 处闭环（main `9a7aec2f5dcd52c814e81b0a18ac8b2cdb17eb2d`）/ 16 caller 改 createSystemAudit / createAuditWriter（factory 内化）/ M#3 资源唯一归属 + M#7 编码规范结构稳定 / 升格 caller 风格并轨第 4 次复用模板 / **模板成熟极致**
- 2026-04-29 / phase375 caller audit event 字符串硬编码 5 模块闭环（main `01aff8b9931e3ebc8e5205c170e9a1653f68bd44`）/ subagent + assembly + runtime 经 phase375 治理改用 const ✓（contract / cron / disk-monitor 已 phase345 治理）/ caller 风格并轨第 5 次复用 / γ 同源复制跨模块共享 event（裁决 2）
- 2026-05-01 / phase379 factories.ts framing 推翻 false positive 闭环 / Path #1 全推翻：factories.ts 0 audit.write 调用 / 0 字面量 caller / 仅 JSDoc 2 处 marker / α/β/γ 三路径全无对象 / δ false positive 闭环 / phase375 收尾期 framing 错位产生的虚假 drift 登记 / **framing 推翻形态分级第 N 实证**
- 2026-05-01 / phase381 Monitor 模块物理删（main `01aff8b`）/ src/foundation/monitor/ 4 文件 / 227 行 / 业务 0 caller / barrel re-export + 测试套件 + 死 import 同步删 / Monitor 应然废止落地完成
- 2026-05-10 / phase 615 H boundary fork r74 code（commit `6776e339` / merge `fc08cdd9` / 起步 SHA `710c1fb5` / 主会话 plan + 用户 code）/ **§B.fallback-buffer-origin-tag ✅ closed**：α entry shape `{origin, line}` + esc(origin) prepend col 0 / pushFallback signature +origin / AuditWriter.write 传 this.filePath / 0 NEW const / 0 行为差正常路径 / dump body 多 col 0 origin tag / replay parse 即 split tsv / 多 AuditWriter commingle 4 site 实证（assemble system + diskMonitor + subagent task / watchdog）/ D7 智能体即目录恢复 / **「audit fallback dump 模板」第 N+1 实证扩 origin tag**（phase 586 buffer + 600 regime → 615 origin / 候选独立 feedback 持续硬化）/ **「module-global state commingle / origin tag」首发模板**（推 r75+ 同型 ≥ 2 实证升格独立 feedback）/ **「业务决策性 phase 但 28 原则核 9/9 dominant 自决」第 N 实证**（不入 J fork ratify）/ 与 l5_cron §B.handler-stuck-watchdog 同 phase 双 P1 cluster fix
- 2026-05-04 / phase417 Audit → AuditLog rename 闭环（main `3048340d`）/ interface Audit → AuditLog（src/foundation/audit/index.ts）+ AuditWriter implements AuditLog + 51 caller files word-boundary rename（38 src + 11 tests）+ 3 阶段同 commit（rename source + shim alias / mass rename / 删 shim）/ 应然权威 = arch §6 + 表 1「AuditLog」/ **同 ShellTool 同型治理第 2 例 / 反向 rename**
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_audit_log.md vs arch §6 + 表 1/2 + interfaces/l2a.md AuditLog 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7+**D8 终点**+D10 灰度 + D4/D6/D11 无关 + D9 N/A + Philosophy P1+P2+P3+**P4 驱动** + Path #1-#7）/ 3 主能力 align arch 表 2（audit 追加写+时间戳 + 按大小切割归档 + 写失败不阻塞业务）/ 1 dep + caller「所有需要审计的模块」align arch 表 1 / 资源 audit.tsv + .bak align arch 表 1 / 补 phase355+375+379+381+417 closure timeline entry / A.1 console.error 兜底 = L2 唯一审定保留 console 出口（递归边界） / design only / 0 src 改
- 2026-05-05 / **phase 499 caller DIP enforce: AuditWriter → AuditLog type rename**（main `f2f10794` / merge `a5d58612`）/ factory createSystemAudit + createAuditWriter 返 type 改 AuditLog interface / 23 src caller cascade（实施期 5 dead import 清 / 计划估 28 / 实测 23）/ 30+ type ref 改 AuditWriter → AuditLog / 0 caller 直 new AuditWriter（已全经 factory）/ AuditWriter class 仍 export from `audit/index.js` barrel + writer.js（备 tests white-box / executor.test 直 type 用）/ 0 行为差 / 1403+ tests PASS / 23 files +57 -58 / 同 phase 498 模板第 2 应用（scope 大 6x / phase 498 收紧推 r+1 / 本 phase = r+1 启动 / **闭环 N=2 实证**）/ **「caller DIP enforce cluster」累 4 实证**（phase 414b ContractManager + phase 498 LLMOrchestrator + phase 498 ToolRegistry + phase 499 AuditLog / **N=4 升格阈值彻底达 / Meta 36+ 必硬化**）/ 28 条原则核：M#7+M#8 align 治理（caller dep interface / impl 内部可变）/ M#9 仍 align（编译期 enforce）/ 「scope 收紧 / 大 caller 推 r+1」纪律 N=2 实证升格阈值达 / barrel-bypass（10 caller 从 writer.js 直 import）推 r+1 phase（barrel hygiene 同 phase 462+463 模板）/ 实施期 dead import 清 5 处（trivial cleanup）
- 2026-05-09 / phase 582 G fork r69 design only / **§A.1 reaffirm + push 拍板** / writer.ts:29-32 console.error 兜底 D2+D5 风险再评估 / 候选 α（at-exit fallback）/ β（ring buffer）/ γ（接受现状+结构化标记）/ 28 原则不唯一确定 / 纯业务方向 / 留待用户拍板 / design report `coding plan/r69/G/G.2`

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#10 Stream + AuditLog 拆分 | ✓（cross-ref / 详 l2_stream.md §7.E 主登记）/ 本模块承担「事后审计」职责 / 与 Stream 实时观察独立可变 |
| KD（应然）generic writer / 各模块 own audit-events.ts | ✓ phase334-336 闭环 |
| KD（r44 A）`IGNORE_PATTERN` 对外导出承诺撤销 | ✓ |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **write 失败 console.error 兜底**：磁盘满 / 权限 / 路径越界场景 / 不抛 / 不冒泡
- **rotation 触发条件**：`maxSizeMb` 阈值触发 + `.bak` 文件命名（randomUUID 前 8 位后缀 / collision-free）+ 新文件继续写入
- **字段转义**：`\t` → `\\t` / `\n` → `\\n` / `\r` → `\\r` / `\0` → `\\0` / `\\` → `\\\\`（`\\` 先转防歧义）/ ts / type 列也经 `esc()`
- **多 type 交叉写入**：generic writer 不区分 / 顺序保留
- **时间戳 ISO 8601 自动生成**：调用方不传 / 内部 `toISOString()` 注入
- **FileNotFoundError 静默跳过**（rotation 首次写）
- **rotation 其他错误**：console.error 兜底 + 继续 append

> A.1 递归边界例外的修复方向（候选 α/β/γ）见 §7.A 表 / 非必修。

## phase 695 — r93 E fork V3-P1.1 makeAudit factory collapse Tier 1 land

### V3-P1.1 makeAudit 4 bypass site 收 helper（closed by phase 695）

- **claim**：`tests/helpers/audit.ts:6` factory 存在 / 4 test file 内联复制 verbatim shape（tool-input-parse-error-audit / race-deadletter / silent-catch / async-path-rejection-audit）
- **状态**：C1 verified tight（4 site 实读 quote 匹配）
- **结论**：closed by phase 695 / 4 site 替 `import { makeAudit } from '../../helpers/audit.js'` + 删本地 `makeMockAudit` / schema-drift 防御（AuditLog.write 签名变 → 4 site 同步替代）

## phase 706 — audit key naming convention（payload camelCase + event const snake_case lower）

### A.1 event const 字符串 — snake_case lower

- 18 module audit-events.ts file 全 snake_case 0 漂（L1-P2.1 + L1-P2.2）
- 1 dotcase 单点 closed by phase 706 A.1（L1-P1.1 file_tool.backup_failed → file_tool_backup_failed）
- pattern：`{module}_{action}_{outcome}`（如 `contract_lock_acquired` / `dialog_save_failed`）
- 跨 module prefix 共享 namespace（contract_* / snapshot_* / runtime_* / etc）

### A.2 payload key — camelCase

- 与 TS 变量名对齐 / 与 event const 字符串 snake_case 解耦
- 内部 audit key 不耦合外部 protocol field name（per ML「耦合界面稳定」/ 如 messaging outbox `options.contract_id` → audit `contractId=`）
- closed by phase 706 A.2（L2-P1.3 contract_id 跨边界 camelCase）

### A.3 err / error / reason 决策树（push r96+ batch）

- `error=` ← Error 对象 stringified
- `reason=` ← business string literal 或 semantic enum
- 不用 `err=`（deprecated / 全转 `error=`）
- **drift 实证**：L2-P1.1 192 sites 跨模块漂（含同 file 自漂：contract/manager.ts:254 `err=` vs lock.ts:106 `error=`）
- **推 r96+ batch refactor**（决策树 enforce + grep + tsc + bun test 三验）

### A.4 path / file / dir 决策树（push r96+ batch）

- `path=` ← 完整路径
- `file=` ← basename
- `dir=` ← 目录
- 删 typed 前缀（lockPath= → path=）
- **drift 实证**：L2-P1.2 61+ sites 四态混用
- **推 r96+ batch refactor**

### A.5 ID 字段约定

- 业务实体 ID → typed camelCase（contractId= / taskId= / subtaskId= / agentId=）
- claw 短 key（claw= 16 处 cohesive / 已稳定模板 L2-P2.1）
- 通用 → `id=`

### A.6 时间字段

- 持续 / 延迟 → snake_case `*_ms`
- 单位标签 → `ms=`（语义已由 event type 承担）
- camelCase `*Ms=` 旧形态 → r96+ decision（推累 N=2 升格寻）

### A.7 其他 design row 同步

- **L1-P3.1** memory cron_* prefix（src 注释 deferred 主动 / 不强行改 / 历史命名保留）/ deferred OK
- **L1-P3.3** watchdog claw_crash_* 前缀混杂（sub-resource event prefix 待 N=2 升格寻）
- **L2-P2.3** context= vs module= 双态（语义可区分 / 非漂 / convention 保留）
- **L2-P3.1** LOOP_INTERRUPT_CAUSES const 化（正面模板 / 字面量 enum 化）

### A.8 Sub-B abort 协议 stable / 0 真 fix

- AbortController owner 拓扑清晰（runtime / subagent / task-system / orchestrator / tool-executor）
- signal 字段名 0 drift（全栈 9 处一致用 `signal: AbortSignal`）
- cleanup 模板成熟（abort-helper.ts withCombinedAbortSignal 6 caller / gateway.ts askUser 双源 cleanup / subagent agent.ts:415 phase 679 已 fix）
- 3 framing candidate 推 r96+ N=2 升格寻（mergeSignals vs withCombinedAbortSignal 近邻 / combine 三形态 / once 依赖非对称）
