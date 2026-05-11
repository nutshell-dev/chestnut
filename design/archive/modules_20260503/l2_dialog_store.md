# DialogStore 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2b.md](../interfaces/l2b.md) DialogStore 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §9「DialogStore 本质：dialog 持久化服务 / L2 LLM 语义基础设施 / 在 L1 FileSystem 之上把 messages 数组持久化封装成可重用基础服务 / messages 是 LLM 协议层概念 / 不属任何具体业务（不绑 agent 概念）」加 M#1 / M#2 / M#3 / M#4 / Design Principle「中断可恢复」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），DialogStore 的单一职责 = **messages 数组持久化读写的统一入口加恢复语义**：

- **dialog 持久化原语**：load 加 save 加 archive — 这是 messages 这个 LLM 协议概念的 IO 生命周期管理。
- **崩溃可恢复**：原子写保证（writeAtomic）让任意时刻崩溃后 messages 不被半写污染（derive 自 Design Principle「中断可恢复」加「磁盘即权威」）。
- **冷启动恢复**：current 缺失时回退到 archive 历史 / archive 全坏时返回空 dialog — load 永远不抛 / 调用方永远得到可用 LoadResult / `source: current/archive/empty` 是重要信号。
- **corruption 隔离**：解析失败的 dialog 改名 `.corrupted`（下次 load 不重踩）+ 审计（D2「不丢弃 / 静默」derive — 损坏数据不静默忽略）。
- **悬空 tool_use 修复**：纯函数 `repair(messages)` 注入 synthetic tool_result 让中断恢复后 LLM 可继续（修复逻辑与 dialog IO 解耦）。

> 具体 API 形态归 [interfaces/l2b.md](../interfaces/l2b.md) DialogStore 节。具体实现细节（current.json / archive 时间戳命名 / validateDialog 宽容性等）的存在依据是「持久化原语 + 崩溃恢复机制」— 实然采纳的细节差异（如 createdAt 缓存 / clawId 强制非可选）登记 §7.B。

### 不做

- **不 own 任何 clawforum agent 业务概念**（不知 motion / claw / sub-agent identity 加父子关系等业务）— derive 自 M#2 业务语义归属（DialogStore 业务语义仅 LLM messages 协议级）加 M#5 单向依赖
- **不 own 业务内容判读**（message 内的 text 加 tool_use 内容含义归调用方）— derive 自 M#2
- **不 own dialog agent 身份关联**（哪个 claw 的 dialog 加 sub-agent dialog 归调用方决定 / 本模块仅持 stable clawId 用于 dialog 归属）— derive 自 M#2
- **不 own 跨 dialog 关联**（父代理加子代理 dialog 关系归 L4 TaskSystem）— derive 自 M#1 独立可变职责
- **不 own archive 触发策略**（归档时机加保留策略归调用方）— derive 自 M#2
- **不 own 对话语义编辑**（消息合并 / 裁剪 / 截断 / 压缩归更上层）— derive 自 M#1
- **不 own 并发写协调**（依赖调用方保证单 dialog 单 writer / writeAtomic 仅保证单次写原子）— derive 自 M#1
- **不 own 归档清理**（archive/ 无保留策略 / 由运维或未来 janitor）— derive 自 M#1
- **不 own 加密 / 签名**（消费者侧 / 安全层职责）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），DialogStore 的业务语义边界：

- **own**：messages 数组 IO 生命周期概念 — load / save / archive / corruption 隔离 / repair。这些是 DialogStore 唯一懂的「业务」（LLM 协议层级，不是 clawforum agent 业务级）。
- **角色定位**：DialogStore 是「**LLM 协议级 messages 持久化**」非「**对话语义解读器**」。本模块知 messages 数组结构（兼容 LLM provider 的 message schema）但不知 message 内容的业务含义。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），DialogStore 独占的资源：

- **dialog 持久化文件读写入口**：clawforum 内部 messages 数组持久化必经 DialogStore 间接访问 — 是 clawforum 对 dialog 文件 artifact 的唯一调用入口。
- **`<dialogDir>/current.json`**：当前对话 messages 数组 / 独占归属。
- **`<dialogDir>/archive/<ts>_<uuid8>.json`**：archive 历史对话。
- **`<dialogDir>/<filename>.corrupted`**：corruption 隔离改名。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），DialogStore 持久化 messages 数组本身 — 是 clawforum 「中断可恢复」原则的关键 artifact（重启时从磁盘 dialog 文件重建对话上下文继续）。

### 磁盘布局

```
<dialogDir>/
├── current.json                 ← 当前对话 messages（独占归属 / writeAtomic 写入）
├── current.json.corrupted       ← 解析失败时改名隔离（避免下次重踩）
└── archive/
    ├── 1735200000000_a1b2c3d4.json  ← <ts>_<uuid8>.json
    └── ...                          ← archive 历史对话（无清理策略）
```

### 文件格式

```json
{
  "version": 1,
  "clawId": "...",
  "createdAt": "2026-04-27T...",
  "updatedAt": "2026-04-27T...",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

### 重建语义

- **进程重启**：`load()` 读 current.json / 不存在或损坏时降级到 archive 扫描
- **dialog 归档**：`archive()` 后 current.json move 到 archive/ / 新 dialog 从空起点
- **corruption 隔离**：解析失败的文件自动改名 `.corrupted` / 防止下次 load 重踩
- **archive 扫描**：按文件名时间戳倒序 / 取最新可解析的作为返回 / 损坏的跳过继续
- **createdAt 重置**：archive() 后清空缓存 / 下次 save 生成新 createdAt 表示「新对话起点」
- **磁盘即权威**：内存只缓存 createdAt / 所有 messages 状态以磁盘为准

## 5. 审计事件清单

事件常量集中定义于 `DIALOG_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `DIALOG_CORRUPTED` | current.json 或 archive 单份解析失败 | `file=`, `reason=` |
| `DIALOG_CORRUPTED_ISOLATE_FAILED` | .corrupted 改名失败 | `file=`, `reason=` |
| `DIALOG_ARCHIVE_READ_FAILED` | archive/ 目录读失败 | `dir=`, `reason=` |
| `DIALOG_RECOVERED` | archive 恢复成功 | `from=<filename>` |
| `DIALOG_SAVE_FAILED` | save 旁路失败（archive 旁路清理等）| `reason=` |
| `DIALOG_ARCHIVE_FAILED` | archive 旁路失败 | `reason=` |
| `DIALOG_LOAD_FAILED` | 占位（应然保留 / load 全链路统一失败事件）| 待用 |

## 6. 层级声明

L2 LLM 语义基础设施层（与 Stream / LLMOrchestrator / ToolProtocol 同子层 / messages 持久化原语 / messages 是 LLM 协议层概念 / 不绑 agent 业务）。下游 AgentExecutor + Runtime 通过 createDialogStore 工厂消费 + 注入 deps。详见 [architecture.md](../architecture.md) 加 [interfaces/l2b.md](../interfaces/l2b.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 load 路径软吞（console.warn / console.error）| drift | 已闭环（phase148）| 4 console → 4 audit events（DIALOG_CORRUPTED_ISOLATE_FAILED / DIALOG_ARCHIVE_READ_FAILED / DIALOG_CORRUPTED 统一 / DIALOG_SAVE_FAILED + DIALOG_ARCHIVE_FAILED）|
| A.2 audit 可选性（`audit?: Audit`）| drift | 已闭环（phase148）| ctor `audit: Audit` 必传 / 不提供 NoopAudit / 测试用 InMemoryAudit |
| **ctor `clawId: string = randomUUID()` 默认值** | drift / 中 | 已闭环（phase357）✓ | r43 A audit fork 第 6 轮新发现 / 工厂签名强制非可选 / 但 ctor 仍可绕过传 / 应强制 ctor 非可选 |
| A.r53-1 缺「恢复历史时刻前缀」对外能力 + system prompt 记录 | feature gap / 中 | open | 应然对外承诺两项：(1) **system prompt 落盘记录**（实然 DialogData 仅 messages / 应然加 system prompt 增量历史 / 跟 messages 同套路 cumulative + 变更增量 / 信息不丢失）/ (2) **「按 marker 恢复任意历史时刻前缀」能力**（marker = toolUseId / messageIndex / timestamp 任一 / 返该时刻 messages 切片 + 当时 system prompt）。spawn / ask_claw 设计依赖此能力（marker 模式 / spawn 仅记 marker / ask_claw 解析 → 还原 main 当时状态）。资源归 DialogStore（M#3）/ **接口形态 / 缓存策略 / 数据 schema 等实现细节应然 silent / 模块自决策**。需扫 current.json + archive/ 全量覆盖（信息不丢失原则保证 marker 找得到）。派生用例：时间旅行 debugging / dialog replay / 跨 claw 审计。源：r53+ §10 spawn 工具通道讨论 |
| **A.naming-1 code 模块名 `SessionManager` ↔ 应然 `DialogStore`** | naming drift / 大 | **closed（phase423 SHA `5e4dc48b`）** | **应然权威 = architecture.md §9 + 表 1「DialogStore」**（interfaces/l2b.md / 本文件全 align）。实然 4 处 cascade drift：(1) `src/foundation/session-store/` 目录名 (vs `dialog-store/`) (2) `SessionManager` class 名 (vs `DialogStore`) (3) `@module L2.SessionStore` 注解 (4) `createSessionManager` factory + `SESSION_AUDIT_EVENTS` 等 cascade 用「Session」前缀。phase423 已全治理：git mv dir + class rename + factory rename + @module 注解 + 15 import path + 17 caller 文件 / SessionData 名保留（phase414c 已采纳为应然 type 名）/ audit event 字符串 value 不动 |
| **A.naming-2 应然 `DialogStoreError` 类应然幻象** | spec drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md 删 DialogStoreError 应然幻象 class）| 历史 interfaces 写 `DialogStoreError extends Error { code }` / 实然从未实现 (load/save 失败原样抛 fs error / parse error) / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l2b.md 修订时删除 |
| **A.naming-3 `repair` static method vs standalone function** | spec drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 static method）| 历史 interfaces 写 `export function repair(messages): Message[]` standalone / 实然 `SessionManager.repair(messages, opts?)` static method + 返 `{ repaired, toolCount }` / phase414c interfaces/l2b.md 修订 align 实然 static method 形态 + opts 字段 + 返 tuple |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| current.json 改名 `.corrupted` 边界（改名失败下次仍踩同一损坏文件）| 边界场景概率低 / 已 A.1 audit 覆盖 | 出现频繁踩同一损坏 |
| `archive/` 无保留策略（不清理 / 不压缩）| MVP 不驱动 | 磁盘告警或保留窗口需求 |
| `validateDialog` 宽容补默认值（旧版字段缺失自动补全）| 向后兼容设计 / 但字段缺失不审计 | 加 schema 迁移时补 `dialog_schema_upgraded` 事件 |
| `createdAt` 缓存进程生命周期 | 重启重新读文件 / archive() 后重置 | / |
| 并发写依赖调用方单 writer | ProcessManager 保障单 daemon 兜住 | 跨进程并发写 |
| `repair` 静态方法放 DialogStore 类（而非独立 repair.ts 模块）| 代码组织偏差 / 不影响行为 | 模块复杂度增长 |
| ~~**类名 `SessionManager` vs 模块名（旧）不一致**~~ | ~~drift（M#9 同一概念同一名字）~~ | ~~⚓ accepted-stable（影响面广 / 改名不紧急 / 未来统一时建议类名 → 模块名 / phase394 anchor 标记）~~ → **closed（phase423 SHA `5e4dc48b`）** / 类名同步 DialogStore / drift 消除 |
| **LOAD_FAILED 常量 dead** | drift / 低 | ⚓ accepted-stable（应然 §5 注记保留未用占位 / r43 A audit fork 新发现 / audit-events.ts 定义但 store.ts 0 调用 / phase389 anchor 标记 / rename 后实然常量名 DIALOG_LOAD_FAILED 同步迁移待 r61+ phase）|
| modules.md 索引层 drift（"messages.json" / "耦合：无"）| 文档 drift | 索引层一致性自检 phase 统一修 |
| **应然 rename 已落地（旧名 → DialogStore / 语义 sharpen / session 字眼留给连接级会话）** | naming drift / 实然代码未同步 | **closed（phase423 SHA `5e4dc48b`）** / 类名 + 工厂名 + audit 事件 const + 文件夹 src/.../session → src/.../dialog 全同步 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：messages 数组持久化 IO 生命周期 / 与「对话语义理解」（上层消费方）独立可变
- **M2 业务语义归属**：load / save / archive / corruption 隔离 / repair 全在 DialogStore
- **M3 资源归属**：current.json + archive/ 归 DialogStore 独占
- **M4 持久化**：**驱动原则**（模块核心职责即持久化 / writeAtomic 保证原子）
- **M5 依赖单向**：DialogStore → L1 FileSystem + L2 AuditLog（per arch §9 表 1）/ 0 反向
- **M6 依赖结构稳定**：interface phase0 稳定 / phase148 audit 可选→必传是非向后兼容但协议稳定
- **M7 耦合界面稳定**：应然 rename 后类名与模块名同步（DialogStore = DialogStore）
- **M8 耦合界面最小**：DialogStore 4 参 / 工厂 4 参 / repair 静态精简
- **M9 显式表达编译器可检**：LoadResult.source 强类型 union / DialogData interface / `clawId: string` 工厂强制非可选
- **M10 不合理停下**：load 永不抛保证上层总能继续
- **M11 边界不对停下**：save 写失败向上冒泡 / 调用方决策

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：corruption 改名保留原文件（.corrupted）/ audit 事件捕获失败信号
- **D1b 状态可观察**：LoadResult.source 显式区分三路径 / createdAt + updatedAt ISO 时间戳
- **D1c 中断可恢复**：**核心落实者**（archive 扫描 + repair 静态方法修悬空 tool_use / 模块存在理由即此原则）
- **D1d 事后可审计**：phase148 必传 audit + 6 事件全覆盖
- **D2 不得丢弃/静默**：phase148 清零后所有失败走 audit
- **D3 用户可观察**：audit 事件 + LoadResult.source 可供上层展示
- **D4 LLM 调用恢复**：repair 专门处理 tool_use 悬空 = LLM 调用中断恢复
- **D5 日志重建**：messages 数组完整落盘 + audit 追踪生命周期
- **D7 系统可信路径**：dialogDir 调用方装配期传入 / 约定在 WRITABLE_PATHS 内
- **D8 事件驱动**：灰度（audit 发出事件但 DialogStore 不消费 / 上层 Runtime 驱动 save 触发）
- **D6 / D9 / D10 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：**核心落实者**（dialog 文件落 agent dir / 对话即状态）
- **P2 上下文工程**：「对话即状态」通过 messages 数组 JSON 持久化到 dialogDir 落实
- **P3 分多个智能体加分子任务**：单 DialogStore 实例服务任一 claw / clawId 显式归属
- **P4 系统为智能体服务**：简单 JSON 持久化 / archive/ 扁平时间戳命名

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase148 / phase192 / phase321 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：A.1 + A.2 闭环（4 console → 4 audit events / audit ctor 必传升级）
- phase192：契约 §7 backfill / 0 新增（既有 §A/§B 充分）
- phase321：modules.md 索引 IAuditSink drift 修订
- r43 A：audit fork 第 6 轮 / 实测 ~98% align / 暴露 ctor `clawId` 默认值 + LOAD_FAILED 常量 dead 双 drift
- r60+ rename：应然模块名 sharpen 为 DialogStore（语义留 session 给连接级会话 / 类名 + 工厂名 + DIALOG_* audit const + dialog/ 文件夹同步 / 实然 r61+ phase 落地）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2b.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#3 DialogStore 不绑目录（base path 由调用方决定）| ✓（dialogDir 装配期传入）|
| KD（应然）audit 事件由 DialogStore 自治命名（caller 风格统一并轨合规反例第 2 个 / 100% 走 const）| ✓ |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **load 三路径**：current / archive / empty
- **corruption 隔离**：.corrupted 改名 + 跳到下一份 archive
- **save 原子性**：writeAtomic + 写失败冒泡
- **archive 生命周期**：current.json move + createdAt 重置
- **createdAt 缓存**：进程生命周期 + archive() 后重置
- **repair 多场景**：无 tool_use / 有 tool_use / 含 interruptionMessage / fail-loud 缺省文案
- **validateDialog 字段补全**：version / messages / 时间戳缺失补默认
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言

> A.1 / A.2 修复后 audit 事件断言已补 / ctor `clawId` 默认值修复后需补「ctor 默认值绕过」防御测试。
