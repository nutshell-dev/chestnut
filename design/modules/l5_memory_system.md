# MemorySystem 接口契约

> phase318 完整化（2026-04-26 / r30 B / 合入 main / MemorySystem 模块创建 + 文件搬迁 + Assembly 装配）。
> 此前状态：phase171 登记"未实现 / 暂不模块化"；phase318 触发条件满足（memory_search + dream prompts + dream jobs 跨域协调需求实然已发生）。

## 1. 职责

### 归属层

L5 外壳与能力。MemorySystem 是智能体记忆整合的业务语义收口模块。

### 做

1. **deep-dream 调度执行**：遍历所有 claw 的 `dialog/archive/` + `dialog/current.json`，为每个未处理会话文件生成 LLM 梦境洞见（Call 1：梦境生成；Call 2：压缩摘要），投递到对应 claw 的 inbox
2. **random-dream 调度执行**：从所有 claw 的已归档契约中按权重抽样，调度一次性子代理进行跨 claw 梦境探索，解析 `[DREAM_OUTPUT]` 块后投递到 motion inbox
3. **契约权重发现**：`discoverWeightedContracts` 按 recency / difficulty / claw 分布 / 已处理历史计算契约优先级
4. **子代理调度**：random-dream 经 `writePendingSubagentTaskFile` 写 pending 任务文件，由 TaskSystem watcher 异步拾起执行
5. **状态追踪**：`.deep-dream-state.json`（per claw）记录已处理 archive 文件名 + 当日 current.json 处理标记；`.random-dream-state.json`（clawforumDir 根）记录已处理 contractId 列表

### 不做

- 不做 memory 文件管理（memory/ 子目录的物理组织归 FileSystem / 调用方）
- 不做 memory 格式定义（消息 frontmatter / JSON schema 归 Messaging / MessageCodec）
- 不做工具注册（`memory_search` 工具保留在 `tools/builtins/`；工具注册是 tools 域职责）
- 不做 LLM 服务生命周期管理（归 Assembly 注入；MemorySystem 消费 `LLMService` 接口，不构造实现）
- 不做 Node fs → FileSystem 抽象替换（deep-dream/random-dream 内部仍用 Node 同步 fs API；Stage 2 scope）

## 2. 对外接口

### 类型签名

```ts
// 工厂（装配期唯一入口）
export function createMemorySystem(opts: MemorySystemOptions): MemorySystem;

export interface MemorySystemOptions {
  clawforumDir: string;
  motionDir: string;
  fs: FileSystem;
  audit: Audit;
  taskSystem: TaskSystem;
  llmService: LLMService;        // ← 注入（修 N1：deep-dream 不再自建 LLM）
  llmConfig: LLMServiceConfig;   // deep-dream 内部仍需 config
  maxCompressionTokens?: number;
}

export class MemorySystem {
  constructor(opts: MemorySystemOptions);
  async runDeepDream(maxCompressionTokens?: number): Promise<void>;
  async runRandomDream(): Promise<void>;
}
```

### 关键约定

- **工厂唯一入口**：`createMemorySystem` 是 MemorySystem 对外唯一构造方式；直接 `new MemorySystem` 在类型层允许（class `export`），但语义上走工厂
- **LLM 注入（N1 修复）**：deep-dream 不再内部 `new LLMServiceImpl(...)`，改用 Assembly 注入的 `LLMService` 实例；生命周期由 Assembly 管理（MemorySystem 不调用 `llm.close()`）
- **maxCompressionTokens 覆盖**：`runDeepDream(optTokens?)` 参数可覆盖构造期传入的默认值；未提供时用 `opts.maxCompressionTokens ?? 4000`
- **错误隔离**：单 claw deep-dream 失败不阻断其他 claw（try/catch per claw）；random-dream 子代理超时 / 无输出 是软失败（audit 记录后返回）
- **状态文件容错**：state 文件读取失败时静默回退到空初始状态（`catch { return defaultState }`）；写入失败时抛错上抛（由调用方 handler 捕获并 audit）

## 3. 事件（audit）

MemorySystem 本身不直接写 audit；deep-dream / random-dream 业务函数通过 `opts.audit.write(...)` 发出以下事件（事件名保留 cron 域命名，归各自 job 语义）：

| 事件名 | 发出者 | 语义 | 载荷 |
|---|---|---|---|
| `cron_deep_dream_job` | deep-dream | 单 claw 处理状态 | `step=skip_empty\|started\|finished`, `clawId`, `session_count`, `dream_count` |
| `cron_deep_dream_error` | deep-dream | 单 claw 处理失败 | `step=call_1\|call_2\|unexpected`, `clawId`, `file`, `reason` |
| `cron_random_dream_job` | random-dream | 整体处理状态 | `step=skip_empty\|scheduled\|subagent_started\|finished`, `count`, `taskId`, `output_count` |
| `cron_random_dream_warning` | random-dream | 软失败 | `reason=subagent_timeout\|no_output` |

**不在本清单**（由 Assembly 发出）：`assemble_failed`（`module=memory_system`, `phase=construct`）—— Assembly 构造 MemorySystem 失败时写。

## 4. 依赖

### 同仓

| L 层 | 模块 | 契约 / 位置 | 使用方式 |
|---|---|---|---|
| L1 | FileSystem | `design/modules/l1_filesystem.md` | `opts.fs` 用于 InboxWriter / AuditWriter 构造 |
| L1 | LLMService | `design/modules/l1_llm_service.md` | `opts.llmService`（接口消费，不依赖实现类） |
| L2 | AuditLog | `design/modules/l2_audit_log.md` | `opts.audit`（AuditWriter interface） |
| L2 | Messaging | `design/modules/l2_messaging.md` | `InboxWriter` 投递 deep_dream / random_dream 消息 |
| L4 | TaskSystem | `design/modules/l4_task_system.md` | `opts.taskSystem` 仅用于 random-dream 的 `writePendingSubagentTaskFile` |

### 外部

无直接外部依赖。LLM 调用间接经 LLMService → Anthropic / OpenAI SDK。

## 5. 装配归属

- **motion 独占**（Philosophy "motion 主动整合多个智能体的持久化记忆充分提取信息"）
- **装配位置**：`src/assembly/assemble.ts`，CronRunner 构造之前
- **装配代码**：
  ```ts
  const memorySystem = createMemorySystem({
    clawforumDir,
    motionDir: clawDir,
    fs: clawforumFs,
    audit: auditWriter,
    taskSystem: runtime.getTaskSystem(),
    llmService: llm,
    llmConfig,
    maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
  });
  ```
- **消费者**：Cron `dream-trigger` job handler 调用 `memorySystem.runDeepDream()` + `memorySystem.runRandomDream()`

## 6. 资源

### 磁盘

| 资源 | 路径 | 语义 | 归属 |
|---|---|---|---|
| `.deep-dream-state.json` | `<clawDir>/.deep-dream-state.json` | 已处理 archive 列表 + current.json 当日处理日期 | deep-dream（per claw） |
| `.random-dream-state.json` | `<clawforumDir>/.random-dream-state.json` | 已处理 contractId 列表 | random-dream（全局） |

### 内存

- 无长驻状态；cron 触发时创建 MemorySystem 实例，handler 完成后可回收
- `compressions: string[]` 为 deep-dream 单轮处理的滑动窗口（内存内，不落盘）

### 常量

无 MemorySystem 独占常量。`DEFAULT_LLM_IDLE_TIMEOUT_MS` 用于 random-dream 子代理调度（定义于 `src/constants.ts`，跨模块共享）。

## 7. 与现状差距

### 7.A 已消化

- **N1 修复（phase318）**：deep-dream 原 `new LLMServiceImpl(...)` 改为注入 `opts.llmService`；删除 `LLMServiceImpl` / `createLLMAuditSink` 直接依赖，改依赖 `LLMService` 接口
- **文件搬迁（phase318）**：deep-dream + random-dream + 2 prompts 从 `cron/jobs/` + `src/prompts/` 搬迁到 `src/core/memory/`；import 路径收敛
- **工厂模式（phase318）**：新增 `MemorySystem` class + `createMemorySystem` 工厂，与 TaskSystem / SkillSystem / ContractSystem 模式一致

### 7.B 待消化（Backlog）

| ID | 内容 | 优先级 | 预期消化 phase |
|---|---|---|---|
| B.p318-1 | Node fs → FileSystem 抽象替换 | 低 | Stage 2（deep-dream / random-dream 内部仍用 `import * as fs from 'fs'` 同步 API） |
| B.p318-2 | MemorySystem 工厂单元测试 | 低 | Stage 2（当前仅 deep-dream / random-dream 功能测试覆盖，无 MemorySystem 构造 + 方法委托测试） |
| B.p318-3 | memory_search 工具物理位置讨论 | 低 | Stage 2（当前保留在 `tools/builtins/`；工具注册是 tools 域职责，但 MemorySystem 是业务语义归属） |

### 7.C 原则对照

**Module Logic 11 条**：

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| M#1 | 职责归一 | ✓ | MemorySystem 独占 memory 业务；cron/tools 不再直接调 dream jobs |
| M#2 | 业务语义归属 | ✓ | deep-dream 不再自建 LLM；改注入 |
| M#3 | 资源归一 | ✓ | MemorySystem 不直接管理持久化资源（state 文件由业务函数管理） |
| M#4 | 持久化 | N/A | 无新增持久化 |
| M#5 | 依赖单向 | ✓ | L5 Memory → L4 Task + L2 Messaging + L1 FS/LLM；不反向 |
| M#6 | 依赖结构稳定 | ✓ | 新模块无历史依赖包袱 |
| M#7 | 耦合界面稳定 | ✓ | 单工厂 `createMemorySystem` + 2 方法接口 |
| M#8 | 耦合界面最小 | ✓ | 2 async 方法 / 无事件 / 无回调 |
| M#9 | 显式表达编译期 | ✓ | 接口类型 + 工厂；tsc 可检 |
| M#10 | 不合理停下 | ✓ | α/β derive 已做（α 完整模块化） |
| M#11 | 边界不对停下 | N/A | 新模块无边界争议 |

**Design Principles 11 条**：

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| D#1 | 信息不丢失 | ✓ | dream 产出仍写 inbox / audit 不变 |
| D#2 | 不得静默忽略 | ✓ | 错误路径保持原 audit + console |
| D#3 | 用户可观察 | ✓ | audit 事件不变 |
| D#4 | 中断可恢复 | ✓ | state 文件逻辑不变 |
| D#5 | 日志重建 | ✓ | audit 事件 + cron 日志不变 |
| D#6 | 智能体决策主体 | N/A | 不涉及 |
| D#7 | 可信路径 | ✓ | Assembly 注入 deps（不再 new LLM） |
| D#8 | 事件驱动 | ✓ | cron 触发不变 |
| D#9 | 多 claw | ✓ | dream 仍遍历所有 claw |
| D#10 | motion 特殊 | ✓ | identity='motion' 装配 |
| D#11 | CLI 唯一入口 | ✓ | 不涉及 |

**Coding 8 条**：

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| C#1 | 减少依赖 | ✓ | deep-dream 不再依赖 LLMServiceImpl 构造 |
| C#2 | 抽象隐藏 | ✓ | MemorySystem 隐藏 dream 内部实现 |
| C#3 | 删代码须论证 | ✓ | 不删功能代码 / 仅搬迁 |
| C#4 | 状态可预测 | ✓ | state 文件管理不变 |
| C#5 | 预期失败显式处理 | ✓ | 原有 error/audit 路径保留 |
| C#6 | 命名准确 | ✓ | MemorySystem / createMemorySystem / 方法名清晰 |
| C#7 | 命名一致 | ✓ | 与 TaskSystem/SkillSystem 工厂模式一致 |
| C#8 | 测试行为契约 | △ | 无新增测试 / 现有测试通过搬迁（B.p318-2） |

## 8. 测试

### 现有覆盖

- `tests/core/cron/deep-dream.test.ts` → 搬迁至 `tests/core/memory/deep-dream.test.ts`（import 路径更新 + mock 方式更新为注入 LLM）
  - 覆盖：目录不存在 / 无 session / 正常处理 / Call 2 不传 system / 空会话 state 落盘 / 已处理不重复 / Call 2 失败降级 / current.json 处理 / 多 claw 隔离 / 元压缩 / 时间戳升序
- `tests/core/cron/random-dream.test.ts` → 搬迁逻辑上保留原位（物理路径不变，import 路径更新）
  - 覆盖：无契约 / sub-agent 完成 / 多 DREAM_OUTPUT 提取 / 无输出 / Fix 5 轮询 / Fix 3 hint / 已处理降权 / progress.json 加权 / 超时
- `tests/assembly/assemble.test.ts` 
  - 覆盖：MemorySystem 构造 + `runDeepDream` / `runRandomDream` 通过 cron handler 被调用（mock `createMemorySystem`）

### Stage 2 补齐

- MemorySystem 工厂单元测试（构造 + 方法委托 + maxCompressionTokens 覆盖优先级）
- `memory_search` 工具与 MemorySystem 的交互契约测试（如 MemorySystem 未来暴露 search API）
