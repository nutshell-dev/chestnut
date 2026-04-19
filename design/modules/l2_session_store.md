# SessionStore 接口契约

L2 messages 数组持久化读写。服务于"中断可恢复"——任意时刻崩溃后，重启可从磁盘恢复完整对话上下文继续运行。

归属：L2 基础设施。依赖：FileSystem（L1）、AuditLog（L2，必需——Phase 148 已从可选升级）。被调用：Dialog（装配 + 每轮持久化）、Runtime（启动期 load + 崩溃恢复）、AgentExecutor（每次 LLM 调用后 save）。

## 职责边界

### 做

1. `current.json` 读写：`load` 读当前会话；`save` 原子写入（`writeAtomic`）
2. Archive 管理：`archive()` 把 `current.json` move 到 `archive/<ts>_<uuid8>.json`
3. 冷启动恢复：`current.json` 缺失时自动扫描 `archive/`，按文件名时间戳倒序取最新可解析的作为返回
4. Corruption 处理：`current.json` 解析失败 → 审计 + 改名 `.corrupted`（下次 load 不重踩）；archive 里某份损坏 → 审计后跳到下一份
5. `createdAt` 缓存：首次 save 生成，`archive()` 后重置（新会话起点）
6. 静态 `repair(messages, opts?)`：修复含未应答 `tool_use` 的 assistant 末消息，注入 synthetic `tool_result` 让 LLM 可继续；`interruptionMessage` 缺省显式写 "Cause unknown (no context provided to repair)"——fail-loud 提醒调用方传中断上下文

### 不做

- 不做对话语义（消息合并 / 裁剪 / 截断 / 压缩归 Dialog 或更上层）
- 不做并发写协调（依赖调用方保证单 session 单 writer；`writeAtomic` 只保证单次写原子）
- 不做归档清理（`archive/` 无保留策略，由运维 / 未来 janitor）
- 不做跨会话合并（每个 claw 单独 `dialogDir`）
- 不做加密 / 签名

## 接口

```ts
interface SessionData {
  version: number;              // 当前恒为 1
  clawId: string;
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
  messages: Message[];
}

interface LoadResult {
  session: SessionData;
  source: 'current' | 'archive' | 'empty';
}

class SessionManager {
  constructor(
    fs: FileSystem,
    dialogDir: string,
    audit: Audit,                // Phase 148 已修复：从可选升级为必传
    clawId?: string,             // 缺省 randomUUID()
  );

  load(): Promise<LoadResult>;
  save(messages: Message[]): Promise<void>;
  archive(): Promise<void>;

  static repair(
    messages: Message[],
    opts?: { interruptionMessage?: string },
  ): { repaired: Message[]; toolCount: number };
}
```

关键约定：
- **`load()` 不抛**：`current.json` 读失败走 corruption 流程，archive 失败则返回空 session。调用方永远能得到一个可用的 `LoadResult`
- **`source` 是重要信号**：`'archive'` / `'empty'` 意味着"当前会话丢失"，调用方可据此决策（如注入用户提示"上次会话从归档恢复"）
- **`validateSession` 宽容**：字段缺失走默认值（`version=1`、`messages=[]`、当前时间）——向后兼容旧版 session 文件
- **`repair` 静态方法**：不依赖实例状态，是纯函数工具——反映"修复逻辑与 session IO 解耦"的设计意图

### 工厂（装配期入口）

`src/foundation/session-store/index.ts` 导出 `createSessionManager`，是 Assembly / Runtime 装配期的推荐构造入口：

```ts
export function createSessionManager(
  fs: FileSystem,
  dialogDir: string,
  audit: Audit,
  clawId: string,
): SessionManager;
```

**行为承诺**：构造代理；与 `new SessionManager(fs, dialogDir, audit, clawId)` 完全等价——
- 不缓存、不单例：每次调用返回新实例
- 不注入默认值（默认归 ctor 本身）
- 不做参数校验 / 不触发副作用

**强制传 `clawId`**：工厂签名要求 `clawId: string`（非可选），不走 `SessionManager` ctor 的 `= randomUUID()` 默认值。调用方必须显式传入，以让"session 归属"成为编译期约束。

装配方应通过工厂而非 `new` 构造，以便未来依赖组合扩展时单点修改。

## 失败语义

| 失败源 | SessionStore 行为 |
|---|---|
| `current.json` 不存在（`ENOENT` / `FS_NOT_FOUND`） | 冷启动正常路径，进入 archive 恢复 |
| `current.json` 存在但解析失败 | `audit.write(AUDIT_EVENTS.SESSION_CORRUPTED, file=current.json, reason=...)`；`move` 到 `.corrupted`；继续走 archive 恢复 |
| `.corrupted` 改名失败 | `audit.write(AUDIT_EVENTS.SESSION_CORRUPTED_ISOLATE_FAILED, ...)`，继续 archive 恢复（Phase 148 已修复，原 `console.warn`）|
| archive 中某份解析失败 | `audit.write(AUDIT_EVENTS.SESSION_CORRUPTED, file=<name>, reason=...)`；继续下一份（Phase 148 已修复，原 `console.error`）|
| `archive/` 目录读失败 | `audit.write(AUDIT_EVENTS.SESSION_ARCHIVE_READ_FAILED, reason=...)`；返回空 session（Phase 148 已修复，原 `console.error`）|
| archive 恢复成功 | `audit.write(AUDIT_EVENTS.SESSION_RECOVERED, from=<name>)`；source='archive' |
| `save` 过程中产生可审计失败（archive 旁路清理等）| `audit.write(AUDIT_EVENTS.SESSION_SAVE_FAILED / SESSION_ARCHIVE_FAILED, ...)` |
| `save` 写失败 | `writeAtomic` 抛错向上冒泡（不吞），调用方决策 |
| `archive` 时 `current.json` 不存在 | `move` 抛错向上冒泡 |

## 不可消除的耦合

- **SessionStore → FileSystem（L1）**：显式依赖，构造注入
- **SessionStore → AuditLog（L2，Phase 148 已改必传）**：通过构造 `audit: Audit` 注入；corruption / recovery / save / archive 事件全部落审计。测试用 `InMemoryAudit`（实现 `Audit` 接口、事件存数组供断言）覆盖
- **`repair` 的 `interruptionMessage` 契约**：调用方不传 → synthetic tool_result 写 "Cause unknown (no context provided to repair)"——fail-loud 设计让调用方看到缺省文案就知道该补中断上下文。不是"修复系统瞎编原因"，而是"显式暴露调用方疏漏"
- **`clawId` 默认 `randomUUID()`**：调用方不传时每次 new 会得到不同 ID——契约登记让调用方必须显式传（同 claw 跨进程必须传入 stable ID，否则 session 归属错乱）

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `dialogDir` | 调用方装配期传入 | 本模块不决定路径策略（通常 `<clawDir>/dialog/`） |
| `current.json` 文件名 | 内部硬编码 | 调用方无法定制 |
| `archive/` 子目录名 | 内部硬编码 | 调用方无法定制 |
| archive 文件名 `<ts>_<uuid8>.json` | 内部硬编码 | 时间戳 + 8 字符 UUID 避免碰撞 |
| `.corrupted` 后缀 | 内部硬编码 | corruption 隔离用 |
| `version: 1` | 内部硬编码 | schema 版本；未来升级需升版本 + 迁移逻辑 |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规

**A.1 `load` 路径的若干失败吞进 `console.warn` / `console.error`（Phase 148 已修复）**

原违反原则：
- "运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略"
- 编码规范"不可预期失败暴露而非吞没"

原吞没路径 → Phase 148 修复事件：
- `.corrupted` 改名失败 `console.warn` → `SESSION_CORRUPTED_ISOLATE_FAILED`
- `archive/` 目录读失败 `console.error` → `SESSION_ARCHIVE_READ_FAILED`
- archive 单份解析失败 `console.error` → 统一到 `SESSION_CORRUPTED` 事件
- save/archive 旁路失败 → `SESSION_SAVE_FAILED` / `SESSION_ARCHIVE_FAILED`

`load()` 契约保持不变（"永远返回可用 LoadResult，不抛"）；降级信号通过 audit 事件提升为一等事件，而非藏进 console。

附注：`SESSION_LOAD_FAILED` 常量登记为"保留未用"（Step 3 § 3.7 决策：当前 load 路径全部可被现有 SESSION_CORRUPTED/ARCHIVE_READ_FAILED 覆盖，SESSION_LOAD_FAILED 作为未来 load 全链路统一失败事件的占位）。

**A.2 `audit?: Audit` 可选性让审计信息在装配疏漏时悄悄消失（Phase 148 已修复）**

原违反原则："事后仅凭日志和记录能完整重建决策链路"——corruption / recovery 事件是重要决策点，若调用方忘记注入 audit，这些事件静悄悄丢失。

Phase 148 修复：构造器 `audit: Audit` 必传，去除可选性。**不提供 NoopAudit 兜底**——"不审计"没有合理的生产/测试场景：测试用 `InMemoryAudit`（实现 `Audit` 接口、事件存数组供断言），而非 no-op。审计事件是行为契约的一部分，必须可断言可覆盖。

### B. 偏差登记（当前合理）

- **`current.json` 读失败后立刻改名 `.corrupted`**：设计动机是"下次 load 不重复踩同一个损坏文件"，属"预期失败显式处理"。改名失败会造成下次仍踩——边界场景概率低，不阻塞主路径；已在 A.1 覆盖
- **`archive/` 无保留策略**：不限数量、不清理、不压缩。MVP 暂不驱动；登记待未来 log janitor
- **`validateSession` 宽容补默认值**：旧版 session 文件字段缺失自动补全（`version=1`、`messages=[]`、now 时间戳）。向后兼容设计，但**字段缺失这件事本身不审计**——未来加 schema 迁移时可补 `session_schema_upgraded` 事件
- **`createdAt` 缓存在内存**：进程重启重新从文件读取；`archive()` 后重置表示"新会话起点"。合理
- **并发写依赖调用方单 writer**：`writeAtomic` 只保证单次写原子，跨 save 间不加锁。被"同 claw 单 daemon 单 Runtime"约定兜住（`ProcessManager` 保障）
- **`repair` 是静态方法**：与实例状态解耦，纯函数——设计意图好；但放在 `SessionManager` 类上而非独立 `repair.ts` 模块，属代码组织偏差，不影响行为
- **类名 `SessionManager` 与模块名 `SessionStore` 不一致**：`modules.md` 叫 SessionStore，`index.ts` 导出的类叫 `SessionManager`，两个名字指同一东西。违反编码规范"同一概念用同一名字"。改名不紧急（影响面广、无行为后果），登记为 B 类偏差；未来统一时建议类名 → `SessionStore`
- **`modules.md` 索引层漂移（两处）**：
  - L89 写"资源：`messages.json`"——代码实际 `current.json` + `archive/<ts>_<uuid8>.json`
  - L91 写"耦合：无"——代码实际有 `audit?: Audit` 可选耦合
  - Step 13 一致性自检时统一修正索引文本

### C. 原则对照补充

- **"持久化一切信息到磁盘"**：messages 数组通过 save/archive 完整落盘 ✓
- **"中断可恢复"**：SessionStore 是此原则的核心落实者 ✓；`repair` 方法专门处理"中断时 tool_use 悬空"这种恢复阻塞场景
- **"事后可审计"**：corruption / recovery / save / archive 全部走 `audit.write` ✓（Phase 148 已从可选升级必传，A.2 已闭环）
- **"模块为自己的业务语义负责"**：SessionStore 只负责 messages 数组的 IO 生命周期，不理解消息语义 ✓
- **"每种资源只归属唯一模块"**：`current.json` + `archive/` 归 SessionStore ✓
- **"不可消除耦合显式表达"**：FS 依赖、AuditLog 可选耦合、`clawId` stable 约定均登记 ✓

## 测试覆盖现状

`tests/core/session.test.ts`（32 个 `it`）覆盖契约主要行为：load 三路径（current / archive / empty）、corruption 隔离（改名 + 跳到下一份 archive）、save 原子性、archive 生命周期、createdAt 缓存与重置、`repair` 多场景（无 tool_use / 有 tool_use / 含 interruptionMessage / fail-loud 缺省文案）、validateSession 字段补全。

**注**：A.1 / A.2 修复 phase 需补"结构化降级信号"与"audit 未注入时的启动提示"的断言。
