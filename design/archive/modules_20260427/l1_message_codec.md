# MessageCodec 接口契约

> **应然废止标记**（2026-04-26，r31 / 模块消解架构决策）：
>
> - **应然**：此模块**已废止** / inbox/outbox 编解码内化进 Messaging L2（作为模块内部 helper / 不暴露独立模块）/ frontmatter 解析沉为项目 utility（`src/utils/frontmatter.ts` 类位置 / 不入 modules.md / 不算模块）/ MessageCodec L1 应然不再独立存在
> - **实然**：模块文件 + `src/foundation/message-codec/` 实现仍存在 / 消费者（Messaging + SkillSystem + memory_search builtin）仍 import 本模块 / 待 **Stage 2** 物理消解（编解码搬迁进 Messaging 内部 / frontmatter 搬迁至 utils / 顶级模块目录删除）
> - **保留策略**：本契约文件全文用 ~~strikethrough~~ 标 deprecated（保留内容供溯源 / 不删文件 / Stage 2 物理删除时本文件一并删除）
> - **治理登记**：详 §7.Phase phase[TBD]-1（模块整体应然废止 / Stage 2 物理消解 phase TBD）；Messaging 侧 drift 登记详 [l2_messaging.md §7.Phase](l2_messaging.md)
>
> 本 split 之下，§职责边界 / §接口 / §失败语义 / §配置常量 等节描述实然形态保留供溯源；应然层这些节均废止。

~~L1 inbox / outbox 消息的唯一编解码点。纯函数：无 I/O，无磁盘，无状态。~~（应然废止 / 实然仍在）

~~归属：L1 原语。装配归属：按需（随 Messaging 装配 / 编解码原语）。依赖：无。被调用：Messaging（唯一消费者）。定义的协议：无（纯函数模块）。~~（应然废止 / 整模块消解）

> **注**：以下 "应然 / 实然" 节是本次模块消解之前的旧应然/实然 split（关注点为"对外能力清单跟 modules.md align"）；本次模块消解之后这两节本身亦废止 / 仅保留供溯源。

**~~应然~~**（2026-04-26 修订 / 跟 modules.md §4 align）（**已被本次模块消解 supersede / 应然废止**）：
- 装配归属「按需」明记本节首段
- 对外能力清单跟 modules.md §4 align：inbox 编解码 / outbox 编码 / 通用 frontmatter 解析 / 字段白名单校验（详 §职责边界）
- 无定义协议字段（与 modules.md §4 无该字段一致）

**实然**：表述已同步；§7 不动。

## ~~职责边界~~（应然废止 / 实然行为仍存 / 保留供溯源）

### ~~做~~

1. `encodeInbox` / `decodeInbox`：InboxMessage ↔ YAML frontmatter + body
2. `encodeOutbox`：OutboxMessage → markdown（outbox 无 decode 需求——跨 agent 投递后由接收方 inbox decoder 处理）
3. `parseFrontmatter`：通用 YAML frontmatter 解析（供 inbox 与未来扩展复用）
4. 字段校验：`validatePriority` / `validateType`，导出白名单常量 `VALID_PRIORITIES` / `VALID_TYPES`
5. decode 缺字段按显式默认值填充（id / timestamp 就地生成、from fallback 'unknown'、contract_id 兼容旧键 `claw_id`、source 作为 from 的旧键）

### ~~不做~~

- 不碰磁盘（所有 I/O 归 Messaging）
- 不管目录结构（inbox/outbox 路径不在本模块概念里）
- 不做消息唯一性保证（id 碰撞检测归 Messaging）
- 不做消息语义理解（type 字段仅做校验，不 dispatch）
- 不做加密 / 签名

## ~~接口~~（应然废止 / 实然 API 仍可用 / Stage 2 物理消解后此 API 表面消失）

```ts
// 通用 frontmatter 解析
function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
};

// inbox 编解码
function encodeInbox(msg: InboxMessage, extraFields?: Record<string, string>): string;
function decodeInbox(raw: string): InboxMessage;

// outbox 编码（无 decode）
function encodeOutbox(msg: OutboxMessage): string;

// 字段校验
function validatePriority(value: unknown): Priority;           // fallback 'normal'
function validateType(value: unknown): InboxMessage['type'];   // fallback 'message'；当前仅 typeof 校验，不强制白名单

const VALID_PRIORITIES: Priority[];
const VALID_TYPES: string[];
```

关键约定：
- `parseFrontmatter` 的安全假设：body 含 `\n---\n` 不会误匹配，因为 `encodeInbox` 用 `yamlQuote` 保证 frontmatter 值单行（无裸换行）；首个 `\n---\n` 始终是关闭定界符
- `encodeInbox` 的 `extraFields` 键若与标准字段（id / type / from / to / priority / timestamp）冲突：`console.warn` 暴露冲突并跳过该字段，不抛错、不覆盖（保守路径）
- `decodeInbox` 缺字段一律填默认，不抛错；只有"缺失 YAML frontmatter"或"frontmatter 未闭合"才抛错
- `parseFrontmatter` 对值中的 `:` 按第一个 `:` 分割 key/value，余下部分全入 value

## ~~失败语义~~（应然废止 / 实然行为仍存）

| 失败源 | MessageCodec 行为 |
|---|---|
| `decodeInbox` 无 `---\n` 前导 | 抛 `Error('Invalid inbox message: missing YAML frontmatter')` |
| `decodeInbox` 有前导但缺关闭 `\n---\n` | 抛 `Error('Malformed frontmatter: missing closing ---')` |
| `decodeInbox` meta 缺必填字段 | 按显式默认填充（id=uuid / timestamp=now / from='unknown' / to='' / priority='normal' / type='message'），不抛错 |
| `decodeInbox` meta 有未识别键 | **当前违反"事后可审计"原则**：未识别字段被丢弃，事后无法重建原消息（见"与现状的差异" A.1） |
| `decodeInbox` priority 值非白名单 | 当前 fallback `'normal'`，原值丢失。**违反"不得静默忽略"**（见 A.2） |
| `decodeInbox` type 值非白名单 | 当前 `typeof === 'string'` 即放行，不做白名单校验；与 priority 校验严格度不对称（见 A.3） |
| `encodeInbox` 的 `extraFields` 键名冲突 | `console.warn` 暴露冲突并跳过该字段。**符合"不得静默忽略"**——warn 是显式信息暴露 |
| `parseFrontmatter` 值含 `:` | 按第一个 `:` 分割，余下入 value，不抛错 |

## ~~不可消除的耦合~~（应然废止）

- **无跨模块运行时耦合**。
- **类型层共享**：`InboxMessage` / `OutboxMessage` / `Priority` 定义在 `src/types/contract.ts`，MessageCodec 与 Messaging 都引用——类型共享而非运行时调用，不构成模块间依赖。
- **时间维度耦合**：向后兼容映射 `source → from`、`claw_id → contract_id` 是与历史消息格式的耦合；显式登记以便未来清理。

## ~~配置常量归属~~（应然废止 / 常量随编解码内化进 Messaging）

| 常量 | 归属 | 说明 |
|---|---|---|
| `VALID_PRIORITIES` | 模块导出 | 跨模块（Messaging、调用方）引用 |
| `VALID_TYPES` | 模块导出 | 供调用方参考；模块自身不强制此白名单（见下） |

## ~~与现状的差异（含 Design Principles 违规登记）~~（应然废止 / A.1-A.3 历史已清零保留供溯源）

### A. 必修违规（**phase257 全部消化**）

**A.1 / A.2 / A.3 — 已消化（phase257，`ef57cbd`）**

三处违规已统一修复：

- **A.1**：`decodeInbox` 未识别 meta key 装入 `extraMeta[key]`（`inbox.ts:86-90`）
- **A.2**：priority 非白名单 → fallback `'normal'`；原值进 `extraMeta.__original_priority`（`inbox.ts:93-97`）
- **A.3**：`validateType` 改为强白名单 + fallback `'message'`；原值进 `extraMeta.__original_type`（`validation.ts:22-26`，`inbox.ts:99-104`）
- `InboxMessage.extraMeta?: Record<string, string>` 已加字段（`contract.ts`）
- `encodeInbox` 写出非 `__` 前缀 extraMeta 字段（`inbox.ts:52-63`），extraFields 优先

**已知副作用（B.p257-1）**：watchdog 类型消息 `type: 'watchdog_claw_inactivity'` 解码后 `type` 字段变为 `'message'`，原值进 `extraMeta.__original_type`；`runtime.ts` audit 日志 `type=` 字段退化，**已消化（phase270 / r20 分支 E / `c28d185`）**：`src/core/runtime.ts` L395+L405 改读 `message.extraMeta?.__original_type ?? message.type`，audit 日志恢复原始 type。

### B. 偏差登记（当前合理，仅记录）

- `encodeInbox` 的 `yamlQuote` 对数字 / 布尔字面量裸放不加引号。若字符串值字面恰好是 `"true"` / `"false"` / 纯数字，未来换真 YAML 解析器库时会被误判为布尔 / 数字。当前 `parseFrontmatter` 全当 string 读，无实际影响。
- 当前只有一种 InboxMessage 格式；契约以 interface 描述不绑定字段细节，未来新增可选字段不破坏兼容。

## ~~测试覆盖（验证行为契约）~~（应然废止 / Stage 2 物理消解时测试随编解码搬迁进 Messaging 测试套件）

- `tests/foundation/frontmatter.test.ts`（13 + 4 = 17 `it`）：`parseFrontmatter` 基本解析；缺前导 `---\n` / 缺关闭 `\n---\n` 抛错；值含 `:` 按首个 `:` 分割；`encodeInbox`/`decodeInbox` round-trip；`extraFields` 键名冲突 warn 且跳过；priority fallback；type 强白名单降级；**A.1/A.2/A.3 extraMeta round-trip 4 it（phase257 新增）**。
- `tests/foundation/validation.test.ts`：`validateType` watchdog / 未知字符串降级为 `'message'`（phase257 更新）
- `tests/utils/inbox-writer.test.ts` / `tests/foundation/outbox-writer.test.ts`：上层 writer 侧对 `encodeInbox` / `encodeOutbox` 的集成使用路径。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A ↔ §1 A.1/A.2/A.3 映射

**§7.A 全清零（phase257，`ef57cbd`）**

- A.1 / A.2 / A.3 全部消化（见 §与现状的差异 A 节）
- `inbox.ts` `console.warn` extraFields 冲突 → **合规**（契约明示"warn 显式信息暴露"）
- 纯函数模块无 audit 事件（符合 §7.A 判据：纯函数无观测性要求）

### 7.B 补登记

既有 §B 登记 2 条（yamlQuote 类型猜测 / 单一 InboxMessage 格式扩展）。phase187 补 3 条：

- **B.p187-1** — `parseFrontmatter` body `.trim()` 可能丢失尾部有意空白（`frontmatter.ts:38`）
- **B.p187-2** — `parseFrontmatter` quote 不对称剥离（`frontmatter.ts:33` 不校验配对）
- **B.p187-3** — `decodeInbox` 6 处 backward-compat 默认值静默（见 §1 A.2 修复方向必带 `inbox_decode_field_missing` audit）

### 7.C 原则对照（32 条）

全 32 条覆盖。

#### Module Logic Principles（11 条）
- M1-M9 合规；M10/M11 未触发

#### Design Principles（11 条）
- **D1a/D1b/D1d/D2 合规**（phase257 A.1-A.3 消化，不再灰度）
- **D1c / D3-D11 合规或无关**

#### Philosophy（3 条）
- P1 合规（序列化层）/ P2 合规 / P3 合规

#### Path Principles（6 条）
- #1 Read 源码 183 行 + 测试 13 it / #2 §1 A.1-A.3 + phase187 B.p187-1~3 / #3 单一意图 / #4 design 本地 / #5 Step 3 / #6 未触发

### 7.Phase 执行纪律

#### phase187 纪律 — L1 MessageCodec backfill（2026-04-21，design 本地 only）

- scope：既有 §1 A.1-A.3 登记；phase187 补 §7.C + §7.Phase + 3 细粒度 B 偏差
- 对比定位：与 FileSystem / ProcessExec 同"纯净 L1"；§7.A 不是软吞而是"修复方向已定待实施"
- 方法论：保留既有编号不解构（Path #3 最小变更），新增 B.p187-* 作为补充

#### phase257 纪律 — L1 MessageCodec §7.A A.1/A.2/A.3 清零（2026-04-24，`ef57cbd`，r17 分支 E）

- scope：A.1 未识别 key 装 extraMeta / A.2 priority 违规原值 / A.3 validateType 强白名单 3 条全消化
- 修改文件：`contract.ts`（+extraMeta 字段）/ `validation.ts`（validateType 强白名单）/ `inbox.ts`（decodeInbox/encodeInbox）/ `frontmatter.test.ts`（+4 it）/ `validation.test.ts`（watchdog 断言更新）
- 副作用：B.p257-1 — watchdog 类型 `type` 字段退化 `message`，audit 日志 `type=` 受影响，**phase270 已消化**（runtime.ts L395+L405 联动）
- 方法论：A.1/A.2/A.3 同根合并 phase（单一 extraMeta 修复路径）；__original_* 不回写 encode（内部追踪字段不污染 frontmatter）

#### phase270 纪律 — B.p257-1 runtime.ts watchdog audit 联动（2026-04-24，`c28d185`，r20 分支 E）

- scope：`src/core/runtime.ts` L395+L405 两行 + 1 it 测试（inbox_inject watchdog 消息原始 type 断言）
- 根因：phase257 validateType 强白名单 → watchdog_* type 降级 'message' → audit 日志 type= 字段失真
- 修复：读 `message.extraMeta?.__original_type ?? message.type`
- 跨轮遗留消化：r17 E phase257 推下 B.p257-1 → r20 E phase270 兑现

#### phase[TBD] 纪律 — MessageCodec L1 模块整体应然废止（2026-04-26，r31，design 本地 only）

- **架构决策**：MessageCodec L1 模块应然消解 / 拆两块
  1. **inbox/outbox 编解码**（`encodeInbox` / `decodeInbox` / `encodeOutbox` / `validatePriority` / `validateType` / `VALID_PRIORITIES` / `VALID_TYPES`）→ 内化进 Messaging L2 作为 internal helper（不暴露独立模块）
  2. **`parseFrontmatter`** → 沉为项目 utility（`src/utils/frontmatter.ts` 类位置 / 不入 modules.md / 不算模块）
- **判据**：
  - 真消费者只 1 个模块（Messaging）使用 inbox/outbox codec → M1 独立可变职责反向测试 = Messaging 与 codec 不能独立可变（codec 改 → Messaging 必跟改）→ 应合并
  - frontmatter 解析为通用 utility（SkillSystem / memory_search builtin 也用）→ 不构成 agent 业务概念 → 不算模块 / 沉为 utility
- **应然形态**：
  - L1 模块清单去 MessageCodec → L1 = FileSystem / FileWatcher / ProcessExec / LLMService / Transport（5 模块 / 与 modules.md 当前应然 align）
  - Messaging 应然依赖 = FileSystem + AuditLog（不再含 MessageCodec / 详 [l2_messaging.md](l2_messaging.md) 顶部 split）
  - `parseFrontmatter` 改 import 自 `src/utils/frontmatter.ts`（SkillSystem / memory_search builtin 同步改）
- **实然形态**：
  - 本契约文件 + `src/foundation/message-codec/` 实现 + 消费者 import 路径全部不变
  - 待 **Stage 2 物理消解**：(1) `message-codec/{inbox,outbox,validation}.ts` → `messaging/codec/`；(2) `message-codec/frontmatter.ts` → `utils/frontmatter.ts`；(3) 所有消费者 import 改；(4) `message-codec/` 顶级模块目录删 + 本契约文件删 + modules.md §4 MessageCodec entry 删
- **本 phase 性质**：纯 design / 本地 only / 零代码改动 / 仅 Stage 1 应然标记（应然废止 + 全文 strikethrough）
- **Stage 2 phase**：独立代码 phase 实施物理消解（TBD）

