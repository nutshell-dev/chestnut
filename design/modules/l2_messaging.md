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

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<clawDir>/inbox/{pending,done,failed}/` | 消息生命周期目录（独占）| ✓ |
| `<clawDir>/outbox/pending/` | 发送队列目录（独占）| ✓ |

**inbox + outbox 文件持久化入口** — clawforum 内部跨 agent 持久化通信必经 Messaging 间接访问 / 是 inbox + outbox 文件 artifact 唯一调用入口。

> 注：type-level 资源 `InboxMessage` / `OutboxMessage` 类型物理隔离在 `types/messaging.ts`（M#9 编译期可检 / 实施细节 / 非 M#3 业务资源）。

> **跨 claw 写入 sharpen（phase 477）**：messaging own「inbox / outbox 业务资源」业务语义 / **不限定 own claw vs target claw**。同 claw 写自己 outbox（caller 注入自己 fs）+ 跨 claw 写他人 inbox（caller 装配期注入 target claw fs / 仅 motion profile / D11 motion 单向访问特权 derive）/ messaging 业务层不约束 / profile 控制（motion-only）+ caller 装配期 fs 注入决定写入 scope。源：phase 477 r64 C fork notify_claw 工具实施 design / D11 + M#3。

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
| `NOTIFY_CLAW_SENT` | notify_claw 工具成功投递（phase 477 sharpen / 实装推 r65+）| `claw=<to>`, `type=`, `interrupt=` |
| `NOTIFY_CLAW_FAILED` | notify_claw 工具失败（target claw 不存在 / inbox dir 写失败 / etc）| `claw=<to>`, `reason=` |

## 6. 层级声明

L2 agent 语义基础设施层（与 SkillSystem / Tools / FileTool / CommandTool 同子层 / 「跨 agent 文件通信」业务语义独立可变 / 知 agent 概念）/ generic message I/O primitive / 不预设业务模块。下游 Runtime / AsyncTaskSystem / ContractSystem / MemorySystem / CLI 通过 OutboxWriter / InboxWriter / InboxReader 消费 / 不直接 import。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

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
| ~~A.7 notify_claw 应然契约有 / 实然 0 工具实施~~ | design-gap / 中 | **✅ closed by phase 477**（design only / 实施位置拍板 = **γ `src/foundation/messaging/tools/notify-claw.ts`** / 同 send 模板 phase 440 dir 模式扩展 / 实装推 r65+ code phase）| phase 477 实施（r64 C fork / design only / 0 src 改）：(1) **位置 derive 完成**（α task/tools/ 不通过 M#1+M#2 / β motion-tool/ 不通过 D10/D11+M#8 identity 不应模块边界化 / **γ messaging/tools/ dominant** 5 原则全 align M#1+M#2+M#7+M#8+D11 + phase 440 模板复用 / 用户 2026-05-04 拍板 γ）/ (2) **schema 应然 sharpen**（content→body align InboxMessageOptionsBase + 不暴露 priority enum per §10.3 不对称设计 LLM 友好 / dispatch item 4 derive 完成）/ (3) **profile 排除原则推**（motion-only / claw/subagent/miner 0 D11 derive / dream/verifier/readonly 与 write 性质冲突 / dispatch item 5 derive 完成）/ (4) **interrupt mechanism contract sharpen**（schema interrupt: boolean → metadata priority='high' mapping / align 实然 _hasHighPriorityInbox runtime.ts:863-866 / 跨 messaging+runtime 双模块协议）/ (5) **§3 资源 sharpen**（messaging own inbox/outbox 业务 不限定 own claw vs target / 跨 claw 写 D11 单向访问特权 + caller 注入 target fs）/ (6) **§5 audit + 2 events** NOTIFY_CLAW_SENT/FAILED / (7) l5_runtime §1 cross-ref 加 inbox metadata 检测段 / (8) interfaces/l2c.md 0 改（既有 InboxMessageOptionsBase + peekMetas spec 已 align mechanism）。**实装推 r65+ code phase**：NEW notify-claw.ts + motion profile register + Assembly register + 5+ caller cascade scope 实施期 derive（部分 motion → claw 适用 / 部分 claw → motion / claw → claw 保 InboxWriter direct）。源：r58 D phase403 立 §A.7 / r64 C fork 升档 motion CLI tooling 整体 design / phase 477 design 落地 |
| ~~A.X-1 MessageCodec L1 应然消解未执行~~ ✓ closed | drift / 高 | **已闭环（phase361 / `ca84fad`）** | encodeInbox/decodeInbox/yamlQuote → `messaging/codec-inbox.ts` / encodeOutbox → `codec-outbox.ts` / validatePriority/validateType → `codec-validation.ts` / `foundation/message-codec/` 5 文件物理删 / M#5 清零 |
| ~~**A.X-2 parseFrontmatter shared utility 抽出错决策**~~ ~~⚠ STALE / phase361 错决策~~ | ~~drift / 中~~ | **✅ closed by phase 461**（main `c15333e9`）/ DELETE `src/foundation/frontmatter/index.ts` + dir + `tests/foundation/frontmatter.test.ts` 154 行 / 4 caller 各自 inline 27 行 parser（codec-inbox + inbox-writer + skill-system/registry + memory_search）/ 6 files +112 -196 = **净 -84 行** / 1356 tests PASS / 0 行为改 / **DRY reflex 反例落地实证**（4 维度反向测试均失败：巧合相同 syntax / caller format implementation detail / 38 行 stable 复制成本 0 / artificial coupling）/ phase 461 confirmed M#2 业务语义归属 真合规 / 详 feedback_governance_workaround_smell + project_phase461_frontmatter_inline + practices.md「DRY reflex vs M#2 format 自治」|
| modules.md 索引 IAuditSink/send drift（已闭环历史）| drift | phase321 | 索引层修订 |
| core/communication 别名（已闭环历史）| drift | phase205（main `f89bbb8`）| 7 行 alias re-export 删 + 5 import 改 |
| **A.tool-1 send tool 物理迁** | location drift | **✅ closed（phase440 / main `1a43d207`）** | 应然 = send tool 业务依赖 OutboxWriter / 归 Messaging owner（per arch 表 3 row 359 + phase360 done + phase416 memory_search 模板）。phase440 实施 4 阶段同 commit：(1) git mv `src/foundation/tools/builtins/send.ts` → `src/foundation/messaging/tools/send.ts`（保 history）+ NEW dir `messaging/tools/` (2) 内部 import path 修（OutboxWriter `'../index.js'` 同 module / SEND_TOOL_NAME `'../../tools/tool-names.js'` cross module）+ 加 `@module L2.Messaging` 注解 (3) builtins/index.ts 删 sendTool 3 处（import + re-export + register）(4) Assembly 显式 register + 2 caller test import path / 0 行为改 / 1370+ 测试 PASS / **业务工具归 owner module 第 3 实证**（phase360 done → ContractSystem + phase416 memory_search → MemorySystem + 本 phase send → Messaging）|
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
| **L2c.G1 (messaging)** arch 表 2「inbox 写入（同步加异步）」描述精度 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2c.md 暴露 InboxWriter.write + notifyInbox/notifySystem standalone helpers / 全 Promise async / 不区分 sync/async 写形态 / arch 表 2 Messaging row 「inbox 写入（同步加异步）」可能历史描述 stale（V1 in-process inject vs cross-process file 区分）| **业务决策性 / 用户拍板候选**：α arch 表 2 改「inbox 写入（class instance + standalone helper 两形态 / 全 async）」/ β arch 表 2 改「inbox 写入（同步 helper + 异步 instance）」如实然有同步 helper / γ 保留现状（implementation detail / 不影响 caller derive）|
| **L2c.G2 (messaging)** peekMetas 返 `Promise<InboxMessageMeta[]>` 失败沉默成 [] | **业务决策性 design-gap / phase 567 H fork 浮出**（main `10b58fb4`）：inbox-reader.ts:129-161 catch + audit + continue 模式 / API 返 Array / caller (runtime.ts:805) 无法区分「目录空」vs「全失败」/ 违 D2 不静默 + M#9 显式表达 / **应然多解**：α 改 `Promise<Result<InboxMessageMeta[], PeekError>>` (M#9+D2 5/5) + caller cascade / β 加 `count: { total, failed }` 副信号 (3/5) / γ 保现状 + audit cover (2/5) | **业务决策性 / 用户拍板候选** / dominant α / phase 567 起草 / 推 r69+ code |
| **L2c.G3 (messaging)** inbox YAML frontmatter vs outbox markdown 格式不对称 | **业务决策性 design-gap / phase 567 H fork 浮出**：codec-inbox.ts:49-94 YAML frontmatter（机器解析） vs codec-outbox.ts:7-22 markdown header（人友好）/ 双方向解析能力不对称 / 应然 silent on 必需 / **应然多解**：α 改 outbox 用 YAML（双向对称 / M#7 ✓ + D5 ✓ / 改面 codec-outbox + 既有 outbox 文件迁移 / 4/5）/ β 保现状 / outbox sender-side human-friendly + inbox receiver-side system-friendly（M#1 职责差异 ✓ / 0 改 / 3/5）/ γ 文档 sharpen「不对称是设计」（D3 ✓ + 0 改 / 3/5） | **✅ closed by r88 C fork / β 保现状**：原则明确指导 β / M#1 inbox=receiver(system) vs outbox=sender(human) 职责不同 → 格式不同是 M#1 自然推论 / M#8 inbox/outbox 各自独立 codec 0 共享格式代码 = 耦合最小 / D5 双格式均可重建审计 / 不对称是 M#1+M#8 的合理结果 非 drift / 0 src 改 / 0 code phase |
| **L2c.G4 (messaging)** codec-outbox 无 decodeOutbox | **业务决策性 design-gap / phase 567 H fork 浮出**：codec-outbox.ts 仅 encodeOutbox / 无反向解析 / 应然多解：α NEW decodeOutbox（D5 信息重建 / 4/5）/ β 不加（YAGNI + M#8 接口最小 / outbox = sender-side state 写后即丢 / 4/5） | **✅ closed by r88 C fork / 用户拍板 β YAGNI 不加**：r88 Path #1 实测全栈 grep `decodeOutbox` 0 命中 / outbox-writer.ts:65 唯一 encodeOutbox caller / 0 caller 需 decode / outbox = sender-side write-and-forget / phase 567+664+r88 三评一致 / 与 L2c.G3 同根 / 0 src 改 / 0 code phase 落地 |
| **L2c.G5 (messaging)** ~~notify.ts:19-27~~ inbox-writer.ts:78 encodeInbox 失败路径 audit gap | **drift / 中 / phase 567 H fork 浮出**（main `10b58fb4`）：~~notify.ts:19-27~~ inbox-writer.ts:78 catch encodeInbox 失败（yamlQuote throw）路径 / phase 262 评估「上游 audit cover」假设需 refine — encodeInbox 失败不在 InboxWriter 内部 / 上游 audit 不 cover / D1+D2 violation / **修复 derive**：catch 内加 `audit.write(MESSAGING_AUDIT_EVENTS.INBOX_WRITE_FAILED, ...)` / 复用既有 const 或 NEW / 0 业务决策 自决 / **phase 715 sub-A D2-P2.2 framing re-anchor**：notify.ts 已重构 / encodeInbox 现在 inbox-writer.ts:78 内部 try/catch → INBOX_WRITE_FAILED audit | **VERIFIED / 升 §A 候选** / phase 567 起草 / 推 r69+ code phase（hygiene 类）|
| **L2c.G6 (messaging)** InboxMessage.content vs InboxMessageOptionsBase.body 命名不一致 | **应然 sharpen 待选 / phase 567 H fork 浮出**：phase 477 sharpen content→body align InboxMessageOptionsBase 落地（caller-facing tool schema = body / LLM-friendly）/ InboxMessage internal model 仍 content / writeSync 内部 mapping `content: opts.body`（line 96）/ **应然多解**：α InboxMessage rename → body（完整对齐 / M#7 ✓ / 改面 codec + decodeInbox + tests / 4/5）/ β 保 layered + jsdoc 显式说明（YAGNI ✓ + D3 ✓ / 0 改 src / 4/5）/ γ OptionsBase body → content（与 phase 477 矛盾 / 推翻）| **✅ closed by r88 C fork / β 保现状**：原则明确指导 β / M#7 InboxMessage 是对外类型改 .content 是 breaking change 不值得 / M#9 mapping 显式 inbox-writer.ts:70 非 hidden / M#1 模块 own 内外层命名是模块内部决策 / 无原则违反 / 0 src 改 / 0 code phase |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场（实然合规判定不登记）。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：消息落盘 + 目录生命周期；与传输 / schema 校验 / 业务语义独立可变
- **M#2 业务语义归属**：消息文件 IO / 目录状态迁移全归 Messaging
- **M#3 资源归属**：inbox/outbox 目录归 Messaging / 消费者经 InboxWriter / OutboxWriter / InboxReader 间接访问（A.5 路径字面量留尾归此条）
- **M#4 持久化**：文件即消息 / writeAtomic 保证原子
- **M#5 依赖单向**：Messaging → FileSystem + AuditLog（实然另 dep src/foundation/frontmatter/ shared utility / ⚠ phase361 错决策 / 推 r61+ 反向 design phase 删 utility + inline / 详 §A.X-2 STALE）/ ~~实然 A.X-1 待修~~ ✓ phase361 闭环
- **M#6 依赖结构稳定**：构造期注入 / 运行期不变
- **M#7 耦合界面稳定**：InboxWriter / InboxReader / OutboxWriter class API 稳定
- **M#8 耦合界面最小**：InboxWriter 3 方法 / InboxReader 4 方法 / OutboxWriter 1 方法 / 工厂 2 个
- **M#9 显式表达编译器可检**：Result ADT / discriminated union priority / 错误类命名（InboxListFailed / InboxMoveFailed）
- **M#10 不合理停下**：drainInbox 排序合理 / 不抛保证 Runtime 轮询继续
- **M#11 边界不对停下**：A.X-1/A.X-2 触发应然消解 design phase（推 Stage 2）

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D1b 状态可观察** / **D1c 中断可恢复** / **D1d 事后可审计**：纯 audit 链路 + 目录即状态 + Result ADT
- **D2 不得丢弃/静默**：所有失败路径走 audit + throw（A.1-A.4 闭环）
- **D3 用户可观察**：`.md` 人类可读 / audit 事件流可聚合
- **D5 日志重建**：消息 `.md` + audit 事件对
- **D7 系统可信路径**：目录在 WRITABLE_PATHS 内
- **D8 事件驱动**：inbox 监听归 Runtime 装配 + FileWatcher
- **D9 CLI 唯一外部入口**：N/A（本模块 L2 内部基础服务 / 0 外部入口 / CLI outbox 视图调 InboxReader/OutboxWriter）
- **D10 多 claw 不隔绝**：**核心落实者**（跨 claw 通过 outbox → inbox 写入）
- **D4 / D6 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：**核心落实者**（文件即消息 + 目录即状态 / `.md` + frontmatter + 目录三态）
- **P2 上下文工程**：跨 agent 上下文经 outbox/inbox 传递
- **P3 分多个智能体加分子任务**：单一代码基服务所有 claw
- **P4 系统为智能体服务**：基础设施 / 跨 agent 持久化通信

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

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
- 2026-05-04 / cross-doc audit drift 修订（§7.C Module Logic 命名 M1-M11 → M#1-M#11 align gateway+runtime+其他模块 / Design Principles D9 verbatim「CLI 唯一外部入口」+ D10「多 claw 不隔绝」编号修 align principles.md / §3 资源改 table 「inbox+outbox dir」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim 已正确「分多个智能体加分子任务」/ 是 systematic drift cluster 中少数无需修的模块）
- 2026-05-04 / phase 440 send 工具物理迁（main `1a43d207`）/ git mv `src/foundation/tools/builtins/send.ts` → `src/foundation/messaging/tools/send.ts` + NEW dir `messaging/tools/` + Assembly 显式 register / 业务工具归 owner module 第 3 实证（phase360 done + phase416 memory_search + 本 phase）
- 2026-05-04 / phase 461 parseFrontmatter shared utility 推翻 + 4 caller inline parser（main `c15333e9`）/ DELETE `src/foundation/frontmatter/` + 154 行 test / 4 caller (codec-inbox + inbox-writer + skill-system/registry + memory_search) inline 27 行 / 净 -84 行 / 1356 tests PASS / **DRY reflex 反例落地实证**（4 维度反向测试均失败 / `practices.md §DRY reflex` 案例）/ §A.X-2 + §7.E KD ⚠ STALE 双 row 升 ✅ closed
- 2026-05-04 / phase 477 notify_claw 工具实施位置 design 落地（design only / 0 src 改 / r64 C fork）/ 用户拍板 γ messaging/tools/ + schema sharpen（content→body align InboxMessageOptionsBase + 不暴露 priority enum / interrupt boolean → metadata priority mapping）+ profile motion-only + 跨模块 interrupt mechanism contract（messaging 写 priority + runtime 读 + PriorityInboxInterrupt）/ §A.7 closed / 实装推 r65+ code phase
- 2026-05-09 / **phase 567 H fork 深度复审 fan-out**（design only / 0 src 改 / r68 / 起步 SHA `10b58fb4`）/ 主会话 fan-out 3 sub-agent（inbox + contract + messaging-out）/ 18 P0+P1 全 spot-check + 四态分类（per phase 556 模型）/ messaging 模块浮出 5 NEW §B row：L2c.G2 peekMetas Result ADT（A-P1.2 业务决策 dominant α）+ L2c.G3 inbox YAML vs outbox markdown 对称性（C-P1.3 业务决策 dominant β/γ）+ L2c.G4 codec-outbox 无 decodeOutbox（C-P2.1 业务决策 等价）+ L2c.G5 notify.ts encodeInbox 失败路径 audit gap（C-P0.2 framing refine / VERIFIED 升 §A 候选）+ L2c.G6 InboxMessage.content vs body 命名（A-P0.1 业务决策 dominant β）/ STALE 推翻 3 项（A-P1.1 parseFrontmatter 重复 = phase 461 inline 是合规 + A-P1.3 writeSync 双轨 = §B L2c.G1 已登记 + C-P1.2 extraFields = phase 401 ⚓）/ dispatch stale ratio P0+P1 = 5/18=28% / framing refine + STALE 合 8/18=44% / 「fork 起首必 Path #1 全表核」N+1 实证累 / **「主会话代码审查 fan-out 模板」第 3 实证**（r65 + r67 + r68）+ **「review claim 实测四态分类」第 3 phase 实证**（556 + 563 + 567）+ **design only 单 Step 内联模板第 5 实证**（503+505+545+554+567）/ design 同步 5 NEW §B row（L2c.G2-G6）+ 推 r69+ 用户拍板 + code phase 实施
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_messaging.md vs arch §13 + 表 1/2/3 + interfaces/l2c.md Messaging 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7/D8/D10 + D4/D6/D11 N/A + Philosophy P1-P4 + Path #1-#7）/ 6 主能力 align arch 表 2 / 2 dep + 5 caller list align arch 表 1 / send + notify_claw 工具 align arch 表 3 / 修 §7.A A.X-2 + §7.E KD ⚠ STALE → ✅ closed by phase 461 / 补 phase 440+461+477 closure timeline entry / L2c.G1 (messaging) inbox 写入同步加异步描述精度 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改
- 2026-05-10 / **r88 C fork phase 664 推后 4 业务决策 P2 推 user 拍板**（design only / 0 src / 起步 SHA `9ea2ee9f`）/ Path #1 实测 4 P2 + 28 原则 cross-check / **P2.10 L2c.G4 decodeOutbox** ✅ closed / 用户拍板 β YAGNI（0 caller / outbox sender write-and-forget / phase 567+664+r88 三评一致）/ **P2.11 L2c.G6 content vs body** 推荐 β 保现状+jsdoc（内外分层命名 design intent / 待 user）/ **P2.12 L2c.G3 YAML vs markdown** 推荐 β 保现状 或 γ 文档 sharpen（M#1 职责差异 / 待 user）/ **P2.13 L2c.G7 SkillSystem audit? DIP** 推荐 β 保 optional（实然全传 / 待 user）/ §B row L2c.G3/G6 追加 r88 实测复评 / §B row L2c.G4 标 closed / l2_skill_system §B 追加 L2c.G7 NEW row / 0 src 改 / per `feedback_business_decision_phase_user_ratify` + `feedback_no_code_no_code_plan`

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| Messaging L2 通用消息原语 / pending/done/failed 三态目录约定 | ✓（§1 + §4）|
| Messaging 类型物理隔离（types/messaging.ts / phase344 D）| ✓（interfaces/l2c.md + §3）|
| Audit event const 模块自治（H1 收官一致）| ✓（§5 / caller 风格统一并轨合规反例 / 跨模块 reference 模板）|
| ~~MessageCodec L1 应然消解~~ ✓ 已闭环（phase361）| ✓（§7.A A.X-1）|
| **parseFrontmatter shared utility 抽出错决策** | **✅ closed by phase 461**（main `c15333e9`）| 反向 design phase 落地：DELETE `src/foundation/frontmatter/` + 4 caller 各自 inline 27 行 parser / 净 -84 行 / DRY reflex 反例 4 维度反向测试均失败 / M#2 业务语义归属真合规 / 详 §7.A A.X-2 closed + practices.md「DRY reflex vs M#2 format 自治」|

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
>
> **工具构造**：`createSendTool(outboxWriter: OutboxWriter): Tool` 工厂闭包（phase 533 / caller DIP enforce / 0 module-level mutable / deps 编译时必选）。

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

**【2. 入参】**（phase 477 sharpen / `content` → `body` align 既有 InboxMessageOptionsBase）
- `to`          (string, required)    目标 claw 名
- `body`        (string, required)    消息内容（align `InboxMessageOptionsBase.body` / 既有 messaging schema 一致 / phase 477 修订前用 `content` 名 drift / 现统一）
- `type`        (string, optional)    消息类型 / 默认 `'message'`
- `interrupt`   (boolean, optional)   `true` = 让 claw 当前 step 完成后立即处理（中断当前 turn）/ `false`（默认）= 等 claw 当前 turn 跑完正常处理 / **schema 层不暴露 priority enum**（per §10.3 不对称设计 + LLM 友好原则 / agent 用 boolean / 内部 mapping → metadata priority / 详【6】）

**【3. 成功返回】**
- 写入路径
- 投递确认：消息已落 claw inbox（claw 何时处理由 `interrupt` 决定）

**【4. 副作用 + 跨通道影响】**
- 写文件到 `<claws/<to>>/inbox/pending/<ts>_<typeSlug>_<uuid8>.md`
- **跨进程能力**（D11 motion 单向访问 / motion 有「直接写他人 inbox」特权 / claw 没有对偶能力）
- `interrupt=true` 触发目标 claw 在当前 step 完成时 yield turn（PriorityInboxInterrupt）/ 不打断 LLM 调用本身 / 仅在 step 间隙 abort react 循环
- claw 不存在 / 失败：`success=false` + 错误说明

**【5. profile 准入 + 不变量】**（phase 477 sharpen / profile 排除原则推）
- profile：**motion-only**（claw 看不到此工具）
- profile 排除原则推（每排除有原则依据）：
  - ✗ **claw / subagent / miner**：D11 motion 单向访问 / claw 无「跨 claw 写他人 inbox」对偶能力（claw 只能 send 自己 outbox / 不能 push 他人 inbox / 见 §10.3）
  - ✗ **dream / verifier / readonly**：read-only profile / 0 写工具暴露 / 与 notify_claw 写性质冲突
  - ✓ **motion only**：motion 是 user 代理 / 有「调度 claw / 中断 claw turn」业务特权 / D11 derive
- D11 motion 单向访问能力对应 derive：motion 有「打断 claw turn」特权（interrupt=true → priority='high' metadata → target Runtime trigger PriorityInboxInterrupt）/ claw 0 对偶能力（user 通过 motion 调度 / agent 之间无打断权 / per §10.3）
- readonly: false / idempotent: false
- 工具执行不响应 abort / 不可并行（同 send / write 系列工具）

**【6. interrupt mechanism 应然契约（跨 messaging + runtime / phase 477 sharpen / interrupt→priority 映射模式）】**
- notify_claw 工具 schema 层用 `interrupt: boolean`（agent 友好 / per §10.2 + §10.3 不对称设计 explicit 论证）
- 写 inbox 文件时 / metadata（frontmatter）层翻译 `interrupt → priority` 字段：
  - `interrupt=true` → metadata `priority='high'`（或 `'critical'` / 实施期 derive）
  - `interrupt=false`（默认）→ metadata `priority='normal'`
- target claw Runtime `_hasHighPriorityInbox` 调 `inboxReader.peekMetas({ priority: ['high', 'critical'] })`（既存实然 / runtime.ts:863-866）→ 检测命中 → 触发 `PriorityInboxInterrupt` → step 完成后 abort react 循环
- mechanism 跨 **messaging（写 priority metadata）+ runtime（读 priority + 触发 interrupt）** 双模块协议 / cross-ref l5_runtime §1 做「inbox metadata 检测」+ §5 audit `turn_interrupted cause=priority_inbox`（既存 / 不新立）
- audit：messaging 端 `NOTIFY_CLAW_SENT` 含 `interrupt=true/false` 字段（schema 层 / 不暴露 metadata priority detail）/ runtime 端 `turn_interrupted cause=priority_inbox`
- 设计选择 rationale：工具 schema 层 boolean（LLM 友好）+ metadata 层 priority enum（实施层既存机制 / Runtime 既已读 / inbox metadata 通用 schema）/ 双层 decoupling 让 schema 改 vs metadata 改可独立演化（M#7 耦合界面稳定 derive）
- 实装推 r65+ code phase（含工具 schema → metadata 翻译 + Runtime metadata 读取联动 + 实然 'high' vs 'critical' 选择 derive）

**【7. 实施位置（phase 477 用户 2026-05-04 拍板 = γ）】**
- ✅ **γ `src/foundation/messaging/tools/notify-claw.ts`**（同 send 模板 / phase 440 立 messaging/tools/ dir 模式扩展 / 5 原则全 align M#1+M#2+M#7+M#8+D11）
- α `task/tools/notify-claw.ts`（不通过原则筛 / AsyncTaskSystem 业务边界错位 / 违 M#1+M#2）
- β `motion-tool/notify-claw.ts`（不通过原则筛 / identity 不应模块边界化 / 违 D10/D11+M#8）
- (d) 其他候选（cli / 重加 builtins 等 / ROI 负 / 不推荐）
- **实装推 r65+ code phase**：NEW notify-claw.ts + motion profile register + Assembly register + 5+ caller cascade scope 实施期 derive

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

## phase 684 — Sub-B fan-out outbox-writer phantom closed

### B-P2.5 outbox-writer write 失败 0 corrupt-isolate + 0 fallback

- **claim**：与 inbox-writer / result-delivery fallback 不对称
- **状态**：C3 STALE phantom
- **结论**：closed by phase 684 / outbox 是 producer-side / 失败 throw 让 caller 决策 / 0 fallback 是 design intent（vs inbox 是 sink）/ 不 land
