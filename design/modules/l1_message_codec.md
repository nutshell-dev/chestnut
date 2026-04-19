# MessageCodec 接口契约

L1 inbox / outbox 消息的唯一编解码点。纯函数：无 I/O，无磁盘，无状态。

归属：L1 原语。依赖：无。被调用：Messaging（唯一消费者）。

## 职责边界

### 做

1. `encodeInbox` / `decodeInbox`：InboxMessage ↔ YAML frontmatter + body
2. `encodeOutbox`：OutboxMessage → markdown（outbox 无 decode 需求——跨 agent 投递后由接收方 inbox decoder 处理）
3. `parseFrontmatter`：通用 YAML frontmatter 解析（供 inbox 与未来扩展复用）
4. 字段校验：`validatePriority` / `validateType`，导出白名单常量 `VALID_PRIORITIES` / `VALID_TYPES`
5. decode 缺字段按显式默认值填充（id / timestamp 就地生成、from fallback 'unknown'、contract_id 兼容旧键 `claw_id`、source 作为 from 的旧键）

### 不做

- 不碰磁盘（所有 I/O 归 Messaging）
- 不管目录结构（inbox/outbox 路径不在本模块概念里）
- 不做消息唯一性保证（id 碰撞检测归 Messaging）
- 不做消息语义理解（type 字段仅做校验，不 dispatch）
- 不做加密 / 签名

## 接口

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

## 失败语义

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

## 不可消除的耦合

- **无跨模块运行时耦合**。
- **类型层共享**：`InboxMessage` / `OutboxMessage` / `Priority` 定义在 `src/types/contract.ts`，MessageCodec 与 Messaging 都引用——类型共享而非运行时调用，不构成模块间依赖。
- **时间维度耦合**：向后兼容映射 `source → from`、`claw_id → contract_id` 是与历史消息格式的耦合；显式登记以便未来清理。

## 配置常量归属

| 常量 | 归属 | 说明 |
|---|---|---|
| `VALID_PRIORITIES` | 模块导出 | 跨模块（Messaging、调用方）引用 |
| `VALID_TYPES` | 模块导出 | 供调用方参考；模块自身不强制此白名单（见下） |

## 与现状的差异（含 Design Principles 违规登记）

### A. 必修违规（修复方向已定，待实施）

**A.1 / A.2 / A.3 统一修复方向**

三处违规本质同源——"未经显式设计决策不得丢弃或静默忽略"。收敛到单一修复路径：

1. `InboxMessage` 加 `extraMeta?: Record<string, string>` 字段
2. `decodeInbox` 扩展行为：
   - 未识别字段 → 原样装入 `extraMeta[key] = value`（A.1）
   - priority 非白名单 → fallback `'normal'` 保证 downstream 稳定；违规原值进 `extraMeta.__original_priority`（A.2）
   - type 统一走强白名单（与 priority 对称）→ 非白名单值 fallback `'message'`；违规原值进 `extraMeta.__original_type`（A.3）
3. `validateType` 签名对齐 `validatePriority`：强制白名单 + fallback 返回值
4. `encodeInbox` 对等支持：接收端如持有 `extraMeta` 可回写（实现 round-trip 不损信息）

依据原则分工：
- `extraMeta` 承接所有"白名单外的值"，保证 MessageCodec 对外无信息损耗，事后 audit 可重建原消息
- 对外返回值仍落在白名单内，下游消费者类型收敛、无需兼容非法值
- 两个校验函数严格度对齐，符合"命名一致性是接口契约的一部分"

**实施检查清单**：
1. 类型层 `InboxMessage.extraMeta?: Record<string, string>` 加字段（`src/types/contract.ts`）
2. `decodeInbox` 补未识别 key 装入逻辑 + priority / type 违规值装入 `__original_*`
3. `validateType` 改为强白名单 + fallback
4. `encodeInbox` 写出 `extraMeta`（如存在）；extraFields 与 extraMeta 冲突策略需单独登记
5. 测试补 round-trip 断言：未识别字段 / 非法 priority / 非法 type 解码后能在 extraMeta 中找回原值

### B. 偏差登记（当前合理，仅记录）

- `encodeInbox` 的 `yamlQuote` 对数字 / 布尔字面量裸放不加引号。若字符串值字面恰好是 `"true"` / `"false"` / 纯数字，未来换真 YAML 解析器库时会被误判为布尔 / 数字。当前 `parseFrontmatter` 全当 string 读，无实际影响。
- 当前只有一种 InboxMessage 格式；契约以 interface 描述不绑定字段细节，未来新增可选字段不破坏兼容。

## 测试覆盖（验证行为契约）

- `tests/foundation/frontmatter.test.ts`（13 `it`）：`parseFrontmatter` 基本解析；缺前导 `---\n` / 缺关闭 `\n---\n` 抛错；值含 `:` 按首个 `:` 分割；`encodeInbox`/`decodeInbox` round-trip；`extraFields` 键名冲突 warn 且跳过；priority fallback；type 通过 typeof 放行。
- `tests/utils/inbox-writer.test.ts` / `tests/foundation/outbox-writer.test.ts`：上层 writer 侧对 `encodeInbox` / `encodeOutbox` 的集成使用路径。

**覆盖缺口**（对应 A.1/A.2/A.3 修复方向）：
- 未识别字段进 `extraMeta` 的 round-trip 断言（A.1 修复后必补）
- 非白名单 priority 原值进 `extraMeta.__original_priority`（A.2 修复后必补）
- 非白名单 type 原值进 `extraMeta.__original_type`（A.3 修复后必补）
- `validateType` 强白名单后的 fallback 行为测试（A.3 修复后必补）
