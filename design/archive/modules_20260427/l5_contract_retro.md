# ContractRetro 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §25 align）：实现「各个 claw 的特长能力可以轻易复制过来」的核心机制。契约完成后沉淀能力模板，供 dispatch 工具查询装配。

**实然**：新模块 / 尚无实然代码。§7 / §8 留下一阶段从代码实现后回填。

归属：L5 外壳与能力。
- **应然依赖**：TaskSystem（L4，派 retro subagent）、ContractSystem（L4，订阅 contract_completed 事件）、FileSystem（L1）、AuditLog（L1）
- **实然依赖**：尚无代码（待实现）

## 1. 职责

### 归属层

L5 外壳与能力。ContractRetro 是「契约完成后能力沉淀」的业务语义收口模块，与 MemorySystem 同层、同属「经验整合」类业务（MemorySystem 整合会话经验 / ContractRetro 整合契约能力）。

### 做

1. **contract_completed 事件订阅**：装配期由 Assembly 把 ContractRetro 注册到 ContractSystem 的 `contract_completed` 事件订阅链；契约完成时回调触发 retro 流程
2. **retro 触发**：事件驱动 / 单契约一次 / 由事件回调进入；触发后构造 retro prompt 并经 TaskSystem 派 retro subagent
3. **retro prompt 构造**：基于 contract_completed 事件载荷（契约 id / 参与 claw / 契约语义 / 完成轨迹等）拼装 prompt，引导 retro subagent 提炼"此 claw 在此契约中展现的特长能力"
4. **能力提炼**：经 TaskSystem 派 retro subagent 执行 LLM 调用 / 解析 subagent 输出中的能力模板块（如 `[SKILL_TEMPLATE]` 或等价结构化标记）
5. **技能模板沉淀**：解析出的能力模板写入自有的能力模板库目录（per ContractRetro 实例）/ 含模板元数据（来源 contract / 来源 claw / 提炼时间 / 模板内容）
6. **模板查询入口**：对外暴露能力模板查询接口供 dispatch 工具调用（M3 资源唯一对外入口 / dispatch 不直读模板库目录）
7. **状态追踪**：已 retro 过的 contractId 列表（避免同契约重复 retro）

### 不做

- 不做 contract 生命周期管理（contract 创建 / 完成 / 状态归 ContractSystem）
- 不做 contract_completed 事件的发布（ContractRetro 是 subscriber / ContractSystem 是 publisher）
- 不做 subagent 调度（直接 new SubAgent 不行 / 必须经 TaskSystem 派 retro subagent）
- 不做 LLM 服务生命周期管理（归 Assembly 注入；ContractRetro 不直接构造 LLMService）
- 不做技能装配（dispatch 工具读模板库后装配给目标 claw / ContractRetro 只负责沉淀 + 查询，不负责装配执行）
- 不做能力模板的 schema 强约束（提炼出的模板内容由 retro subagent 决定 / ContractRetro 只负责存储与索引）
- 不做跨 ContractRetro 实例的模板合并（每个 ContractRetro 实例自有模板库 / 不预设全局合并语义）

## 2. 对外接口

### 类型签名

```ts
// 工厂（装配期唯一入口）
export function createContractRetro(opts: ContractRetroOptions): ContractRetro;

export interface ContractRetroOptions {
  // 资源根
  templateLibraryDir: string;     // 自有能力模板库目录（per 实例）
  stateDir: string;               // retro 状态文件目录（per 实例）

  // 依赖注入
  fs: FileSystem;
  audit: Audit;
  taskSystem: TaskSystem;         // 派 retro subagent 的唯一入口
  contractSystem: ContractSystem; // 订阅 contract_completed 事件

  // 配置
  retroPromptTemplate?: string;   // 可覆盖默认 retro prompt 模板
  retroSubagentTimeoutMs?: number;
}

export interface ContractRetro {
  // 装配期接入事件订阅链（Assembly 显式调用 / 不在工厂内部静默订阅）
  subscribeToContractSystem(): void;

  // 模板查询入口（供 dispatch 工具调用 / M3 唯一对外入口）
  listTemplates(filter?: SkillTemplateFilter): Promise<SkillTemplate[]>;
  getTemplate(templateId: string): Promise<SkillTemplate | null>;

  // 测试 / 手动触发用入口（生产路径走事件驱动）
  runRetroForContract(contractId: string): Promise<void>;
}

export interface SkillTemplate {
  templateId: string;
  sourceContractId: string;
  sourceClawId: string;
  extractedAt: string;     // ISO timestamp
  content: unknown;        // 能力模板内容 / schema 由 retro subagent 决定
  metadata?: Record<string, unknown>;
}

export interface SkillTemplateFilter {
  sourceClawId?: string;
  sourceContractId?: string;
  // 进一步 filter 字段按需扩展
}
```

### 关键约定

- **工厂唯一入口**：`createContractRetro` 是 ContractRetro 对外唯一构造方式 / 与 MemorySystem / TaskSystem / SkillSystem 工厂模式一致
- **事件订阅显式装配**：`subscribeToContractSystem()` 由 Assembly 装配期显式调用 / 工厂内部不静默订阅（保证装配可观察 + 可在测试中跳过订阅）
- **派 retro subagent 必经 TaskSystem**：ContractRetro 不持有 SubAgent 类引用 / 不 `new SubAgent(...)`；retro 触发后经 `taskSystem` 提交 retro 任务
- **模板库目录归 ContractRetro 实例自有**：不与 SkillSystem 共享资源 / 不被装配方直接 fs 访问（M3 资源唯一对外入口）
- **dispatch 工具经 ContractRetro 入口读模板**：dispatch 工具拿到的是 `ContractRetro` 实例引用 / 调 `listTemplates` / `getTemplate`，不直读 `templateLibraryDir`
- **去重**：同 contractId 已 retro 过则跳过（state 文件记录已处理 contractId 列表）
- **错误隔离**：单契约 retro 失败不影响后续契约（事件回调 try/catch + audit）/ retro subagent 超时为软失败（audit 记录后返回）
- **状态文件容错**：state 文件读取失败时静默回退到空初始状态；写入失败时由调用方 handler 捕获并 audit

## 3. 事件（audit）

ContractRetro 自身产生的 audit event 类别（事件名 string 实然定义阶段确定 / 此处只列类别）：

| 类别 | 语义 | 典型载荷字段 |
|---|---|---|
| retro 调度 | retro 流程进入各阶段 | step（subscribed / triggered / prompt_built / subagent_dispatched / extraction_started / template_persisted / finished / skip_duplicate）, contractId, sourceClawId |
| retro 软失败 | 单契约 retro 软失败 | reason（subagent_timeout / no_template_output / parse_failed）, contractId |
| retro 错误 | 单契约 retro 硬错误 | step, contractId, reason |
| 模板持久化 | 模板写入 / 查询 | templateId, sourceContractId, op（write / read） |

不在本清单（由 Assembly / ContractSystem 发出）：契约完成事件本身（归 ContractSystem）/ Assembly 装配 ContractRetro 失败事件（归 Assembly）。

## 4. 依赖

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。本模块代码 phase 落地时 ContractRetro 工厂模式 + opts 注入（fs / audit / taskSystem / contractSystem）= port 范本 / 不直 import 上层模块内部。

### 同仓

| L 层 | 模块 | 契约 / 位置 | 使用方式 |
|---|---|---|---|
| L1 | FileSystem | `design/modules/l1_filesystem.md` | `opts.fs` 用于模板库目录 / state 文件 IO |
| L2 | AuditLog | `design/modules/l2_audit_log.md` | `opts.audit`（AuditWriter interface） |
| L4 | TaskSystem | `design/modules/l4_task_system.md` | `opts.taskSystem` 派 retro subagent（唯一入口） |
| L5 | ContractSystem | `design/modules/l5_contract_system.md` | `opts.contractSystem` 订阅 `contract_completed` 事件 |

### 外部

无直接外部依赖。LLM 调用间接经 TaskSystem → SubAgent → LLMService。

## 5. 装配归属

**应然**：

- **按需**（任何需要从契约完成中沉淀能力的 agent 装；不绑死 motion 独占 / 不绑死 claw 独占；装配方按 use case 决定哪个 daemon 装）
- 推导：模块本身不绑死 identity / 装配方按 use case 决定；ContractRetro 提供「契约能力沉淀 + 模板查询」能力，default 哪个 daemon 装是配置层的事 / 不归 modules.md。
- 一个 daemon 进程内可装多个 ContractRetro 实例（每个实例自有 `templateLibraryDir` / 适用于隔离不同来源的能力模板库）

## 6. 资源

### 磁盘

| 资源 | 路径 | 语义 | 归属 |
|---|---|---|---|
| 能力模板库目录 | `<templateLibraryDir>/` | 提炼出的技能模板存储（per ContractRetro 实例自有） | ContractRetro |
| retro 状态文件 | `<stateDir>/.contract-retro-state.json` | 已 retro 过的 contractId 列表 + 上次处理时间戳 | ContractRetro |

### 内存

- 无长驻状态；事件回调触发时按需读 state 文件 / 处理完写回
- retro subagent 调度后 ContractRetro 不阻塞等待结果（异步 / 由 TaskSystem watcher 拾起）

### 常量

- `DEFAULT_RETRO_SUBAGENT_TIMEOUT_MS`：retro subagent 默认超时（实然定义阶段确定具体值与定义位置）
- 默认 retro prompt 模板字符串：实然定义阶段确定（可由 `retroPromptTemplate` 覆盖）

## 7. 与现状差距

### 7.0 整体状态：应然新模块 / 实然 0 落地（r43 A audit fork 第 6 轮验证 / 2026-04-27）

**应然描述**：独立 L5 ContractRetro 类 + 工厂 `createContractRetro` + 接口 (`subscribeToContractSystem` / `listTemplates` / `getTemplate` / `runRetroForContract`) + SkillTemplate 持久化 + 去重状态文件 + 错误隔离 + 超时配置。

**实然现状**：retro 流程作为 `ContractManager.handleReviewRequest()` 内嵌方法存在（manager.ts:1239-1404）/ 无独立模块 / 无工厂 / 无对外接口 / 无 SkillTemplate 持久化 / 无去重 / 无超时配置 / 无装配端点。

**framing**：本契约是**应然先于实然 design** / 整 module 等代码 phase 落地（不是 drift）。下文 §7.B 列治理候选作为代码 phase scope。

### 7.A 已消化

（无 / 整 module 待落地）

### 7.B 待消化（治理候选 / 推 r43+/r44+ 代码 phase）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。本契约多数项 = **design-gap**（应然先于实然 / 等代码落地）。

| # | 项 | type | 优先 |
|---|---|---|---|
| **B.p347-retro-1** | 无独立模块 / 无工厂 `createContractRetro` / 无装配端点 | design-gap → 代码 phase 实施 | 高 |
| **B.p347-retro-2** | 无事件订阅注册 `subscribeToContractSystem` / 实然 daemon 直调 handleReviewRequest | design-gap | 高 |
| **B.p347-retro-3** | audit 事件命名空间越界 / RETRO_* 6 事件在 CONTRACT_AUDIT_EVENTS 而非 RETRO_AUDIT_EVENTS | drift（与代码 phase 一并迁）| 中 |
| **B.p347-retro-4** | dispatch-skills 资源归属未落地 / 实然 dispatch.ts + daemon.ts 直读 clawspace/dispatch-skills/ 而非走 ContractRetro 对外口 | design-gap → 实施时同治 | 高（与 l2_skill_system §7.B B.p344-skill-disp 同根）|
| **B.p347-retro-5** | 缺失 SkillTemplate 模型 + 持久化 + 索引 / retro subagent 输出仅由 prompt 指导 / 无解析 / 无持久化 | design-gap | 高 |
| **B.p347-retro-6** | 缺失去重状态文件 `.contract-retro-state.json` / 同 contractId 多次调可重复 retro | design-gap | 中 |
| **B.p347-retro-7** | 缺失 `retroSubagentTimeoutMs` 配置参数 / timeout 硬编码 600 秒 / 无超时软失败 audit | drift | 中 |
| **B.p347-retro-8** | fire-and-forget catch 块缺 `isProgrammingBug` 检（manager.ts:1378-1395 + 1398-1403）/ phase342 模式未推广至 retro 路径 | drift（B.p340-2 同根扩展）| 中 |
| **B.p347-retro-9** | 缺失 `listTemplates(filter?)` / `getTemplate(templateId)` 对外接口 | design-gap | 高 |
| **B.p347-retro-10** | 缺失工厂和装配端点 / retro 逻辑硬绑 Motion daemon | design-gap | 高 |

**汇总**：应然新模块 / 实然 0 落地 / 治理 = 独立代码 phase 落地 ContractRetro / 推 r44+ 候选（与三 design-gap 合并 design phase 评估时机协调）。

### 7.C 原则对照（应然 derive 阶段 / 实然实现后回填详细判定）

应然按 32 条覆盖框架（Module 11 + Design 11 + Philosophy 4 + Path 6）/ 实然 0 落地 = 全条目 placeholder。代码 phase 落地后批量补判定 ✓/✗。

### 7.D § numbering drift 表

| 位置 | 旧值 | 新值 | 原因 |
|---|---|---|---|
| head 摘要 | 极简 "> 应然契约" | 完整 pattern（应然/实然/归属/依赖） | split propagation 统一格式 |
| § numbering | — | 无 drift | 新模块，首次注册即 §25 |

## 8. 测试

### 现有覆盖

（占位 / 新模块无现有覆盖 / 实然实现 phase 后回填）

### Stage 2 补齐

（占位 / 实然实现 phase 后回填）
