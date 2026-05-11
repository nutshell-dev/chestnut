# DialogStore 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2b.md](../interfaces/l2b.md) DialogStore 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §9「DialogStore 本质：**LLM call snapshot 持久化服务**（phase 709 reframe）/ L2 LLM 语义基础设施 / 在 L1 FileSystem 之上把 LLM API call 3 参（systemPrompt + messages + toolsForLLM）3 件同源持久化封装成可重用基础服务 / 这 3 件是 LLM 协议层概念 / 不属任何具体业务（不绑 agent 概念）」加 M#1 / M#2 / M#3 / M#4 / Design Principle「中断可恢复」+「全然一致性」（phase 709 / reader of snapshot 必使用 producer 实然用的值 / 不重 build / 不重 derive）。

### 做

**术语定义（phase 709 sharpen）**：

- **dialog（广义 / 本模块语境）** = 一次 LLM 调用的完整 context = `{systemPrompt, messages, toolsForLLM}` 3 件同源 snapshot
- **messages（狭义）** = 对话历史数组（`Message[]` / user/assistant turn 交替 / 仅是 dialog 的一部分 / 不含 systemPrompt + tools）
- 凡 design / code 用 "dialog" 时指广义 / 用 "messages" 时指狭义 / 不混

---

应用 M#1（一个模块封装一组独立可变的职责），DialogStore 的单一职责 = **dialog（广义 = LLM call snapshot）持久化读写的统一入口加恢复语义**（phase 709 reframe / 推翻 phase 466 把 dialog 等同于 messages 的狭义定义）：

- **dialog 持久化原语**：load 加 save 加 archive — 这是 dialog（广义 = LLM API call 完整上下文）的 IO 生命周期管理 / 每次 save 接受完整 3 件 dialog snapshot。
- **3 件同源**：systemPrompt + messages（狭义 / 对话历史数组）+ toolsForLLM 是 dialog（广义）的 3 个组成部分 / **同等地位 / 一组持久化**（不是「messages 主 / systemPrompt 附属」的不对等关系）/ 跟随 Motion runtime 每 turn LLM call 实然用的值 dynamic update（每 turn save 时 caller 传入完整 dialog snapshot）。
- **崩溃可恢复**：原子写保证（writeAtomic）让任意时刻崩溃后完整 dialog 不被半写污染（derive 自 Design Principle「中断可恢复」加「磁盘即权威」）。
- **冷启动恢复**：current 缺失时回退到 archive 历史 / archive 全坏时返回空 dialog — load 永远不抛 / 调用方永远得到可用 LoadResult / `source: current/archive/empty` 是重要信号。
- **corruption 隔离**：解析失败的 dialog 改名 `.corrupted`（下次 load 不重踩）+ 审计（D2「不丢弃 / 静默」derive — 损坏数据不静默忽略）。
- **悬空 tool_use 修复**：纯函数 `repair(messages)` 注入 synthetic tool_result 让中断恢复后 LLM 可继续（修复逻辑与 IO 解耦 / 此处 messages 是狭义 / repair 是 messages 数组级 helper / 不动 dialog 整体）。
- **历史时刻 dialog 恢复**：`restorePrefix(marker)` 对外能力 / marker = `{clawId, toolUseId}` / 扫 current + archive 找含 toolUseId 的 SessionData → 返完整 dialog snapshot（`{messages 切片, systemPrompt, toolsForLLM, meta}`）/ 找不到抛 MarkerNotFoundError / 派生用例：时间旅行 debugging / dialog replay / 跨 claw 审计 / r53+ spawn cluster ask_caller 工具 / **r70+ ask_motion 全然一致性 reuse**（subagent 端从 motion DialogStore 直 read dialog snapshot / 全然一致性 / 0 重复 build systemPrompt / 0 重复 derive tools / source 单一 = Motion runtime 实然用的值 / phase 709 reframe）。

> 具体 API 形态归 [interfaces/l2b.md](../interfaces/l2b.md) DialogStore 节。具体实现细节（current.json / archive 时间戳命名 / validateDialog 宽容性等）的存在依据是「持久化原语 + 崩溃恢复机制」— 实然采纳的细节差异（如 createdAt 缓存 / clawId 强制非可选）登记 §7.B。

### 不做

- **不 own 任何 clawforum agent 业务概念**（不知 motion / claw / sub-agent identity 加父子关系等业务）— derive 自 M#2 业务语义归属（DialogStore 业务语义仅 LLM 协议级 dialog snapshot / 3 件同源持久化）加 M#5 单向依赖
- **不 own 业务内容判读**（message 内的 text 加 tool_use 内容含义归调用方）— derive 自 M#2
- **不预设 dialog 与 agent 业务概念关联**（caller 装配选业务关联 / 本模块 0 知 clawId / motion / sub-agent 等业务）— derive 自 M#2 + D5 底层不预设上层
- **不预设 dialog 持久化文件名**（filename caller 注入 / 主 claw 选 'current.json' / subagent 选 'messages.json' 等业务约定归 caller）— derive 自 D5
- **不预设 archive 子目录路径**（archive 触发 + archiveDir 配置归 caller）— derive 自 D5
- **不 own regime hash detection 加 lifetime 切换决策**（regime 切换是 caller 业务 / Motion runtime 自己比较前后 turn systemPrompt 决定是否新 regime / DialogStore 仅 own per-turn snapshot 持久化 / 接受 caller 每 turn 传入的 latest systemPrompt 值）— derive 自 M#2 + D5（caller own regime 业务 / DialogStore own snapshot 原语）/ phase 709 reframe：推翻 phase 466「1 instance = 1 system prompt regime / lifetime 锁定 / regime hash 用途」立场（与 Motion runtime 实然 mismatch / Motion 每 turn dynamic build / DialogStore 跟随 dynamic 不锁定）
- **不 own 跨 dialog 关联**（父代理加子代理 dialog 关系归 L4 AsyncTaskSystem）— derive 自 M#1 独立可变职责
- **不 own archive 触发策略**（归档时机加保留策略归调用方）— derive 自 M#2
- **不 own 对话语义编辑**（消息合并 / 裁剪 / 截断 / 压缩归更上层）— derive 自 M#1
- **不 own 并发写协调**（依赖调用方保证单 dialog 单 writer / writeAtomic 仅保证单次写原子）— derive 自 M#1
- **不 own 归档清理**（archive/ 无保留策略 / 由运维或未来 janitor）— derive 自 M#1
- **不 own 加密 / 签名**（消费者侧 / 安全层职责）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），DialogStore 的业务语义边界：

- **own**：dialog（广义 = LLM call snapshot）IO 生命周期概念 — load / save / archive / corruption 隔离 / repair（repair 仅 messages 数组级 helper）。这些是 DialogStore 唯一懂的「业务」（LLM 协议层级，不是 clawforum agent 业务级）。
- **角色定位**：DialogStore 是「**LLM 协议级 dialog（systemPrompt + messages + toolsForLLM 3 件同源）持久化**」非「**对话语义解读器**」。本模块知 messages 数组结构（兼容 LLM provider 的 message schema）+ systemPrompt 字符串 + toolsForLLM 数组结构 但不知 dialog 内容的业务含义。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），DialogStore 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<dialogDir>/<filename>` | 当前 LLM call snapshot SessionData（systemPrompt + messages + toolsForLLM 三件同源 / 独占 / phase 709 reframe）| ✓ writeAtomic |
| `<archiveDir>/<ts>_<uuid8>.json` | 归档 SessionData | ✓ |
| `<dialogDir>/<filename>.corrupted` | corruption 隔离 | ✓ |

**dialog 持久化文件读写入口** — clawforum 内部 dialog（广义 / 含 messages + systemPrompt + toolsForLLM 3 件）持久化必经 DialogStore 间接访问 / 是 dialog 文件 artifact 唯一调用入口。

> 注：(1) `<filename>` caller 装配期注入（如主 claw 'current.json' / subagent 'messages.json'）/ 模块本身不预设 / (2) `<archiveDir>` caller 装配（如主 claw `<dialogDir>/archive/`）/ phase 450 后 archiveDir 可选缺省 'archive'。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），DialogStore 持久化 dialog（广义 = 3 件 LLM call snapshot）本身 — 是 clawforum 「中断可恢复」原则的关键 artifact（重启时从磁盘 dialog 文件重建完整对话上下文 + system prompt + tools 继续）。

### 磁盘布局

```
<dialogDir>/
├── <filename>                   ← 当前对话 messages（独占归属 / writeAtomic 写入）
├── <filename>.corrupted         ← 解析失败时改名隔离（避免下次重踩）
└── <archiveDir>/
    ├── 1735200000000_a1b2c3d4.json  ← <ts>_<uuid8>.json
    └── ...                          ← archive 历史对话（无清理策略 / caller 配置）
```

### 文件格式（phase 709 reframe / 完整 LLM call snapshot）

```json
{
  "version": 2,                                   // phase 709: version bump (schema 加 toolsForLLM + systemPrompt 语义变)
  "clawId": "...",                                // 可选 / caller 装配业务关联时填 / subagent 用例可省
  "createdAt": "2026-04-27T...",
  "updatedAt": "2026-04-27T...",
  "systemPrompt": "...",                          // phase 709: per-turn latest snapshot（跟随 Motion runtime 每 turn re-build 的最新值 / 推翻 phase 466 lifetime 锁定语义）
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "toolsForLLM": [                                // phase 709 NEW: per-turn latest snapshot（LLM API call tools 参 / ToolDefinition[] 纯数据 / 跟随 Motion runtime 每 turn formatForLLM 的最新值）
    { "name": "...", "description": "...", "input_schema": { "..." } }
  ]
}
```

**3 件同源 latest snapshot 语义**：每 turn save 时 caller 必传完整 `{systemPrompt, messages, toolsForLLM}` snapshot / DialogStore 一组写入 atomic / 不允许部分 update（防止 3 件不同步 drift）。

### 重建语义

- **进程重启**：`load()` 读 `<filename>` / 不存在或损坏时降级到 `<archiveDir>` 扫描
- **dialog 归档**：`archive()` 后 `<filename>` move 到 `<archiveDir>` / 新 dialog 从空起点
- **corruption 隔离**：解析失败的文件自动改名 `.corrupted` / 防止下次 load 重踩
- **archive 扫描**：按文件名时间戳倒序 / 取最新可解析的作为返回 / 损坏的跳过继续
- **createdAt 重置**：archive() 后清空缓存 / 下次 save 生成新 createdAt 表示「新对话起点」
- **磁盘即权威**：内存只缓存 createdAt / 所有 dialog 状态（含 messages + systemPrompt + toolsForLLM）以磁盘为准

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

L2 LLM 语义基础设施层（与 Stream / LLMOrchestrator / ToolProtocol 同子层 / dialog（广义）持久化原语 / dialog 3 件（systemPrompt + messages + toolsForLLM）皆 LLM 协议层概念 / 不绑 agent 业务）。下游 AgentExecutor + Runtime 通过 createDialogStore 工厂消费 + 注入 deps / **r70+ AskMotionTool 通过注入 motionDialogStore 直 read dialog snapshot reuse**（per phase 709 reframe / 全然一致性原则）。详见 [architecture.md](../architecture.md) 加 [interfaces/l2b.md](../interfaces/l2b.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 load 路径软吞（console.warn / console.error）| drift | 已闭环（phase148）| 4 console → 4 audit events（DIALOG_CORRUPTED_ISOLATE_FAILED / DIALOG_ARCHIVE_READ_FAILED / DIALOG_CORRUPTED 统一 / DIALOG_SAVE_FAILED + DIALOG_ARCHIVE_FAILED）|
| A.2 audit 可选性（`audit?: Audit`）| drift | 已闭环（phase148）| ctor `audit: Audit` 必传 / 不提供 NoopAudit / 测试用 InMemoryAudit |
| **ctor `clawId: string = randomUUID()` 默认值** | drift / 中 | 已闭环（phase357）✓ | r43 A audit fork 第 6 轮新发现 / 工厂签名强制非可选 / 但 ctor 仍可绕过传 / 应强制 ctor 非可选 |
| A.r53-1 缺「恢复历史时刻前缀」对外能力 + system prompt 记录 | feature gap / 中 | **✅ closed（phase 466 SHA `201bc6df`）** | 应然对外承诺两项：(1) **system prompt 与 messages 配对持久化**（DialogStore 实例 ctor 注入 systemPrompt / lifetime 锁定 / SessionData 加 systemPrompt 字段 / 1 instance = 1 system prompt regime / system 变 = caller 业务决策新建 instance）/ (2) **`restorePrefix(marker)` 完整前缀**（marker = `{clawId, toolUseId}` / 扫 current + archive 找含 toolUseId 的 SessionData / 返 `{messages 切片, systemPrompt, meta}` / 找不到抛 MarkerNotFoundError）。**应然 sharpen 完成 by phase 456 + 用户确认（DialogStore 0 history 数组 / 0 自动 archive on system change / 单值 systemPrompt instance lifetime 锁定）**：§1 加 2 项业务承诺 + §3 资源表加 systemPrompt 字段 + §4 文件格式加 systemPrompt 字段。**实然 drift**：DialogStore ctor 0 systemPrompt 参 / SessionData 0 systemPrompt 字段 / 0 restorePrefix 接口 / 已 phase 466 落地。**派生用例**：时间旅行 debugging / dialog replay / 跨 claw 审计 / r53+ spawn cluster ask_caller 工具依赖（l4_task_system §10.2 锚点）。源：r53+ §10 spawn 工具通道讨论 + phase 456 design 重审 + 用户 8 轮 design-gap derive 锁 |
| **A.naming-1 code 模块名 `SessionManager` ↔ 应然 `DialogStore`** | naming drift / 大 | **closed（phase423 SHA `5e4dc48b`）** | **应然权威 = architecture.md §9 + 表 1「DialogStore」**（interfaces/l2b.md / 本文件全 align）。实然 4 处 cascade drift：(1) `src/foundation/session-store/` 目录名 (vs `dialog-store/`) (2) `SessionManager` class 名 (vs `DialogStore`) (3) `@module L2.SessionStore` 注解 (4) `createSessionManager` factory + `SESSION_AUDIT_EVENTS` 等 cascade 用「Session」前缀。phase423 已全治理：git mv dir + class rename + factory rename + @module 注解 + 15 import path + 17 caller 文件 / SessionData 名保留（phase414c 已采纳为应然 type 名）/ audit event 字符串 value 不动 |
| **A.naming-2 应然 `DialogStoreError` 类应然幻象** | spec drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md 删 DialogStoreError 应然幻象 class）| 历史 interfaces 写 `DialogStoreError extends Error { code }` / 实然从未实现 (load/save 失败原样抛 fs error / parse error) / 应然 rule 必有现实功能依据反向 / phase414c interfaces/l2b.md 修订时删除 |
| **A.naming-3 `repair` static method vs standalone function** | spec drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 static method）| 历史 interfaces 写 `export function repair(messages): Message[]` standalone / 实然 `SessionManager.repair(messages, opts?)` static method + 返 `{ repaired, toolCount }` / phase414c interfaces/l2b.md 修订 align 实然 static method 形态 + opts 字段 + 返 tuple |
| ~~**A.r61-1 DialogStore 实然预设上层模块语义（4 点）**~~ | ~~drift / 中 → high~~ | **✅ closed (phase 450 / `38f86606`)** | phase 450 落地：(1) ctor 签名 `(fs, dialogDir, audit, filename, clawId?, archiveDir?)` / filename 必填 caller 注入 / clawId 可选 / archiveDir 可选缺省 'archive' / (2) types.ts SessionData.clawId 改可选 / (3) save() + load() emptySession 0 clawId 时 schema 不含字段 / (4) factory createDialogStore 签名同步 / (5) caller cascade 17+ 处显式传 'current.json'（assemble + 14 session.test + 1 dialog.test + 1 runtime-init test + factories.test + helpers/runtime-deps）/ 0 disk path 改 / 1373+ tests PASS / **支持 phase β SubAgent A.r60+1 ephemeral DialogStore 装配模式** / 9 files +31 -27 / 4 design-gap L2.G1+L2.G2 closed / L2.G3 partial / L2.G4 推后 |

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
| **L2b.G1 (dialog-store)** arch 表 2 缺「marker prefix 恢复」能力 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出 / `feedback_design_doc_sync_after_phase_closure` 第 N 实证**：interfaces/l2b.md 暴露 `restorePrefix(marker): Promise<RestoreResult>` + `MarkerNotFoundError` + `systemPrompt` ctor 必填 / phase 466 closure (SHA `201bc6df`) 已实施 / arch 表 2 DialogStore row 仍写「当前 dialog 读写、归档、冷启动 archive 恢复、损坏文件隔离、悬空 tool_use 修复」5 能力 / 未列 marker prefix 恢复（spawn cluster ask_caller 派生消费方）+ systemPrompt regime lifecycle | **业务决策性 / 用户拍板候选**：α arch 表 2 DialogStore row 加「marker prefix 恢复（returns systemPrompt + messages 切片 + meta）」+ 「systemPrompt regime lifetime 锁定」/ β 保留现状（interfaces 自 sharpen 已足够 / arch 表 2 仅列高层能力）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：dialog（广义 3 件 snapshot）持久化 IO 生命周期 / 与「对话语义理解」（上层消费方）独立可变
- **M#2 业务语义归属**：load / save / archive / corruption 隔离 / repair 全在 DialogStore
- **M#3 资源归属**：`<dialogDir>/<filename>` + `<archiveDir>/` 归 DialogStore 独占
- **M#4 持久化**：**驱动原则**（模块核心职责即持久化 / writeAtomic 保证原子）
- **M#5 依赖单向**：DialogStore → L1 FileSystem + L2 AuditLog（per arch §9 表 1）/ 0 反向
- **M#6 依赖结构稳定**：interface phase0 稳定 / phase148 audit 可选→必传是非向后兼容但协议稳定
- **M#7 耦合界面稳定**：应然 rename 后类名与模块名同步（DialogStore = DialogStore）
- **M#8 耦合界面最小**：DialogStore 4 参 / 工厂 4 参 / repair 静态精简
- **M#9 显式表达编译器可检**：LoadResult.source 强类型 union / DialogData interface / `clawId` 字段 caller 装配选（非模块强制必填 / 具体可选或退 schema 待 phase 445 定）
- **M#10 不合理停下**：load 永不抛保证上层总能继续
- **M#11 边界不对停下**：save 写失败向上冒泡 / 调用方决策

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：corruption 改名保留原文件（.corrupted）/ audit 事件捕获失败信号
- **D1b 状态可观察**：LoadResult.source 显式区分三路径 / createdAt + updatedAt ISO 时间戳
- **D1c 中断可恢复**：**核心落实者**（archive 扫描 + repair 静态方法修悬空 tool_use / 模块存在理由即此原则）
- **D1d 事后可审计**：phase148 必传 audit + 6 事件全覆盖
- **D2 不得丢弃/静默**：phase148 清零后所有失败走 audit
- **D3 用户可观察**：audit 事件 + LoadResult.source 可供上层展示
- **D4 LLM 调用恢复**：repair 专门处理 tool_use 悬空 = LLM 调用中断恢复
- **D5 日志重建**：dialog（含 messages + systemPrompt + toolsForLLM）完整落盘 + audit 追踪生命周期
- **D7 系统可信路径**：dialogDir 调用方装配期传入 / 约定在 WRITABLE_PATHS 内
- **D8 事件驱动**：灰度（audit 发出事件但 DialogStore 不消费 / 上层 Runtime 驱动 save 触发）
- **D6 / D9 / D10 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：**核心落实者**（dialog 文件落 agent dir / 对话即状态）
- **P2 上下文工程**：「对话即状态」通过 dialog 3 件 snapshot（messages + systemPrompt + toolsForLLM）JSON 持久化到 dialogDir 落实
- **P3 分多个智能体加分子任务**：单 DialogStore 实例服务任一 caller 注入的 dialog 上下文 / clawId 等业务关联 caller 装配选
- **P4 系统为智能体服务**：简单 JSON 持久化 / archive/ 扁平时间戳命名

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase148 / phase192 / phase321 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：A.1 + A.2 闭环（4 console → 4 audit events / audit ctor 必传升级）
- phase192：契约 §7 backfill / 0 新增（既有 §A/§B 充分）
- phase321：modules.md 索引 IAuditSink drift 修订
- r43 A：audit fork 第 6 轮 / 实测 ~98% align / 暴露 ctor `clawId` 默认值 + LOAD_FAILED 常量 dead 双 drift
- r60+ rename：应然模块名 sharpen 为 DialogStore（语义留 session 给连接级会话 / 类名 + 工厂名 + DIALOG_* audit const + dialog/ 文件夹同步 / 实然 r61+ phase 落地）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2b.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-03 / r61 phase 444 design 重审 / DialogStore 不预设上层模块语义 应然 sharpen / §1 §3 §4 §M#5 修订 / 4 design-gap L2.G1-G4 登记 interfaces/l2b.md / §A.r61-1 实然 drift 登记
- 2026-05-04 / **phase 450 §A.r61-1 落地**（应然 + 实然 align / `38f86606`）/ ctor 签名 +filename 必填 + clawId/archiveDir 可选 / SessionData.clawId 可选 / save()+load() emptySession 0 clawId schema 不含字段 / 17+ caller cascade（assemble + 17 tests）/ 0 disk path 改 / 1373+ tests PASS / **design+code 联动模板**（phase 444 design + phase 450 code α）/ 4 design-gap L2.G1+L2.G2 closed / L2.G3 partial / L2.G4 推后 / **支持 phase β SubAgent A.r60+1 ephemeral DialogStore 装配模式**
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 align gateway+runtime / §3 资源改 table 「<dialogDir>/<filename> + <archiveDir> + .corrupted」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design Principles 编号 已正确）
- 2026-05-04 / L2.G5-G7 design-gap 用户 8 轮 derive 锁定（应然 sharpen 升级）：DialogStore 加 ctor `systemPrompt: string` 必填 / SessionData 加 `systemPrompt` 字段（writeAtomic 同步落盘）/ 0 history 数组 / 0 auto-archive on system change / 1 instance = 1 system prompt regime / system 变 = caller 业务决策新建 instance（archive() current → new DialogStore with newSystemPrompt + 业务决定继承 messages 否）/ restorePrefix(marker) 加 method 返完整前缀 `{messages, systemPrompt, meta}` / marker = `{clawId, toolUseId}` / L2.G5-G7 closed by 用户确认
- 2026-05-04 / **phase 466 code 落地（SHA `201bc6df`）**：types.ts 扩（SessionData.systemPrompt + DialogMarker + RestoreResult）/ store.ts 扩（ctor systemPrompt + readonly 字段 + save() 写 systemPrompt + load() 老数据兼容（策略 c：ctor 兜底）+ restorePrefix() impl + MarkerNotFoundError）/ index.ts export 同步 / factory createDialogStore 签名同步 / caller cascade 28+ 处（assemble.ts 调 buildMotionSystemPrompt + subagent-executor + contract/manager + 22 tests + helpers）/ 1356 tests PASS / tsc 0 错 / 0 行为改 / 0 disk path 改 / **design+code 联动 cluster 第 3 步闭环**（phase 444 design + phase 450 code α + phase 466 code β）
- 2026-05-03 / phase 414c interfaces L2b audit（A.naming-2 + A.naming-3 closed）：interfaces/l2b.md 删 DialogStoreError 应然幻象 class（实然从未实现 / load/save 失败原样抛 fs error）+ repair 改 static method 形态 align 实然（SessionManager.repair(messages, opts?) + 返 `{ repaired, toolCount }`）
- 2026-05-04 / phase 423 SessionManager → DialogStore rename + 物理迁闭环（main `5e4dc48b`）/ A.naming-1 closed / git mv `src/foundation/session-store/` → `src/foundation/dialog-store/` + class rename SessionManager → DialogStore + factory rename + @module 注解 + SESSION_AUDIT_EVENTS → DIALOG_AUDIT_EVENTS const cascade + 17 caller cascade / SessionData 名保留（phase414c 已采纳为应然 type 名）/ audit event 字符串 value 不动（cross-check 设计 / 跨进程 audit.tsv 字符串契约）/ 同 ShellTool 同型治理第 7 例
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_dialog_store.md vs arch §9 + 表 1/2 + interfaces/l2b.md DialogStore 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D4/D5/D7 + D8 灰度 + D6/D9/D10/D11 无关 + Philosophy P1+P2+P3+P4 / **P1 核心落实者**「Agent 即目录 / 对话即状态」+ Path #1-#7）/ 5 主能力 align arch 表 2 + phase 466 加 systemPrompt regime + restorePrefix marker / 2 dep + caller AgentExecutor align arch 表 1 / 资源 3 entries（dialogDir+archiveDir+.corrupted）align arch 表 1 / 补 phase414c+423 closure timeline entry / phase 444+450+466 spawn cluster design+code 联动 3 阶段完整闭环已记 / L2b.G1 (dialog-store) arch 表 2 缺「marker prefix 恢复」design-gap 已登记 §B（业务决策性 α/β 候选）/ design only / 0 src 改
- 2026-05-09 / **phase 564 silent → audit cluster A（B fork r68）**（main `57daff7b`）/ store.ts:305+309 archive 损坏 silent 跳过 → 加 audit + 2 NEW const：DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED（单 archive 文件 parse 失败 / file=name + reason）+ ARCHIVE_DIR_FAILED（archive dir 列举失败 / reason）/ 注释更新「走最终抛 MarkerNotFoundError」/ Path #1 实证 dispatch claim 真（5/5 dispatch 全 verified）/ silent X cluster feedback N+1 实证累 / cross-cutting 同 phase：l4_contract_system §A.duplicate-audit + l6_cli §A.viewport-task-events-default 同 closed
- 2026-05-11 / **phase 709 DialogStore reframe = LLM call snapshot store**（design only / 0 src 改 / 推后 code phase 710+ 实施）：§1 业务语义重 frame（dialog state 持久化 → LLM call 3 件 snapshot 持久化）/ §3 资源表更新（current 文件含完整 LLM call snapshot）/ §4 文件格式 version 2（加 toolsForLLM field + systemPrompt 改 per-turn latest snapshot 语义）/ §不做扩注「不 own regime hash detection」（推翻 phase 466 instance lifetime 锁定立场 / Motion runtime 自负责 regime hash detect）/ **触发**：用户 2026-05-11 phase 699 askMotionContext 模型反思 / Path #1 discussion 浮出 ask_motion **全然一致性** reuse 业务需求（subagent 端 ask_motion 0 重复 build systemPrompt / 0 重复 derive tools / source 单一 = Motion runtime 实然用的值 / DialogStore per-turn 持久化）/ **影响**：(1) DialogStore.save 签名扩 snapshot 参（systemPrompt + messages + toolsForLLM 三件同源 / atomic write）(2) Motion runtime 每 turn LLM call 后 save 完整 snapshot（不只 messages）(3) ask_motion ctor 简化 4 → 2 dep（仅 llm + motionDialogStore）/ execute 内部 read snapshot / 0 重复 derive (4) SubAgentTask schema 删 askMotionContext 加 motionClawDir（dispatch 端不再 await snapshot / 仅 push motion clawDir）(5) regime hash detection 移 Motion runtime / DialogStore 接受 caller 每 turn 传入 latest systemPrompt / 不锁定 / **「snapshot reuse 必单 source / 0 重复 derive」全然一致性原则首发**（ask_motion 实证 / 推 r+ ≥ 2 实证升格独立 feedback）/ **framing 推翻 N+1**（phase 458 + 461 + 699 + 709 = 4 实证累）
- 2026-05-11 / **phase 713 DialogStore reframe code 落地**（SHA `1edb41d2`）— phase 709 design 后 single commit code α+β：(1) DialogStore ctor 删 systemPrompt 必填参 / 删 readonly systemPrompt 字段 / (2) SessionData v2 +toolsForLLM / save 签名扩 snapshot 参 / load + restorePrefix v1→v2 兼容 read / (3) Motion runtime 9 处 save call 扩 snapshot / regime hash detection 移 Runtime in-memory state / (4) SubAgentTask 删 askMotionContext +motionClawDir / (5) dispatch.ts 简化 / (6) ask-motion.ts ctor 4→2 dep / execute read motionDialogStore.load() / (7) subagent-executor 装配 motionDialogStore inject / **design+code 联动 3 阶段第 2 实证完整闭环**（phase 444+450+453 第 1 + phase 709+713 第 2）/ **全然一致性原则首发实证落地** / **historical design intent 推翻规范首发落地**（推翻 phase 466 instance lifetime 锁定）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#3 DialogStore 不绑目录（base path 由调用方决定）| ✓（dialogDir 装配期传入）|
| KD（应然）audit 事件由 DialogStore 自治命名（caller 风格统一并轨合规反例第 2 个 / 100% 走 const）| ✓ |

> **跨模块 design-gap 登记位置**：本 phase 444 浮出的 4 design-gap（L2.G1 'current.json' 文件名 / L2.G2 clawId 业务关联 / L2.G3 archive rotation 业务策略 / L2.G4 主对话 session lifecycle 业务概念）属跨模块 caller 装配业务归属问题（DialogStore 不 own / caller 应 own）/ 已登记到 [interfaces/l2b.md](../interfaces/l2b.md) DialogStore 节「Design-gap」/ 不在本模块内部 §7。

## 8. 测试覆盖

应然行为应有测试覆盖：

- **load 三路径**：current / archive / empty
- **corruption 隔离**：.corrupted 改名 + 跳到下一份 archive
- **save 原子性**：writeAtomic + 写失败冒泡
- **archive 生命周期**：`<filename>` move + createdAt 重置
- **createdAt 缓存**：进程生命周期 + archive() 后重置
- **repair 多场景**：无 tool_use / 有 tool_use / 含 interruptionMessage / fail-loud 缺省文案
- **validateDialog 字段补全**：version / messages / 时间戳缺失补默认
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言

> A.1 / A.2 修复后 audit 事件断言已补 / ctor `clawId` 默认值修复后需补「ctor 默认值绕过」防御测试。

## phase 695 — r93 E fork V2-P2.1 dialog session 跨 ≥ 4 test file 内联 schema 抽 builder 业务决策 row

### V2-P2.1 跨 ≥ 4 file 内联 session schema（dialog / session / re-entry-storm / restore-prefix-corrupted + session-fixtures helper 单 caller）

- **claim**：dialog-store 6 phase churn（450 + 459 + 466 + 564 + 595 + 684 + 927bf2f5）/ phase 450 `clawId` 改 optional / inline fixture 未跟
- **业务决策**：扩 `tests/helpers/session-fixtures.ts` 共享 builder 收范围
- **选项**：
  - α：扩 session-fixtures 共享 builder + 4 file 迁移
  - β：保现状（dialog schema 稳定 / phase 684 后 churn 缓）
  - γ：仅迁移 high-churn file（dialog + session）/ re-entry-storm + restore-prefix-corrupted 保
- **28 原则核**：
  - M#9 接口最小化 → α
  - 历史 churn → α 防御性
  - session-fixtures 已有单 caller / 扩展边际成本低 → α 简易
- **主会话预期**：α 扩 helper（r94+ 独立 phase）
- **决策状态**：**closed by phase 703**（r94 D-4 / α — EXTEND `tests/helpers/session-fixtures.ts` 加 `makeSession(Partial<SessionData>)` + 4 file inline → builder call / `writeSessionWithIncompleteToolUse` 内部也用 `makeSession` 收口 / 28 原则 derive 同 D-3（ML 三条）+ 已有 helper 单 caller / 扩展边际成本低 / 用户确认 framework 后主会话自决 land）
