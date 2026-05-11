# SkillSystem 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md ~~§13~~ §12 align）：技能元信息注册表。扫描 skillsDir 目录加载技能元信息（frontmatter），渐进式披露：启动仅元信息，调 skill 工具时才加载完整 SKILL.md。

**实然**：表述已同步；§7 不动。

归属：L2 基础设施。
- **应然依赖**：FileSystem（L1）, AuditLog（L2）
- **实然依赖**：FileSystem（L1）, AuditLog（L2，可选 / phase180 新增）

被调用：Assembly（主装配）/ Runtime / ContextInjector / TaskSystem / SubAgent / skill 工具。

## 1. 所有权

### 归属层

L2（foundation 能力层；phase173 决策 #28 L5→L2 重分类；phase180 契约文件名同步 `l2_skill_system.md`）。SkillRegistry 落地于 `src/core/skill/registry.ts` ~144 行 + `src/core/skill/index.ts` ~21 行。

### 职责（独立可变的职责集合）

- **技能元信息注册表**：扫 `skillsDir` 下每个子目录，读 `SKILL.md` → `parseFrontmatter` 提取 name/description/version → 构造 `SkillMeta` 入 `metaMap`（`loadAll` / `register`）
- **渐进式披露**：启动期仅加载元信息；调用方（skill 工具）需要完整 SKILL.md 内容时才 `loadFull(name)`（`loadFull`）
- **元信息查询**：单名查 / 列全（`getMeta` / `listMeta`）
- **上下文摘要生成**：输出 `## Available Skills\n- name: description` 形式，供 ContextInjector 注入 system prompt（`formatForContext`）
- **Duplicate 解决策略**：同名技能先注册者胜出，后来者跳过（`register` 内 metaMap 检查）

### 资源

- **磁盘归属**：

  **应然**（2026-04-26 修订 / 跟 modules.md ~~§13~~ §12 align）：`skillsDir` 参数指向 **per-agent 自己的 skills/ 目录**（motion 自有 skills + 各 claw 各自 skills）。由调用方装配指定，不预设默认值。目录结构 = 每个子目录即一个技能，内含 `SKILL.md`（frontmatter + 完整内容）。dispatch-skills 资源**不归 SkillSystem**（应然归 ContractRetro 模块自有 / 见 modules.md §24）。

  **实然**：`skillsDir` 构造默认 `'skills'`；`'clawspace/dispatch-skills'` 当前仍由 dispatch.ts / daemon.ts 构造 `SkillRegistry` 实例使用——dispatch-skills 资源**仍走 SkillSystem 管道**（详 §7 / 待 modules/*.md 实然修订下一阶段经 ContractRetro 改路）。

- **内存句柄**：`metaMap: Map<string, SkillMeta>`（派生态；`loadAll` 后填充，运行期只增不减；磁盘即权威，可重建）
- **无独占常量**：

  **应然**：`skillsDir` 不设默认值——由调用方装配显式传入 per-agent skills/ 路径；当前无忽略文件过滤机制（无 IGNORE_PATTERN，扫描不做过滤）。

  **实然**：`skillsDir` 默认 `'skills'` 仍是构造函数默认参数而非顶层常量（§6 B.p169-2/B.p169-3）。

### 业务语义（由本模块主动发起）

- "技能发现"：`loadAll`（装配期 Assembly 调）
- "技能注册"：`register`（供 `loadAll` 内调 + 测试路径手动调）
- "元信息查询"：`getMeta` / `listMeta`
- "完整技能内容加载"：`loadFull`（由 skill 工具触发）
- "上下文注入摘要"：`formatForContext`（由 ContextInjector / dispatch 工具 / daemon review_request 路径消费）

业务语义清单外即不做。边界参照：`skillsDir` 下文件系统 IO 归 FileSystem；frontmatter 解析归 MessageCodec；装配期失败语义归 Assembly（发 `assemble_failed`）。

**`skillsDir` 选择归属**：

- **应然**（2026-04-26 修订）：`skillsDir` 仅指 per-agent skills/，由 Assembly（per-agent 装配）决定。dispatch-skills 资源整体不归 SkillSystem，dispatch 工具读 dispatch-skills 应经 ContractRetro 对外入口（modules.md §24），不经 SkillSystem。
- **实然**：当前 `skillsDir` 选择（`'skills'` vs `'clawspace/dispatch-skills'`）由调用方（Assembly / dispatch 工具 / daemon）各自决定；dispatch-skills 仍以 SkillRegistry 实例承载（详 §7）。

## 2. 接口

### 2.1 类型签名

#### 元信息类型

```ts
export interface SkillMeta {
  name: string;         // frontmatter.name，fallback 为目录末段
  description: string;  // frontmatter.description，默认 ''
  version: string;      // frontmatter.version，默认 '0.0.0'
  skillDir: string;     // 技能目录路径（由调用方传入，相对或绝对）
}
```

#### 工厂（phase169 B 动作新增）

```ts
export function createSkillRegistry(
  fs: FileSystem,
  skillsDir: string = 'skills',
  audit?: Audit,
): SkillRegistry;
```

`audit` 为可选参（`Audit` 类型），向后兼容 B.p169-1 剩余 4 处 `new SkillRegistry` 调用不传 audit。

**`skillsDir` 默认值应然/实然**：

- **应然**（2026-04-26 修订）：`skillsDir` 不设默认值（`skillsDir: string` 必填），由 per-agent Assembly 显式传入 per-agent skills/ 路径。
- **实然**：仍保留 `= 'skills'` 默认参数（§6 B.p169-3）。

**使用约束**：工厂仅构造，**不调 `loadAll()`**。调用方（Assembly / 工具）必须在使用前显式 `await registry.loadAll()`，否则 `metaMap` 为空（`listMeta()` 返回 `[]`；`formatForContext()` 输出 `"## Available Skills\nNo skills loaded.\n"`）。与 phase166 `createRuntime` 不调 `initialize()` / phase158 `createTaskSystem` 不调 `initialize()` 同型——工厂只负责构造，业务动作触发时机归装配/调用方。

#### SkillRegistry 公共方法（6 / 5 组）

**initialization**：

```ts
async loadAll(): Promise<void>;
// 行为承诺：
//   - 扫 skillsDir 下每个子目录（fs.list + includeDirs）
//   - 对每个存在 SKILL.md 的子目录调 register(skillDir)
//   - skillsDir 不存在 → 静默返回（合规：空注册表是合法状态）
//   - 单个技能注册失败 → 当前走 console.warn 跳过继续下一个（违 Design #1d/#2，§7.A1 登记）
```

**registration**：

```ts
async register(skillDir: string): Promise<SkillMeta>;
// 行为承诺：
//   - 读 `${skillDir}/SKILL.md` → parseFrontmatter → 构 SkillMeta 入 metaMap
//   - 同名 duplicate：保留首次注册，返回已存 meta（当前走 console.warn，§7.A2 登记）
//   - 抛错条件：fs.read 失败（SKILL.md 不存在或无权限）
```

**query**：

```ts
getMeta(name: string): SkillMeta | undefined;
listMeta(): SkillMeta[];
// 纯内存查询，不触发 IO。
```

**progressive disclosure**：

```ts
async loadFull(name: string): Promise<string>;
// 按 metaMap[name].skillDir 读 SKILL.md 完整内容（含 frontmatter）。
// 未注册名 → 抛 ToolError(`Skill "${name}" not found`)。
```

**context injection**：

```ts
formatForContext(): string;
// 输出：
//   ## Available Skills
//   - name1: description1
//   - name2: description2
// metaMap 空时输出 "## Available Skills\nNo skills loaded.\n"。
// 消费方：ContextInjector（system prompt 注入）/ dispatch 工具（摘要注入）/ daemon review_request（retro prompt）。
```

### 2.2 使用模式

#### 主装配路径（Assembly，phase169 Step 6 改造后）

```ts
import { createSkillRegistry } from '../core/skill/index.js';

let skillRegistry: SkillRegistry;
try {
  skillRegistry = createSkillRegistry(systemFs, 'skills');
} catch (e) {
  auditWriter.write('assemble_failed', `module=skill_registry`, `phase=construct`, `reason=${errMsg(e)}`);
  throw new Error(`Assembly: SkillRegistry construct failed: ${errMsg(e)}`, { cause: e });
}
try {
  await skillRegistry.loadAll();
} catch (e) {
  auditWriter.write('assemble_failed', `module=skill_registry`, `phase=init`, `reason=${errMsg(e)}`);
  throw new Error(`Assembly: SkillRegistry.loadAll failed: ${errMsg(e)}`, { cause: e });
}
```

#### 临时实例化路径（B.p169-1 登记，细化期保留）

~~phase180 后仍有 **4 处** `new SkillRegistry(...)` 直接调用（N1 偏差订正：phase169 登记"3 处"不准；contract/manager.ts:1334 为新增未登记点）：~~ → **B.p169-1 4/4 闭环**（phase296 跨 r9-r25 接力；仅工厂内部 `index.ts:21` 1 处 `new SkillRegistry` 保留）。
- `src/core/contract/manager.ts:1334`（review_request 路径）
- `src/core/tools/builtins/dispatch.ts:65`（dispatch 工具每次调用时扫 `clawspace/dispatch-skills`）
- `src/core/tools/builtins/skill.ts:42`（skill 工具 `args.skillsDir` 兜底）
- `tests/helpers/runtime-deps.ts:47`（测试 helper）

**audit 可选参向后兼容**：不传 audit 时 `audit?.write(...)` 短路，行为不变。

治理路径：各自模块细化期统一改调 `createSkillRegistry`。

## 3. 审计事件清单

### 3.1 SkillRegistry 自产事件（phase180 落地 3 类）

phase180 集成 3 类 audit 事件。`skill_*` 前缀专属，与其他模块零重复。

#### 3.1.1 `skill_load_failed`

- **触发时机**：`loadAll` 单技能 `register()` 抛出（registry.ts L56 区间）
- **前置条件**：`fs.read` 失败 / `parseFrontmatter` 异常 / 其他注册错误
- **后置状态**：console.warn 双写保留；continue 下个技能（loadAll 不中止）
- **载荷**：`skill_dir=<path>` / `skills_dir=<root>` / `err=<message>`

#### 3.1.2 `skill_duplicate_skipped`

- **触发时机**：`register` 发现 `metaMap.has(name)` 为 true（registry.ts L84 区间）
- **前置条件**：SKILL.md frontmatter.name 与已注册 skill 同名
- **后置状态**：console.warn 双写保留；return existing（保留首次注册）
- **载荷**：`name=<skill_name>` / `existing_skill_dir=<path>` / `attempted_skill_dir=<path>` / `skills_dir=<root>`

#### 3.1.3 `skill_registry_loaded`

- **触发时机**：`loadAll` 正常出口（D5 β 决策；skillsDir 不存在的静默 return 不发）
- **前置条件**：`fs.exists(skillsDir) = true` + scan 完成
- **后置状态**：metaMap 已填充；listMeta() 返回完整清单
- **载荷**：`skills_dir=<root>` / `count=<n>`

### 3.1.4 保留 console 清单（phase180 决策）

| 位置 | 级别 | 决策 | 理由 |
|---|---|---|---|
| `registry.ts:L56` | warn | 保留（双写 + §3.1.1 audit） | loadAll 单技能失败运维即时见 |
| `registry.ts:L84` | warn | 保留（双写 + §3.1.2 audit） | duplicate 冲突运维即时见 |

### 3.1.x 细化期剩余事件（未实装）

- `skill_loaded_full`（`loadFull` 被调；B 类候选）

### 3.2 装配期关联事件（Assembly 产生，引用）

同 phase169 登记，无变化。

### 3.3 消费方事件（ContextInjector / 工具层产生，引用）

同 phase169 登记，无变化。

---

## 4. 上游依赖

### 4.1 L1 — FileSystem

```ts
import type { FileSystem } from '../../foundation/fs/types.js';
```

调用面：`fs.exists` / `fs.list({ includeDirs: true })` / `fs.read`。

- 耦合界面：`FileSystem` 接口最小子集（3 个方法）
- 不可消除理由：`skillsDir` 目录扫描 + `SKILL.md` 文件读取是 SkillSystem 业务动作不可规避的 IO 路径
- 注入形态：构造函数参数 `fs: FileSystem`（运行期不可变，符合 M#6 依赖结构稳定）

### 4.2 L2 — MessageCodec.parseFrontmatter

```ts
import { parseFrontmatter } from '../../foundation/message-codec/index.js';
```

调用面：`parseFrontmatter(content): { meta, body }`（仅用 meta）。

- 耦合界面：单函数（纯函数，无状态）
- 不可消除理由：SKILL.md 元信息格式是 frontmatter，与项目其他 markdown 文件（IDENTITY.md / SOUL.md / AGENTS.md）复用同一解析器
- 注入形态：模块级 import（非注入）；若未来需换解析器则 §5.2 硬化协议

### 4.3 L2 — AuditLog（phase180 新增，可选依赖）

```ts
import type { Audit } from '../../foundation/audit/index.js';
```

- 调用面：`audit?.write(type, ...fields): void`（3 触发点）
- 耦合界面：单方法（可选参）
- 不可消除理由：§7.A1/A2/A3 清零驱动；Design #1d 事后可审计
- 注入形态：constructor 可选参（`audit?: Audit`），向后兼容 B.p169-1 剩余 4 处 `new SkillRegistry` 调用不传 audit

### 4.4 共享类型 — ToolError

```ts
import { ToolError } from '../../types/errors.js';
```

调用面：`loadFull` 未注册技能名时抛 `new ToolError(...)`。

- 耦合界面：单个错误类（构造函数 + Error 继承）
- 不可消除理由：`ToolError` 是工具层约定的错误类型；`loadFull` 失败由 skill 工具捕获并转成 `ToolResult`（工具层内部约定），故选用 `ToolError` 而非普通 `Error`
- 注入形态：模块级 import（类型 + 构造器）

### 4.5 依赖层级合规

| 本模块层 | 依赖 | 被依赖层 | 合规 |
|---|---|---|---|
| L2 SkillSystem | FileSystem | L1 foundation | ✓ 下行 |
| L2 SkillSystem | parseFrontmatter | L2 foundation | ✓ 同层 |
| L2 SkillSystem | Audit（可选） | L2 foundation | ✓ 同层 |
| L2 SkillSystem | ToolError | 共享 types | ✓ 横向 |

phase173 决策 #28：SkillSystem 归 L2 基础设施；phase180 契约文件名同步 rename。

## 5. 不可消除耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。SkillRegistry 工厂模式（phase296 闭环）即 port 范本（消费方 own / FileSystem 注入）。

### 5.1 `skillsDir` 目录结构约定

SkillRegistry 与调用方共享隐含约定：

- `skillsDir` 下每个**一级子目录**即一个技能
- 每个技能子目录必须有 `SKILL.md`（否则 `loadAll` 扫描时 `hasSkillMd` 判空跳过）
- 技能名优先来自 `SKILL.md` frontmatter.name；缺失时 fallback 为子目录名

**显式表达编译期的缺口**：目录结构约定是运行时约束，无法让编译器检查；破坏方式（如嵌套技能 / SKILL.md 改名）运行期才暴露。后续可考虑抽取 `SkillsLayout` 类型常量（但当前非刚需，不在本 phase 做）。

### 5.2 frontmatter 格式约定

`SkillMeta` 三个核心字段（name / description / version）与 `parseFrontmatter` 输出形成隐式协议：

- SkillSystem 只读取这三个字段；frontmatter 其他字段全部忽略（无告警）
- 字段缺失时用默认值（`''` / `'0.0.0'`），不抛错
- 未来若新增必填字段（如 `category`），破坏面是本模块 + 所有 SKILL.md 文件

**显式表达编译期的缺口**：frontmatter 解析结果是 `Record<string, unknown>` 形态（由 MessageCodec 决定），SkillSystem 内部用 `frontmatter.name || dirName` 软校验；若 frontmatter 类型收紧由 MessageCodec 契约定义。

### 5.3 SkillMeta 对消费方的 publisher-subscriber 形态

**消费方清单**（Step 1 F6 / F14 实测）：
- 值 import：Assembly / daemon.ts（临时实例） / dispatch.ts（临时实例） / skill.ts（临时实例）
- type-only：ToolExecutor / ToolContext / ContextInjector / TaskSystem / SubAgent / `src/index.ts` re-export
- tests mock：assemble.test.ts / dialog.test.ts

**耦合方向**：SkillSystem 发布 `SkillMeta` 类型；所有消费方持 `SkillRegistry` 实例引用或 `SkillMeta` 类型但不反调 SkillRegistry 状态——符合 publisher-subscriber 形态 B（`feedback_cycle_vs_reverse_dependency`）。不构成循环耦合。

**`formatForContext` 作为耦合窄化点**：消费方（ContextInjector / dispatch / daemon）通过 `formatForContext()` 字符串摘要消费技能信息，而非遍历 `listMeta()` 自行格式化——收敛上下文注入格式到 SkillSystem 自身，符合 M#7 耦合界面稳定 + M#8 耦合界面最小。

### 5.4 注入 skillRegistry 的下游模块

以下模块在各自 `ExecContext` / `TaskSystemDependencies` / `RuntimeDependencies` / `SubAgentOptions` 中声明 `skillRegistry?: SkillRegistry` 字段：

| 下游 | 字段 | 必填 | 用途 |
|---|---|---|---|
| ExecContextImpl | `skillRegistry?` | 否 | skill 工具 / dispatch 工具读取 |
| ToolExecutorImpl | `skillRegistry?` | 否 | 注入到 ExecContext |
| ContextInjector | `skillRegistry?` | 否 | system prompt 注入 |
| TaskSystem | `skillRegistry` | 是 | 构造子 ExecContext 时传递 |
| SubAgent | `skillRegistry?` | 否 | 子 agent 可消费技能 |
| RuntimeDependencies.skillRegistry | readonly | 是 | Runtime 构造期注入 |

"?" 表示可选字段：缺失时 skill / dispatch 工具在运行期走 fallback（当前 skill 工具 L42 走 `new SkillRegistry(...)` 兜底，登记 B.p169-1）。

## 6. 配置常量归属

### 6.1 当前字面量（Step 1 F13 实测）

**实然表**：

| 字面量 | 出现位置 | 用途 |
|---|---|---|
| `'skills'` | `registry.ts:25`（构造默认）/ `assemble.ts:174` / `tests/helpers/runtime-deps.ts:47` | 主装配 skillsDir |
| `'clawspace/dispatch-skills'` | `dispatch.ts:65` / `daemon.ts:179` | motion 专用 dispatch-skills 目录（实然仍走 SkillSystem 管道） |

**无顶层导出常量**——`skillsDir` 默认值硬编码在构造函数默认参数；`'clawspace/dispatch-skills'` 散在 2 处代码中。

### 6.2 归属登记

**应然**（2026-04-26 修订 / 跟 modules.md ~~§13~~ §12 / §24 align）：

- `SKILLS_DIR_*`（per-agent skills/ 路径）：**不设全局常量**——`skillsDir` 由 per-agent Assembly 显式传入，per-agent 路径是装配方决策不是 SkillSystem 资源
- `'clawspace/dispatch-skills'`：**不归 SkillSystem**，归 ContractRetro 模块自有（modules.md §24）；dispatch 工具应经 ContractRetro 对外入口消费 dispatch-skills 资源，不再经 SkillRegistry

**实然**：

- `SKILLS_DIR_DEFAULT = 'skills'`：**未抽常量**，硬编码在 `registry.ts:25` 构造默认参数
- `DISPATCH_SKILLS_DIR = 'clawspace/dispatch-skills'`：**未抽常量**，散在 dispatch.ts:65 / daemon.ts:179；dispatch-skills 仍由 SkillRegistry 实例承载（待 ContractRetro 落地后改路）

### 6.3 实然偏差

均未抽取为常量，登记 §7.B2 / §7.B3 偏差：
- B.p169-2 — 4 处字符串字面量未抽顶层常量
- B.p169-3 — `skillsDir` 默认 `'skills'` 硬编码构造参数而非 `SKILLS_DIR_DEFAULT`

**额外应然偏差**（2026-04-26 修订识别 / 待 §7 下一阶段登记）：dispatch-skills 资源归属（实然 SkillSystem / 应然 ContractRetro）+ skillsDir 默认值存在（实然有默认 / 应然必填）——属架构层应然漂移，治理路径见 modules/*.md 实然修订下一阶段（ContractRetro 落地 + dispatch 路由切换 + per-agent Assembly skillsDir 必填化）。

治理路径：细化期 §6.3 当前 2 条（B.p169-2/3）一并提取到 `index.ts`；架构层应然偏差待 ContractRetro phase 落地。

### 6.4 无忽略过滤常量（F10 核实）

当前 `loadAll` 扫描不做忽略过滤（无 `IGNORE_PATTERN` / `SKIP_DIRS` 等）：
- 影响：若 `skillsDir` 下混有非技能子目录（如 `node_modules` / `.git` / `backup/`），扫描会尝试读 `SKILL.md` 并因 `hasSkillMd` 为 false 跳过——不报错但浪费 IO
- 功能缺口非违规：当前部署场景 `skills/` / `clawspace/dispatch-skills/` 均为专用目录，无污染风险
- 若未来需要引入忽略机制 → 独立 phase 加（不在本 phase 或细化期范围）

## 7. 实然差距

### 7.A 必修违规（待后续 phase 消除）

所有 7.A 条目违反 Design #1d（事后可审计）/ Design #2（信息不得丢弃/静默）。粗糙期登记，细化期消除。

#### ~~A1~~ — loadAll 扫描失败软吞（**phase180 已清零**）

phase180 Step 3 实装 `skill_load_failed` audit（双写 audit + console），§3.1.1 事件清单登记。Console 保留作运维可见性（参 phase173 §3.3.6 模板）。audit 为可选参（constructor `audit?: Audit`），向后兼容 B.p169-1 剩余 4 处 `new SkillRegistry` 调用。

#### ~~A2~~ — register duplicate 跳过软吞（**phase180 已清零**）

phase180 Step 3 实装 `skill_duplicate_skipped` audit（双写 audit + console），§3.1.2 事件清单登记。载荷含 `name` / `existing_skill_dir` / `attempted_skill_dir` / `skills_dir`，可审计同名冲突的双方路径。

#### ~~A3~~ — SkillRegistry 无 audit 集成（**phase180 已清零**）

phase180 Step 2 升 signature（`createSkillRegistry(fs, skillsDir, audit?)` 三参，audit 可选）+ Step 3 实装 3 audit type：
- `skill_load_failed`（loadAll 单技能失败，§3.1.1）
- `skill_duplicate_skipped`（register 同名跳过，§3.1.2）
- `skill_registry_loaded`（loadAll 正常出口，§3.1.3）

**细化期剩余**（B 类候选，独立 phase）：
- `skill_loaded_full`（`loadFull` 调用 audit）
- B.p169-1 4 处 `new SkillRegistry` 清理（contract/manager.ts / dispatch.ts / skill.ts / tests/helpers）

#### ~~A4~~ — SkillRegistry class 无直接单测（**phase180 已清零**）

phase180 Step 4 新建 `tests/core/skill/registry.test.ts` 覆盖 SkillRegistry 6 组方法 ≥ 12 it：
- loadAll 4 it（空 / 空目录 / 2 skill 正常 / 单技能失败）
- register 3 it（正常 / duplicate / frontmatter 缺字段 fallback）
- query 2 it（getMeta 未注册 / listMeta 全部）
- loadFull 2 it（已注册 / 未注册抛 ToolError）
- formatForContext 2 it（空 / 非空）
- 3 audit type 双粒度断言（type + payload）

### 7.B 偏差登记（当前合理）

每条附 **owner + 计划 phase + 升档条件**。编号用 `B.p169-*` 前缀。

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B.p169-* 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.p169-1 = **drift / 已闭环**
> - **B.p344-skill-1 audit event 字符串硬编码**（r42 D fork 新发现）= **drift**：3 处 audit.write `skill_load_failed` / `skill_duplicate_skipped` / `skill_registry_loaded` 在 registry.ts 直字符串 / **应有 skill/audit-events.ts** / 与 contract / cron / subagent / assembly 4 模块同型扩散 / 推 r42 B 治理并轨
> - **B.p169-2/3 字符串字面量未抽 const**（r42 D fork 新发现）= **drift**：5 处 `'skills'` / `'dispatch-skills'` 散硬编码（registry.ts:27 / assemble.ts:172 / dispatch.ts:68 / contract/manager.ts:1328 / tests/helpers/runtime-deps.ts:46）/ 应抽 SKILLS_DIR_DEFAULT / DISPATCH_SKILLS_DIR / 推 r43+
> - **B.p344-skill-disp dispatch-skills 归属错配**（r42 D fork 新发现）= **drift**（应归 ContractRetro / 实然 SkillRegistry 承载 / 推 r43+ ContractRetro 落地后修）
> - **B.p344-skill-fb skill 工具 fallback tempRegistry**（r42 D fork 新发现）= **drift**（应然不该有 / skill.ts:40-54 应急创建）

#### B.p169-1 — `new SkillRegistry` 临时实例化 → **已闭环**（phase296 消化最后 2 处）

- **消化轨迹**：phase169 识别（4 处）→ phase177 daemon.ts 清零 → phase285 dispatch+skill 清零 → **phase296 contract/manager.ts + runtime-deps.ts 清零 = 全仓产品代码 0 处**
- **闭环后状态**：src/ 中 `new SkillRegistry` 仅余 `src/core/skill/index.ts:20`（工厂内部实现）；tests/ 中仅余 `tests/core/skill/registry.test.ts` ×13（单元测试直接测 class）——均合规
- **owner**：phase169 登记 / phase180 N1 订正 / phase289 评估修正 + drift 发现 / phase296 闭环

#### B.p169-2 — 字符串字面量 `'skills'` / `'clawspace/dispatch-skills'` 未抽顶层常量

- **现状**：§6.1 列 5 处字面量散在 registry.ts:25 构造默认 + assemble.ts:174 + tests/helpers/runtime-deps.ts:47 + dispatch.ts:65 + daemon.ts:179
- **为何合规**：字面量语义稳定（`'skills'` 在 clawforum 主 agent 语境下是约定）；当前无多处需要同步修改的需求，抽常量收益有限
- **owner**：phase169
- **计划 phase**：与 B.p169-1 同期（细化期统一抽 `SKILLS_DIR_DEFAULT` / `DISPATCH_SKILLS_DIR` 到 `src/core/skill/index.ts`）
- **升档条件**：出现第 6 处 / 或因 typo 导致 runtime bug → 转 7.A

#### B.p169-3 — `skillsDir` 默认值硬编码在构造函数

- **现状**：`registry.ts:25` `constructor(fs, skillsDir: string = 'skills')` 的默认值是参数级硬编码，而非引用 `SKILLS_DIR_DEFAULT` 常量
- **为何合规**：同 B.p169-2，抽常量未完成前硬编码是最低代价实现
- **owner**：phase169
- **计划 phase**：与 B.p169-2 同期
- **升档条件**：`SKILLS_DIR_DEFAULT` 抽出后本条一并消除 → 转 7.A → 改引用

### 7.C 原则对照

全 **32 条**覆盖（Module Logic 11 + Design 11 其中 #1 展 4 面 + Philosophy 4 + Path 6 = 32）。**2026-04-27 r42 D 结构合规修：29→32 补 Path 6**（同 l5_runtime / l6_daemon 同型 / 第 3 次实证 / 升格阈值大达）。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。职责 = 技能元信息注册表 + 渐进披露 + 上下文摘要生成；变更源（frontmatter 格式 / 扫描策略 / 渐进披露时机）与 L4/L5 其他模块不同
- **M2 业务语义归属**：合规。`loadAll` / `register` / `loadFull` / `getMeta` / `listMeta` / `formatForContext` 全由 SkillRegistry 发起；调用方不遍历 metaMap 自行格式化
- **M3 资源归属**：合规。`skillsDir`（skills/ 或 clawspace/dispatch-skills/）归 SkillSystem 独占；`skillsDir` 选择归调用方
- **M4 持久化**：合规。`skillsDir` 磁盘即权威；内存 `metaMap` 是派生态（§1 资源节）
- **M5 依赖单向 / 禁循环**：合规。L5 → L1 FileSystem / L2 parseFrontmatter（§4.4 合规表）；无上行依赖，publisher-subscriber 形态 B（§5.3）无代码依赖图循环
- **M6 依赖结构稳定**：合规。构造期 `fs + skillsDir` 两参数一次性注入，运行期不变
- **M7 耦合界面稳定**：合规。本 phase 仅加 `createSkillRegistry` 工厂（phase169 Step 5）不改 6 个公共方法签名
- **M8 耦合界面最小**：合规。6 方法按 5 组职责划分（§2.1）；`formatForContext` 收敛上下文注入格式为耦合窄化点（§5.3）
- **M9 显式表达编译器可检**：合规。`SkillMeta` / `FileSystem` / 工厂签名全 tsc 强类型；frontmatter `Record<string, unknown>` 是 structural 契约（MessageCodec 归属）
- **M10 不合理停下**：触发 1 次，详见 §7.Phase 纪律.1（Step 1 扫描发现总览 3 处事实错 → 停下回改总览 → Step 2 后续）
- **M11 边界不对停下**：未触发。SkillSystem 边界稳定

#### Design Principles（11 条；#1 展 4 面）

- **D1a 信息不丢失**：**合规**（phase180 §7.A1/§7.A2 全部清零 / `skill_load_failed` + `skill_duplicate_skipped` audit 双写；phase222 G3 Path #1 复核前进）
- **D1b 状态可观察**：合规。`listMeta` + `formatForContext` 任意时刻可查全量元信息
- **D1c 中断可恢复**：合规。skillsDir 磁盘是权威态，重启后 `loadAll` 重建 metaMap
- **D1d 事后可审计**：**合规**（phase180 §7.A3 清零 / `skill_registry_loaded` audit 集成 + `createSkillRegistry(fs, skillsDir, audit?)` 三参；phase222 G3 Path #1 复核前进）
- **D2 不得丢弃/静默**：**合规**（phase180 §7.A1/§7.A2 清零；同 D1a；phase222 G3 前进）
- **D3 用户可观察**：合规。`formatForContext` 输出在 system prompt 中可见
- **D4 LLM 调用恢复**：无关（SkillSystem 不涉 LLM 调用）
- **D5 日志重建**：**合规**（phase180 §7.A3 清零 / audit 事件足以重建 skill 加载链路 / magic skillsDir 磁盘内容 + SKILL.md 是权威态；phase222 G3 Path #1 复核前进）
- **D6 智能体决策主体**：无关（SkillSystem 是基础设施，非决策主体）
- **D7 系统可信路径**：合规。SkillRegistry 作为系统组件，调用方经受信注入消费
- **D8 事件驱动**：无关（SkillRegistry 无事件循环，是同步查询态服务）
- **D9 多 claw 不隔绝**：灰度。每个 claw 可有独立 `skillsDir`（主 claw `skills/` / motion `clawspace/dispatch-skills/`）；跨 claw 共享 skill 当前无设计（总览不纳入）
- **D10 motion 特殊**：合规。motion 走 `clawspace/dispatch-skills` 独立目录（`daemon.ts:179` / `dispatch.ts:65`）
- **D11 CLI 唯一对外**：无关（SkillSystem 是内部模块）

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规。`skillsDir` 子目录结构是典型目录驱动（§5.1）
- **P2 上下文工程**：合规。渐进披露（启动仅元 → 调用时加载完整）正是上下文经济的范例
- **P3 多 agent 利用**：合规。主 claw / motion 各自独立 skillsDir 表达 agent 能力差异
- **P4 系统为智能体服务**：合规。SkillSystem 提供决策所需信息（`formatForContext` 注入 system prompt）+ 工具 API（skill / dispatch）

#### Path Principles（6 待核 / 2026-04-27 r42 D 结构合规修：补完）

> Path 6 authoritative source 待核 / 暂列已知 4 + 待补 2

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase169/177/285/289/296/308 各 phase 起步 Path #1 复核 |
| Path #3 | 语义原子最小变更 | 合规 | B.p169-1 4 phase 接力（169/177/285/296）/ 每 phase 单一意图 |
| Path #6 | 冲突停 | 合规 | phase308 cross-layer-up 决策 / L2 非 L5 / 不强行迁 |
| Path #8 | 总难度最低 | 合规 | createSkillRegistry 工厂逐 phase 闭环 / 不 big-bang |

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#28（原 modules.md）SkillSystem 归 L2 基础设施**（2026-04-21 phase173）：SkillSystem 依赖只用 L1-L2（FileSystem + MessageCodec），被 L3-L6 广泛消费，实际依赖结构表明它是基础设施能力不是 L5"外壳"。**根本原则依据 M5**「依赖单向，底层不预设上层」——挪 L2 后消除 L4 TaskSystem / ContractSystem 原 L4→L5 反向依赖；附带消解 M2 违规（原"L3 tools 定义 `SkillLookup` 切断循环"让工具框架代 SkillSystem 定义对外语义，违反「模块为自己的业务语义负责」）

---

### 7.Phase 执行纪律

本 phase 实施过程中的非架构偏差登记（按 `feedback_module_contract_structure` §7.Phase 硬化规则）。

#### 纪律.1 — 总览 3 处事实偏差（Step 1 扫描捕获）

- **触发**：Step 1 扫描文档 F15 复核发现总览 3 处断言与实测不符：
  - `new SkillRegistry` 点 "2 处" → 实测 5 处（+dispatch.ts / skill.ts / tests/helpers）
  - `IGNORE_PATTERN 应导出` → 代码中**不存在** IGNORE_PATTERN 常量
  - 消费点 "14 处" → 实测 17 处
- **违反条款**：`feedback_verify_facts_before_plan`（清单性断言一律佐证）/ `feedback_self_audit_before_user_review`（落笔前自审缺）
- **纠错链路**：Step 1 F15 偏差清单 → Step 2 落笔前回改总览 §背景 / §原则对照 #3 / §不纳入 / §风险 / §不碰边界（5 处 Edit）
- **根因**：总览起稿时未跑 `grep -rn "new SkillRegistry"` + `grep "IGNORE_PATTERN"` 佐证即下断言
- **治理路径**：本 phase 已治理（总览回改 + Step 1 F15 登记）；元规则层面 `feedback_verify_facts_before_plan` 已覆盖"清单性断言一律佐证"

#### 纪律.2 — Step 分解重议（6→8 步）

- **触发**：Step 1 计划落笔时对比 phase166 同型经验（Step 2 "写契约" 单步 diff 远超 80 行），重分解总览 6 步 → 8 步（契约拆 §1-3 / §4-6 / §7-8 三步）
- **违反条款**：无（`feedback_step_granularity_sub_overview` 明示"总览 N 步是规划粒度；实施按单 commit 原子性拆"）
- **纠错链路**：Step 1 文首 §步骤重分解提议 → 用户确认 → 后续 Step 2-8 按细粒度推进
- **根因**：总览规划粒度（6 步）与执行粒度（8 步）定位不同；非错，是正常粒度精细化
- **治理路径**：已按 feedback 规范处理

#### 纪律.3 — D4 临时实例化决策升级（Step 1 捕获）

- **触发**：Step 1 F7 实测发现 `new SkillRegistry` 5 处而非总览预期 2 处；D4 决策从"默认 β 保留 daemon.ts 一处"升级为"β 保留 4 处（daemon + dispatch + skill + tests-helper）"
- **违反条款**：无（发现后按粗糙期原则"只归位主装配路径"处理，合规）
- **纠错链路**：F7 → D4 选 β → B.p169-1 登记 4 处统一治理 → 总览 §不纳入 扩展
- **根因**：总览低估 `new` 点数量（纪律.1 同根因）
- **治理路径**：已在 B.p169-1 统一登记，细化期统一改

#### 纪律.4 — 无 agent 越界 / 无纠错链路追加修

本 phase 无 agent 在产品代码加 test-aware fallback / 自主扩字段等越界；无 Step N → Step N-1 反向修补（纪律.1/.3 都是 Step 1 扫描阶段捕获，不是产品代码回滚）。

#### 纪律.5 — phase180 §7.A 4 条清零 + L5→L2 契约 rename（**2026-04-21 新增**）

- **触发**：phase173 决策 #28 承诺"phase17x+ 代码整理期重命名为 l2_skill_system.md"；phase180 作为细化期 A 类清零兑现
- **违反条款**：无（正向兑现）
- **动作**：
  - 代码：SkillRegistry constructor + createSkillRegistry 工厂扩 audit 可选参（破坏性 Path #4 论证）
  - audit：3 type 实装（`skill_load_failed` / `skill_duplicate_skipped` / `skill_registry_loaded`）
  - tests：registry.test.ts 新建 ≥ 12 it
  - 契约：rename l5_→l2_skill_system.md；modules.md 3 处引用同步；l6_daemon.md 1 处同步
- **治理路径**：本纪律登记即止；B.p169-1 剩余 4 处 `new SkillRegistry` 归各自模块细化期

### 7.Drift §编号漂移

| 位置 | 原引用 | 修正 | 原因 |
|---|---|---|---|
| §1 资源应然 | modules.md §13 | modules.md ~~§13~~ §12 | modules.md 序号重排（Tools 独立后 SkillSystem 从 §13→§12） |
| §6.2 归属登记应然 | modules.md §13 | modules.md ~~§13~~ §12 | 同上 |

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 已有 head split + § numbering drift 修正（§13→§12 / r32 D 已修）| 无需修正 |
| D2 | §24 引用 | modules.md §24 引用正确（ContractRetro）| 无需修正 |

## 8. 测试覆盖

### 8.1 行为覆盖

按 §2 公共方法 5 组归类：

- **initialization**
  - `loadAll` 空 skillsDir / 空目录 / 2 skill 正常 / 单技能失败：**直接覆盖**（registry.test.ts loadAll 4 it）
- **registration**
  - `register` 正常：**直接覆盖**（registry.test.ts register 1 it）
  - `register` duplicate：**直接覆盖**（registry.test.ts register 1 it + audit 断言）
  - `register` frontmatter 缺字段 fallback：**直接覆盖**（registry.test.ts register 1 it）
- **query**
  - `getMeta` / `listMeta`：**直接覆盖**（registry.test.ts query 2 it）
- **progressive disclosure**
  - `loadFull` 注册名 / 未注册名抛 ToolError：**直接覆盖**（registry.test.ts loadFull 2 it）
- **context injection**
  - `formatForContext` 空 / 非空：**直接覆盖**（registry.test.ts formatForContext 2 it）

### 8.2 §3 事件回链

| # | event type | 回链测试 | 覆盖 |
|---|---|---|---|
| 1 | `skill_load_failed` | registry.test.ts「单技能 register 失败」it | ✓ |
| 2 | `skill_duplicate_skipped` | registry.test.ts「duplicate 同名」it | ✓ |
| 3 | `skill_registry_loaded` | registry.test.ts「空目录 / 2 skill 正常」it | ✓ |
| 4 | `assemble_failed`（`module=skill_registry`，由 Assembly 发） | `tests/assembly/assemble.test.ts:740/748` | ✓ |

### 8.3 测试缺口说明

- `skill_loaded_full` 未实装 → 无测试（B 类候选）
- B.p169-1 4 处 `new SkillRegistry` 无 audit 路径未测（可选参向后兼容，行为等价）
