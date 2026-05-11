# Messaging 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2c.md](../interfaces/l2c.md) Messaging 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §13「Messaging 本质：跨 agent 消息通信服务 / L2 agent 语义基础设施 / 在 L1 FileSystem 之上把 inbox/outbox 文件目录通信封装成可重用基础服务 / Messaging 知 agent 概念（claw 间通信是 agent 业务）」加 M#1 / M#2 / M#3 / M#4 / Design Principle「磁盘即权威」加 Philosophy「多个 claw 智能体的信息不应当隔绝」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Messaging 的单一职责 = **跨 agent 文件通信的统一持久化入口加生命周期管理**：

- **outbox 加 inbox 文件持久化**：write outbox / write inbox / drain inbox / archive — 这是「目录即邮箱 / 文件即消息」原语。
- **崩溃可恢复加投递保证**：原子写保证消息要么完整可见要么不可见（无半写）— 让 D「中断可恢复」加「磁盘即权威」前提成立 / 收件人离线时消息不丢。
- **inbox 三态生命周期**：pending → done / failed 目录迁移管理 — 让消息处理状态在磁盘可见加事后可审计。
- **解析失败软处理**：decode 失败 → move failed/ + audit / 不丢消息（D「不丢弃 / 静默」derive）。
- **排序加优先级落地**：drain 按 priority desc + timestamp asc 排序 — 让 caller 按一致顺序处理。

> 具体 API 形态归 [interfaces/l2c.md](../interfaces/l2c.md) Messaging 节。具体实现细节（OutboxWriter / InboxWriter / sync 加 async 双轨 / 文件名 UUID 加 frontmatter meta 等）的存在依据是「文件目录通信原语 + 排序加生命周期管理」— 实然采纳的细节差异（如 codec-inbox / codec-outbox / codec-validation 拆分）登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务消息含义**（type / priority / 内容含义归调用方）— derive 自 M#2 业务语义归属（Messaging 业务语义仅文件通信级）
- **不 own 实时通道**（在线送达加连接管理归 L1 Transport）— derive 自 M#1 独立可变职责
- **不 own agent 身份解析**（target id 怎么映射到目录归调用方装配期决定）— derive 自 M#2
- **不 own 优先级策略**（哪类消息优先归调用方提供排序参数）— derive 自 M#2
- **不 own 消息 schema 校验**（schema 加业务字段归各调用方业务）— derive 自 M#1 + M#2
- **不 own inbox 监听加触发**（FileWatcher 监听加 Runtime 装配触发归调用方）— derive 自 M#1
- **不 own 去重**（依赖文件名 UUID 全局唯一 / caller 自重）— derive 自 M#1
- **不 own 加密加签名**（消费者侧 / 安全层职责）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Messaging 的业务语义边界：

- **own**：跨 agent 文件通信概念 — 「目录即邮箱 / 文件即消息 / 目录即状态」三位一体加 pending/done/failed 三态目录生命周期。这些是 Messaging 唯一懂的「业务」（agent 间文件通信级）。
- **角色定位**：Messaging 是「**持久化通信通道**」非「**实时通道**」（实时通道归 L1 Transport / 掉线即丢）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Messaging 独占的资源：

- **inbox 加 outbox 文件持久化入口**：clawforum 内部跨 agent 持久化通信必经 Messaging 间接访问 — 是 clawforum 对 inbox 加 outbox 文件 artifact 的唯一调用入口。
- **`<clawDir>/inbox/{pending,done,failed}/`**：消息生命周期目录。
- **`<clawDir>/outbox/pending/`**：发送队列目录。
- **type-level 资源**：`InboxMessage` / `OutboxMessage` 类型物理隔离在 `types/messaging.ts`（M#9 编译期可检）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Messaging 持久化所有跨 agent 通信内容（inbox 加 outbox 加 done 加 failed）— 是 clawforum 「磁盘即权威」加「事后可审计」加「多 agent 信息不隔绝」三原则的关键 artifact。

### 磁盘布局

```
<clawDir>/
├── inbox/
│   ├── pending/  ← 待处理消息
│   ├── done/     ← markDone 后归档
│   └── failed/   ← markFailed 或 decode 失败归档
└── outbox/
    └── pending/  ← 待发送消息（消费者 = motion / dispatcher 等）
```

### 文件格式

```
<ts>_<discriminator>_<uuid8>.md

文件内容（YAML frontmatter + body）：
---
type: <event>
source: <claw_id>
priority: critical|high|normal|low
to: <target_claw>?
contract_id: <id>?
<extraFields>
---
<body>
```

### 重建语义

- 进程重启：目录状态即权威 / pending 目录中的文件未消费视为待处理 / done/failed 是终态
- 消费失败：单文件不阻塞 / move 到 failed/ 后继续 / 由运维 grep audit.tsv 排查
- 跨进程：依赖 fs.writeAtomic 的 temp+rename 原子性 / 不会有半写文件

## 5. 审计事件清单

事件常量集中定义于 `MESSAGING_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `INBOX_WRITTEN` | InboxWriter 写入成功 | `file=<filename>`, ... |
| `INBOX_WRITE_FAILED` | InboxWriter 写入失败 | `file=<filename>`, `reason=...` |
| `INBOX_LIST_FAILED` | drainInbox `fs.list` 非 ENOENT 失败 | `reason=...` |
| `INBOX_FAILED` | drainInbox 单文件 decode 失败 | `file=<path>`, `reason=<真实原因>` |
| `INBOX_DONE` | markDone move 成功 | `file=<path>` |
| `INBOX_MOVE_FAILED` | markDone / markFailed move 失败 | `reason=...` |
| `OUTBOX_SENT` | OutboxWriter.write 成功 | `to=<id>`, `type=...`, `id=...` |
| `OUTBOX_SEND_FAILED` | OutboxWriter.write 失败 | `to=...`, `reason=...` |
| `INBOX_WATCHER_FAILED` | caller bridge：FileWatcher onError context='watch' | `path=`, `reason=` |
| `INBOX_WATCHER_CALLBACK_FAILED` | caller bridge：FileWatcher onError context='callback' | `path=`, `type=`, `reason=` |
| `INBOX_META_FAILED` | InboxReader.peekMetas 单文件 readMeta 失败（非消费型 peek 路径）| `file=<filename>`, `kind=<err-kind>` |

## 6. 层级声明

L2 agent 语义基础设施层（与 SkillSystem / Tools / FileTool / CommandTool 同子层 / 「跨 agent 文件通信」业务语义独立可变 / 知 agent 概念）/ generic message I/O primitive / 不预设业务模块。下游 Runtime / TaskSystem / ContractSystem / MemorySystem / CLI 通过 OutboxWriter / InboxWriter / InboxReader 消费 / 不直接 import。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 readInboxFileMeta null 吞失败源 | drift | 已闭环（phase150+202+216）| `InboxWriter.readMeta` 返回 Result ADT 区分 not_found/read_failed/parse_failed |
| A.2 drainInbox list 失败返 [] | drift | 已闭环（phase150）| 非 ENOENT 抛 `InboxListFailed` |
| A.3 markDone/markFailed move 失败吞 | drift | 已闭环（phase150）| 失败抛 `InboxMoveFailed` 防消息重放 |
| A.4 OutboxWriter 无 audit | drift | 已闭环（phase148）| 构造期 audit 必传 + OUTBOX_SENT/OUTBOX_SEND_FAILED 事件对 |
| A.5 上层绕 Messaging 直 fs.writeAtomic | drift | 部分闭环 | bypass 本体 phase152 已清；~~types/paths.ts CLAW_SUBDIRS 字面量留尾~~ → r50 C / phase365 Path #1 精化：CLAW_SUBDIRS const 已就位（`paths.ts:16` ✓）+ 2 const-ref caller (runtime + claw)；真 drift = **散落 callers 字符串硬编码 ~28 处**（result-delivery × 5 / task/system × 3 / task-recovery × 1 / fs/permissions × 4 / status × 2 / disk-monitor / contract/manager / skill × 2 / tests × 11）/ 推 r51+ caller 风格统一并轨第 5 次复用单独 phase（同 phase345/347/349/355/360 模板族 / 阈值更大达必硬化候选 Meta 31）。**short token const 子项闭环（phase380 r52 E / Path β derive）**：7 short token 候选 → 语义分类 derive → ✅ **抽 const**：logs（13 caller / 单一 subdir）/ contract（21 subdir caller / 1 cli cmd 例外）/ dialog（7-8 subdir）/ clawspace（6 subdir + 1 fs.list arg 同概念）→ NEW `LOGS_DIR` `CONTRACT_DIR` `DIALOG_DIR` `CLAWSPACE_DIR`；✅ **subdir 域抽** `STATUS_SUBDIR = 'status'`（5 subdir caller / 命名 `_SUBDIR` 与 `STATUS_TOOL_NAME` + cli cmd 域区隔）；⚠ **skills 9 caller 分类登记**（运行期 agent subdir 域 → import `SKILLS_DIR_DEFAULT` / 源码树 bundled 资源目录 motion.ts:70/74 → 独立 const 或字面量保留 + 注释）；⏸ **memory 不抽**（仅 2 处 / ROI 低 / 见 §7.B 信号登记）；同字符串 ≠ 同概念判据首次显式形式化（参 modules.md 末「### const 抽取概念识别」节）；Step 2 代码抽 + caller refactor 推 r53+ 用户实施 / 本子项 design 已闭环；framing 精化非 100% 推翻第 4 次累（phase365+phase370+phase376+phase380）+ 释义豁免模板第 7 次复用（'memory' + 'status' 释义豁免）|
| A.6 inbox 写入三 API 名字分裂 | drift | 已闭环（phase216）| writeInbox / writeInboxMessage / readInboxFileMeta 3 free function 删 / InboxWriter class 唯一入口 |
| A.7 notify_claw 应然契约有 / 实然 0 工具实施 | design-gap / 中 | open | 应然 §10.2 motion 视角指挥型 schema（to/text/interrupt）+ §10.3 不对称设计登记 + l2_command_tool §10.6 C 类 sync-only 列出 / 实然：`rg notify_claw src/` = 0 命中 / 0 工具实施 / 0 caller / motion 写 claw inbox 路径未通过工具通道实现。升档：motion CLI tooling 整体 design phase（业务决策）/ 实施时契约归 l2_messaging（本节）/ 物理实施位置候选 task/tools/ 或新立 motion-tool/（不预决）。Path #2 实然应然差距显式登记 / r58 D / phase403。 |
| ~~A.X-1 MessageCodec L1 应然消解未执行~~ ✓ closed | drift / 高 | **已闭环（phase361 / `ca84fad`）** | encodeInbox/decodeInbox/yamlQuote → `messaging/codec-inbox.ts` / encodeOutbox → `codec-outbox.ts` / validatePriority/validateType → `codec-validation.ts` / `foundation/message-codec/` 5 文件物理删 / M#5 清零 |
| **A.X-2 parseFrontmatter shared utility 抽出错决策** ⚠ STALE / phase361 错决策 | drift / 中 | **⚠ 推 r61+ 反向 design phase**（phase361 抽出违 M#2 / 应然真合规 = 各 caller inline 自治 parser / 详 practices.md「DRY reflex vs M#2 format 自治」+ feedback_governance_workaround_smell）| **应然真合规判定**：3 caller (Messaging codec / SkillSystem registry / memory_search) 各自 own 自己 format（schema 不同：type/source/priority vs name/description vs ...）/ 共享的只是 YAML frontmatter syntax = industry standard 不归 clawforum own / parser 是各 caller format 业务的 implementation detail（M#2 业务语义归属）/ phase361 抽 shared utility 反而 artificial coupling（改 parser 强制 lockstep 3 caller / 各自 inline 才独立可变）/ 治理 = 删 src/foundation/frontmatter/ + Messaging codec + SkillSystem registry + memory_search 各 inline 38 行 yaml parser / 实际 38 行 stable behavior 复制 0 维护成本 / phase361 是 DRY reflex 不是真 derive |
| modules.md 索引 IAuditSink/send drift（已闭环历史）| drift | phase321 | 索引层修订 |
| core/communication 别名（已闭环历史）| drift | phase205（main `f89bbb8`）| 7 行 alias re-export 删 + 5 import 改 |
| notify.ts 归属迁移（已闭环历史）| drift | phase259 | utils/ → foundation/messaging/ |
| inbox-writer 字面量未走 const（已闭环历史）| drift | phase288（`4616d15`）| 4/4 全消化 / 改用 INBOX_WRITE_FAILED 等 const |
| ~~audit optional-chain 不一致~~ | drift | **✅ closed（phase365 / main `202a0cd`）** | `inbox-reader.ts:118` `markDone` `this.audit?.write` 不一致 → α 单字符删 `?` / L118 与 L57/75/110/130 4 处一致化 / M#9+D2+M#7 全合规 / 行为契约 0 改（ctor 必选硬保 / `?.` 永不短路 / 实然等价）|
| ~~'memory' subdir 0 prod 实然候选~~ | drift / 极低 | **✅ stale closed（phase387 / framing 推翻 / β 释义闭环）** | phase380 r52 E Path β derive 副发现 0 prod → r53 C / phase387 Path #1 实测推翻：实然 ≥ 5 处 / 真 prod use site = `memory_search.ts:74` + `constants.ts:31` + `paths.ts:60` + `permissions.ts:40` + tests fixture / 应然实然 align（M#3 + M#7 双合规）/ stale signal / 同 phase356 stale closed 模板 |

> **同根升格信号**（推 r51+ Meta 31）：A.X-1/A.X-2 与 l4_contract_system §8.B done-relocation **反向同型**：A.X 是 L1 反向预设 L2 业务（向上）/ done 是 L2 跨边界持 L4 业务（向下）/ 不同方向同根 M#5+M#3+M#8 违反 / 升格独立 feedback 候选「**跨边界业务语义穿透判据**」。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 广连接代价（多消费者依赖目录/文件名/frontmatter 三重约定）| 「文件即消息」范式固有代价 | 范式根本变更（如改 IPC / 数据库）|
| `OutboxWriter.write` 返回路径作消息 id 替身 | 历史决策 | 调用方需要结构化 id 时 |
| 排序规则 priority desc + timestamp asc 内部硬编码 | MVP 唯一策略 | 出现"按 type" / "按 from agent" 优先级需求 |
| 跨进程并发写依赖 POSIX `O_APPEND` 原子性 | 同 claw 单 daemon 约定兜住 | 跨进程并发写极端大行 |
| notify.ts `console.warn`（L27）保留 | β 形态（InboxWriter 上游 audit 已覆盖 inbox_write_failed）/ phase262 评估合规 | 上游 audit 覆盖断 |
| codec-inbox extraFields | drift / 低 / 防御性 dead code | ⚓ accepted-stable（phase401 / framing 错位 + 自相矛盾消除 + 4 caller 实测 0 实然触发评估）| **framing 修订**：`codec-inbox.ts:45` 函数实际是 `encodeInbox`（非 encodeOutbox / codec-outbox.ts encodeOutbox 不接 extraFields）/ extraFields key 与 reserved set（id/type/from/to/priority/timestamp）冲突时 `console.warn` + `continue` skip / **4 caller 实测全 namespaced 业务字段**：`core/contract/manager.ts:861/913`（contract_id / subtask_id / verdict / retry_count）+ `core/memory/random-dream.ts:290`（dream_count）+ `core/memory/deep-dream.ts:254`（session_count）+ `core/runtime/heartbeat.ts:65` / 0 个会撞 reserved / **0 实然触发 / 防御性 dead code** / 现 console.warn + skip 是显式决策（log + 跳过 / 不是静默吞 / D2 满足）/ 升档：(a) 出现 caller 不慎传 reserved key / (b) caller 链扩展非 controlled 内部模块 / (c) audit 化 ROI 提升（log dashboard 需 signal 时）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场（实然合规判定不登记）。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：消息落盘 + 目录生命周期；与传输 / schema 校验 / 业务语义独立可变
- **M2 业务语义归属**：消息文件 IO / 目录状态迁移全归 Messaging
- **M3 资源归属**：inbox/outbox 目录归 Messaging / 消费者经 InboxWriter / OutboxWriter / InboxReader 间接访问（A.5 路径字面量留尾归此条）
- **M4 持久化**：文件即消息 / writeAtomic 保证原子
- **M5 依赖单向**：Messaging → FileSystem + AuditLog（实然另 dep src/foundation/frontmatter/ shared utility / ⚠ phase361 错决策 / 推 r61+ 反向 design phase 删 utility + inline / 详 §A.X-2 STALE）/ ~~实然 A.X-1 待修~~ ✓ phase361 闭环
- **M6 依赖结构稳定**：构造期注入 / 运行期不变
- **M7 耦合界面稳定**：InboxWriter / InboxReader / OutboxWriter class API 稳定
- **M8 耦合界面最小**：InboxWriter 3 方法 / InboxReader 4 方法 / OutboxWriter 1 方法 / 工厂 2 个
- **M9 显式表达编译器可检**：Result ADT / discriminated union priority / 错误类命名（InboxListFailed / InboxMoveFailed）
- **M10 不合理停下**：drainInbox 排序合理 / 不抛保证 Runtime 轮询继续
- **M11 边界不对停下**：A.X-1/A.X-2 触发应然消解 design phase（推 Stage 2）

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D1b 状态可观察** / **D1c 中断可恢复** / **D1d 事后可审计**：纯 audit 链路 + 目录即状态 + Result ADT
- **D2 不得丢弃/静默**：所有失败路径走 audit + throw（A.1-A.4 闭环）
- **D3 用户可观察**：`.md` 人类可读 / audit 事件流可聚合
- **D5 日志重建**：消息 `.md` + audit 事件对
- **D7 系统可信路径**：目录在 WRITABLE_PATHS 内
- **D8 事件驱动**：inbox 监听归 Runtime 装配 + FileWatcher
- **D9 多 claw 不隔绝**：**核心落实者**（跨 claw 通过 outbox → inbox 写入）
- **D4 / D6 / D10 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：**核心落实者**（文件即消息 + 目录即状态 / `.md` + frontmatter + 目录三态）
- **P2 上下文工程**：跨 agent 上下文经 outbox/inbox 传递
- **P3 分多个智能体加分子任务**：单一代码基服务所有 claw
- **P4 系统为智能体服务**：基础设施 / 跨 agent 持久化通信

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase192 / phase205 / phase216 / phase223 / phase259 / phase262 / phase282 / phase288 / phase[TBD] 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：audit 必传升级（OutboxWriter / InboxReader / InboxWriter）
- phase150：drainInbox throw 方向 + markDone/markFailed throw 方向
- phase152：A.5 bypass 本体清零（fs.writeAtomic('inbox/...') 0 命中）
- phase205：core/communication 别名删除（main `f89bbb8`）
- phase216：3 free function 删除 + InboxWriter class 唯一入口（main `ee4202c`）
- phase288：inbox-writer 字面量未走 const 全消化 4/4 + INBOX_WRITE_FAILED 常量（main `4616d15`）
- phase344 D：types/messaging.ts 物理隔离（不依赖 contract 类型）
- phase401：codec-inbox extraFields ⚓ accepted-stable 评估（framing 错位修 + 元 drift「未登记」自相矛盾消 + 4 caller 实测 0 实然触发 / pseudo_decision_filter δ dominant β 自决 / design only / 0 commit）
- 2026-05-03 / phase410：InboxReader 扩 `peekMetas(filter?)` 非消费型 API（main `129e8505`）/ 与 l5_runtime `_hasHighPriorityInbox` 改调联动 / +`INBOX_META_FAILED` audit event / 触发方 = 模块边界重构阶段第 2 phase（C 类小颗粒批量）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| Messaging L2 通用消息原语 / pending/done/failed 三态目录约定 | ✓（§1 + §4）|
| Messaging 类型物理隔离（types/messaging.ts / phase344 D）| ✓（interfaces/l2c.md + §3）|
| Audit event const 模块自治（H1 收官一致）| ✓（§5 / caller 风格统一并轨合规反例 / 跨模块 reference 模板）|
| ~~MessageCodec L1 应然消解~~ ✓ 已闭环（phase361）| ✓（§7.A A.X-1）|
| **parseFrontmatter shared utility 抽出错决策** ⚠ STALE | ⚠ phase361 错决策 / 真合规 = 各 caller inline 自治 parser / 推 r61+ 反向 design phase 删 utility / 详 §7.A A.X-2 STALE + practices.md「DRY reflex vs M#2 format 自治」|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **写入路径**：InboxWriter.write / writeSync / OutboxWriter.write 文件名格式 + frontmatter 编码 + 路径返回
- **读取路径**：drainInbox 排序（priority desc + timestamp asc）+ 解析失败自动归档
- **生命周期**：markDone / markFailed move + 失败 throw 防重放
- **Result ADT**：readMeta 三路区分（not_found / read_failed / parse_failed）
- **失败语义**：drainInbox throw `InboxListFailed` / markDone throw `InboxMoveFailed` / OutboxWriter.write 失败抛原错
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言
- **跨模块集成**：CLI outbox 视图 / Runtime drain 调度

## 10. 对智能体的承诺（agent-facing 工具通道）

> 本节是「6 通道 / 工具通道」对 agent 的应然承诺：模块通过 ToolRegistry 暴露给 agent 的工具 / agent 看 schema description 决策怎么用。
>
> 5 维度：用途 / 入参 / 成功返回 / 副作用 + 跨通道影响 / profile 准入 + 不变量。
>
> 失败语义留全工具集统一深度讨论后再落地（错误文本 keyword 表归属待定）。

### 10.1 send（claw 视角 / 汇报型）

**【1. 用途】** 向 motion 写一条消息（写自己 outbox / motion 进程定期扫读）。

**【2. 入参】**
- `content`     (string, required)    消息内容（自然语言文本）
- `type`        (string, optional)    消息类型（如 `'report'` / `'question'` / `'result'` / `'error'` / 默认 `'message'`）

**【3. 成功返回】**
- 写入路径

**【4. 副作用 + 跨通道影响】**
- 写文件到 `<clawDir>/outbox/pending/<ts>_<typeSlug>_<uuid8>.md`
- 不阻塞 / motion 异步处理（pull 模型）
- type 影响接收方处理顺序（系统层按 type 推断紧急级别 / 不在 sender 决策内）

**【5. profile 准入 + 不变量】**
- profile：full / subagent / miner（可写 profile）/ 不在 readonly / dream / verifier
- readonly: false
- idempotent: false（每次新建文件 / UUID 唯一）
- 工具执行不响应 abort
- 不可并行(write 系列 / 不同 path 实际不冲突 / 但框架 default 不并行)

### 10.2 notify_claw（motion 视角 / 指挥型）

**【1. 用途】** 向某个 claw 直接发消息（写 claw inbox / claw 立即可处理）。

**【2. 入参】**
- `to`          (string, required)    目标 claw 名
- `content`     (string, required)    消息内容
- `type`        (string, optional)    消息类型 / 默认 `'message'`
- `interrupt`   (boolean, optional)   `true` = 让 claw 当前 step 完成后立即处理（中断当前 turn）/ `false`（默认）= 等 claw 当前 turn 跑完正常处理

**【3. 成功返回】**
- 写入路径
- 投递确认：消息已落 claw inbox（claw 何时处理由 `interrupt` 决定）

**【4. 副作用 + 跨通道影响】**
- 写文件到 `<claws/<to>>/inbox/pending/<ts>_<typeSlug>_<uuid8>.md`
- **跨进程能力**（D11 motion 单向访问 / motion 有「直接写他人 inbox」特权 / claw 没有对偶能力）
- `interrupt=true` 触发目标 claw 在当前 step 完成时 yield turn（PriorityInboxInterrupt）/ 不打断 LLM 调用本身 / 仅在 step 间隙 abort react 循环
- claw 不存在 / 失败：`success=false` + 错误说明

**【5. profile 准入 + 不变量】**
- profile：**motion-only**（claw 看不到此工具）
- readonly: false / idempotent: false
- 工具执行不响应 abort / 不可并行

### 10.3 不对称设计登记（防 future drift）

`send` 和 `notify_claw` **是两个独立工具，schema 故意不对称**：

| 工具 | 收件人 to | 紧急性表达 | 模型 | 业务语义 |
|---|---|---|---|---|
| `send` | ✗ 隐式（自己 outbox / motion 默认 pull）| ✗ 无 | pull | 汇报型 |
| `notify_claw` | ✓ 显式 to | ✓ `interrupt` boolean | push | 指挥型 |

**为什么不对称是对的（不要改）**：

1. **物理操作不同**：send 写自己 outbox / notify_claw 写他人 inbox / **底层是两个不同的 fs 操作** / 强行同名同 schema 反而误导 agent
2. **业务语义不同**：claw 给 motion 是「汇报」/ motion 给 claw 是「指挥」/ 工具名分清比统一更清晰
3. **D11 motion 单向访问能力对应**：motion 有「打断 claw turn」的特权 / claw 没有「打断 motion turn」的对偶能力（motion 是 user 代理 / 用户有权调度 / agent 之间没有这权力）
4. **认知负担最小化**：claw 看 send 不需要 to 字段 / 不需要 priority 字段 / schema 极简 / 跟 claw 「向上汇报」单一场景对偶

**未来不要做的事**：
- ❌ 把 `interrupt` 加到 send（claw 不该有「打断 motion」的能力）
- ❌ 把 `to` 加到 send（claw 总是写自己 outbox / 多余字段增加认知负担）
- ❌ 把两工具合并成 send + caller-aware schema（实现复杂度 ↑ / 概念被压缩到不真实）
- ❌ 让 send 引入 priority 层级（priority 难校准 + 跟 type 重叠 + sender 跨进程 push 中断违反 D8 receiver pull 模型）

### 10.4 priority 字段为何不在工具 schema（design 锚点）

实然 `OutboxWriter` schema 含 `priority?: 'critical' | 'high' | 'normal' | 'low'` —— 但**应然工具 schema 不暴露 priority 给 agent**。理由：

1. **sender calibration 困难**：LLM 容易高估自己消息的 critical 程度 / 滥用导致退化
2. **receiver-driven 中断模型**（D8 事件驱动）：实然 step yield 是 receiver 在 step 间隙主动检查 inbox / 不是 sender push 中断 / sender 标 priority 只是「期望」/ 不是「强制」
3. **type 字段已能表达重要性**：接收方 LLM 看 `type='error'` / `type='question'` 自然判断重要性 / priority 重叠
4. **系统层 type → 紧急级别 mapping**：系统按 type 推断紧急级别（哪些 type 触发 step yield）/ 比 sender 标 priority 校准更稳

`notify_claw` 的 `interrupt` boolean 是**显式打断决策**（motion 知道 claw 在干啥 / 有权决定）/ 跟 sender-driven priority 完全不同概念 / **boolean 比层级判断对 LLM 更友好**。

### 10.5 跨通道偏好不在工具 schema（归系统信息通道）

工具 description **只写工具自身决策需要的信息**。跨工具偏好（如「优先 send 而不是 write 到 motion 目录」）归 AGENTS.md 等系统信息通道写 / 不在工具 schema 描述里。

判据：
- ✓ 写 schema：「写自己 outbox / motion 异步 pull」（send 自身机制）/「interrupt=true 触发 step yield」（notify_claw 自身机制）
- ✗ 不写 schema：「优先 send 不要走 fs 写 motion 目录」（跨工具偏好）/「motion 多久扫一次 outbox」（系统实现细节）

### 10.6 待统一深度讨论

- 失败语义错误文本 keyword 表（5 工具统一）/ agent 决策路径
- type 字段从自由字符串改枚举的时机判据（看系统消息处理基础设施演进）
- 系统层 type → 紧急级别 mapping 表 design（哪些 type 触发 step yield / 由系统配置 / 不是 agent 决策）
- 分布式场景下 send / notify_claw 实现层（agent 视角不变 / 复杂度归 daemon 网络层 / 详 §7.B 候选登记）
