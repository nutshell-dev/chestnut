# SkillSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（own agent 工具的模块 / 5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2c.md](../interfaces/l2c.md) SkillSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §14「SkillSystem 本质：技能资源加载注册表服务 / L2 agent 语义基础设施 / 在 L1 FileSystem 之上把 skill 资源目录加载封装成可重用基础服务，渐进式披露（启动加载元信息，调用时加载完整内容）/ 知 agent 概念（skills 是 agent 能力）」加 M#1 / M#2 / M#3 / M#4 / Philosophy「上下文工程」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），SkillSystem 的单一职责 = **技能资源目录的统一加载入口加渐进式披露**：

- **skill 资源目录扫描加注册表构建**：扫 skillsDir 加载元信息构建 metaMap — 是 clawforum 「skill 资源唯一入口」（M#3 derive）。
- **渐进式披露**：启动仅加载元信息 / 调用方需要时才 load 完整 SKILL.md 内容 — 这是 Philosophy「上下文工程」derive（避免一次性 load 全部技能撑爆 LLM 上下文）。
- **上下文摘要生成**：本模块自治输出 string 格式（M#7 耦合界面稳定 derive — 调用方只消费 string，本模块内部聚合算法可变而不破坏调用方）。
- **磁盘即权威**：metaMap 是运行期派生态 / 重启后 loadAll 重建（D「磁盘即权威」derive）。
- **加载失败软处理**：duplicate 取先到者 + audit / 单 skill 解析失败 + audit + 继续（D「不丢弃 / 静默」derive — 不静默忽略）。

> 具体 API 形态归 [interfaces/l2c.md](../interfaces/l2c.md) SkillSystem 节。具体实现细节（getMeta / listMeta / loadFull / formatForContext / parseFrontmatter / Record schema 等）的存在依据是「资源目录扫描 + 渐进式披露 + 上下文摘要」原语 — 实然采纳的 method 集合差异加 user/system dir 区分等登记 §7.B。

### 不做

- **不 own 技能业务执行**（执行 / 沙箱 / 权限归各自工具层）— derive 自 M#1 + M#2
- **不 own skill 用途加触发判断**（哪个 skill 何时调用归调用方业务）— derive 自 M#2
- **不 own 上下文摘要的注入位置加渲染策略**（什么时候把 summary 拼到 prompt 哪段归调用方装配期决定）— derive 自 M#2
- **不 own agent 身份关联**（哪些 skills 属于哪个 agent 归调用方装配期决定 / 经 skillsDir 参数注入）— derive 自 M#2
- **不 own frontmatter schema 校验**（structural Record / 缺字段走默认 / 业务字段含义归调用方）— derive 自 M#1
- **不 own dispatch-skills 资源**（应然归 EvolutionSystem / dispatch 是 contract 业务概念）— derive 自 M#3 资源唯一归属
- **不 own hot-reload**（loadAll 后 metaMap 不动态删 / 重启即重建）— derive 自 M#4
- **不 own 跨进程并发协调**（每实例独立 metaMap）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），SkillSystem 的业务语义边界：

- **own**：技能元信息加载加聚合加渐进式披露概念。这些是 SkillSystem 唯一懂的「业务」（技能注册表级 / 不解读技能业务用途）。
- **角色定位**：SkillSystem 是「**通用技能资源加载注册表**」非「**技能业务执行器**」。本模块对所有技能等价处理 / 业务用途加触发判断归调用方。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），SkillSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<skillsDir>/` skill 资源目录（per-agent / 装配期注入 / 必填）| 持久化（独占 / 装配方 own dir 路径）| ✓ |
| metaMap 内存元信息表 | 派生态 | ✗ 重启 loadAll 重建 |

**skill 资源目录加加载机制** — clawforum 内部 skill 资源访问必经 SkillSystem 间接访问 / 是对 skills/ 目录这个 agent 能力库的唯一调用入口。

> 注：(1) 目录结构约定 = 每个子目录即一个技能 / 内含 `SKILL.md`（frontmatter + 完整内容）/ (2) **不 own dispatch-skills**（业务概念归 EvolutionSystem / phase411 const 物理迁 evolution-system/）/ (3) skillsDir 是构造期参数（不预设默认值 / phase370 闭环）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），SkillSystem 的持久化立场：磁盘上的 skills/ 目录是权威；本模块 metaMap 是运行期派生态 / 重启时 loadAll 从磁盘重建 / 无需自行持久化派生态。

### 磁盘布局

```
<skillsDir>/                   ← 调用方装配期传入
├── skill-name-1/              ← 一级子目录 = 一个技能
│   ├── SKILL.md               ← frontmatter + 完整内容
│   └── ...                    ← 技能资源（脚本 / 数据等）
├── skill-name-2/
│   └── SKILL.md
└── ...
```

### 文件格式

```
---
name: my-skill
description: One-line description
version: 1.0.0
---

(完整 markdown 内容 / loadFull 返回此整份)
```

### 重建语义

- **进程重启**：`loadAll()` 扫 skillsDir / 重建 metaMap
- **内存派生态**：metaMap 不持久化 / 磁盘 SKILL.md 是权威
- **runtime 只增不减**：loadAll 后 metaMap 不动态删除（technical：register 也只增）
- **`skillsDir` 不存在**：合法空集（静默 return）

## 5. 审计事件清单

事件常量**应然**集中定义于 `SKILL_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `skill_load_failed` | loadAll 单技能 register 抛出 | `skill_dir=`, `skills_dir=`, `err=` |
| `skill_duplicate_skipped` | register 同名 duplicate | `name=`, `existing_skill_dir=`, `attempted_skill_dir=`, `skills_dir=` |
| `skill_registry_loaded` | loadAll 正常出口（skillsDir 不存在的静默 return 不发）| `skills_dir=`, `count=` |

## 6. 层级声明

L2 基础设施（agent 语义子层）/ 技能元信息注册表 + 渐进披露原语。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A1 loadAll 扫描失败软吞 | drift | 已闭环（phase180）| `skill_load_failed` audit 双写 + console.warn |
| A2 register duplicate 跳过软吞 | drift | 已闭环（phase180）| `skill_duplicate_skipped` audit 双写 + console.warn |
| A3 SkillRegistry 无 audit 集成 | drift | 已闭环（phase180）| ctor 加 audit 可选参 + 3 type audit 实装 |
| A4 SkillRegistry class 无直接单测 | drift | 已闭环（phase180）| `tests/core/skill/registry.test.ts` ≥ 12 it |
| `new SkillRegistry` 临时实例化 | drift | 已闭环（phase296 / 4 phase 接力 169/177/285/296）| 仅工厂内部 1 处 + 测试 / 全产品代码 0 处 |
| ~~字符串字面量 `'skills'` / `'clawspace/dispatch-skills'` 未抽常量~~ | ~~drift / 中~~ | **✅ closed phase399**（main `d2217c66` / 跨 phase 接力 phase370 + phase399）| **phase370 闭环 4/5 prod caller**（assemble.ts + skill/index.ts + retro-scheduler.ts + task/tools/dispatch.ts + cli/motion.ts / NEW skill-paths.ts main `0e51e81`）/ **phase399 补 cli/commands/skill.ts L57+L71** + NEW `DISPATCH_SKILLS_SUBDIR='dispatch-skills'` + `DISPATCH_SKILLS_DIR` 改 template literal 派生 `${CLAWSPACE_DIR}/${DISPATCH_SKILLS_SUBDIR}`（CLAWSPACE_DIR 改名时自动同步 / typo 0 风险）/ phase380「同字符串 ≠ 同概念」实证（segment vs full path 立两 const / 与既有 BUNDLED_SKILLS_DIR_NAME vs SKILLS_DIR_DEFAULT 同型先例延续）|
| ~~`skillsDir` 默认值硬编码~~ ✅ closed | drift / 中 | **✅ closed**（phase370 / main `0e51e81`）| ~~ctor + factory `skillsDir: string = 'skills'`~~ → α 落地：ctor + factory 删 default value / caller 全显式传 const ref / 同 phase357 模板 / design L22 应然 align（skillsDir 必填）|
| ~~**dispatch-skills 归属错配**~~ | ~~drift / 应然层~~ | **✅ closed phase411**（main `07bc7e9f`）/ DISPATCH_SKILLS_SUBDIR + DISPATCH_SKILLS_DIR const 物理迁 `core/skill/skill-paths.ts` → `core/evolution-system/dispatch-skills-paths.ts` / caller (retro-scheduler / task/tools/dispatch.ts / cli/commands/skill.ts) import 改 / SkillRegistry 仍按 caller 显式传 skillsDir 加载 dispatch templates（dispatch templates 二级 registry 机制 phase382 framing） / 资源 const 归属归 EvolutionSystem own |
| ~~skill 工具 fallback tempRegistry~~ ✅ closed-overturn | drift 候选（推翻）| **✅ closed-overturn**（phase382 / Path #1 实测推翻）| ~~skill.ts:40-54 应急 `new SkillRegistry` 创建 / 应然不该有 / 应通过装配注入~~ — phase382 Path #1 实测推翻：实然位 `src/core/tools/builtins/skill.ts:39-57` / 用 `createSkillRegistry(ctx.fs, String(args.skillsDir))` 工厂调用（非 `new SkillRegistry`）/ 触发条件 = caller 显式传 `args.skillsDir`（如 `"clawspace/dispatch-skills"`）/ schema `:29-32` 文档明示「Pass "clawspace/dispatch-skills" for dispatch templates」/ 是 **dispatch templates 二级机制 / 显式设计** / 非应急 fallback / `:61-67` 装配未注入分支已显式 `success: false`（D2 合规）/ 见 `coding plan/phase382/overview.md` / dispatch table framing 推翻第 N+1 案 |
| **skill audit event 字符串硬编码（无 SKILL_AUDIT_EVENTS const）** | drift / 中 | **phase355 清零**（main `9a7aec2f5dcd52c814e81b0a18ac8b2cdb17eb2d`）| 3 caller 字符串硬编码 → SKILL_AUDIT_EVENTS const 引用 / src/core/skill/audit-events.ts NEW / M#9 编译期可查 / 字符串值完全等价 / 与 phase345/349 同模板（caller 风格并轨第 4 次复用）|
| ~~A.naming-1 code class 名 `SkillRegistry` ↔ 应然 `SkillSystem`~~ | naming + cross-layer drift / 大 | **✅ closed（phase420 / main `2b1f717c`）** | **应然权威 = architecture.md §14 + 表 1「SkillSystem」**。phase420 实施 3 阶段同 commit：(1) git mv `src/core/skill/{audit-events,index,registry,skill-paths}.ts` → `src/foundation/skill-system/`（4 files / 保 git history）+ rmdir 旧 dir (2) source rename `class SkillRegistry` → `SkillSystem` + `createSkillRegistry` → `createSkillSystem` (3) 20 caller files cascade：9 import path `core/skill/` → `foundation/skill-system/` + 48 `\bSkillRegistry\b` → `SkillSystem` + 12 `\bcreateSkillRegistry\b` → `createSkillSystem` / 0 行为改 / 1370+ 测试 PASS / **第 5 例 ShellTool-style naming drift 治理**（CommandTool→ShellTool / Audit→AuditLog ✓417 / FileWatcher@L2 ✓415 / ContractManager→ContractSystem ✓416 / SkillRegistry→SkillSystem ✓本 phase）/ 物理迁 + 工厂 + Assembly 三模板复合第 N+1 次（同 phase360 done / phase378 CommandTool / phase397 cleanup）|
| **A.spec-1 应然 method 名 `list/find/load/contextSummary` ↔ 实然 `loadAll/register/listMeta/loadFull`** | spec drift / 大 | **closed**（phase414c L2c audit / interfaces/l2c.md align 实然 method 名）| 历史 interfaces 写应然抽象 method 名 (`list()` / `find(name)` / `load(name): SkillContent` / `contextSummary()`) / 实然 method 名完全不同 (`loadAll()` / `register(skillDir)` / `listMeta()` / `loadFull(name): string`) / 应然层 4 method 100% drift / phase414c interfaces/l2c.md 修订 align 实然 method 名 + 实然 SkillMeta shape (`{name, description, version, skillDir}` 而非 `{source, fields}`) + 删 SkillContent 应然幻象 + 删 SkillSystemError 应然幻象 + 删 contextSummary 应然幻象（实然不存在 / 由 caller 自治拼接）|
| **A.tool-1 skill tool 物理迁** | location drift | **✅ closed（phase442 / main `fa8f3582`）** | 应然 = skill tool 业务依赖 SkillSystem + createSkillSystem / 归 SkillSystem owner（per arch 表 3 row 360 + phase360 done + phase416 memory_search + phase440 send 模板）。phase442 实施 4 阶段同 commit：(1) git mv `src/foundation/tools/builtins/skill.ts` → `src/foundation/skill-system/tools/skill.ts`（保 history）+ NEW dir `skill-system/tools/` (2) 内部 import path 修（SkillSystem `'../index.js'` 同 module / SKILL_TOOL_NAME `'../../tools/tool-names.js'` cross module）+ 加 `@module L2.SkillSystem` 注解 (3) builtins/index.ts 删 skillTool 3 处（import + re-export + register）(4) Assembly 显式 register + 1 caller test import path / 0 行为改 / 1370+ 测试 PASS / **业务工具归 owner module 第 4 实证**（phase360 done → ContractSystem + phase416 memory_search → MemorySystem + phase440 send → Messaging + 本 phase skill → SkillSystem）|
| **A.skill-audit-events-re-export-missing** | hygiene / 低 / r80 D fork phase 650 P2.14 浮出 / r83 C fork landing | ✅ **closed by phase 659（C fork r83 / commit `b8277902`）** | skill-system/index.ts barrel 仅 export `SkillSystem` + `SkillMeta` + `createSkillSystem` factory / 0 SKILL_AUDIT_EVENTS re-export / 既有 caller 直 import audit-events.ts / barrel 不完整 / phase 659 加 `export { SKILL_AUDIT_EVENTS } from './audit-events.js';` / **M#9 align**（barrel 完整化）/ 既有直 import caller 0 cascade（仅扩 barrel）/ micro-hygiene cluster batch N+1 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 保留 console.warn 双写（registry.ts:L56 + L84）| phase180 决策 / 双写运维即时见 | console 通道废止时一并清 |
| `loadFull` 无 audit 事件（应然 §5 silent / 实然 0 调用）| 细化期候选 / `skill_loaded_full` B 类未实装 | 出现需要追踪渐进披露的需求 |
| metaMap 只增不减 / loadAll 后无 hot-reload | 应然 silent / 重启即重建 | 出现 hot-reload 需求 |
| frontmatter 字段缺失走默认值（不告警）| 软校验 | 引入必填字段（如 category）|
| ~~dispatch-skills 仍走 SkillRegistry 管道~~ | ~~等 EvolutionSystem 落地~~ | ✅ phase411 EvolutionSystem 落地（main `07bc7e9f`）/ DISPATCH_SKILLS const 物理迁 evolution-system / SkillRegistry 仍是加载机制 / dispatch templates 二级 registry 机制延续（phase382 framing）|
| ~~`skillsDir` 默认值 `'skills'` 当前合理~~ ✅ phase370 升档闭环 / `skillsDir` 默认值硬编码 已治 / 应然 align | ~~~~ | ~~~~ |
| ~~**L2c.G1 (skill-system)** arch 表 2「上下文摘要生成」能力归属与 interfaces 缺对应 method~~ | **r65 cross-doc audit 浮出 / phase ε（2026-05-07）closed**：framing 推翻 / 实然 `SkillSystem.formatForContext()` (`registry.ts:170`) 真存在 / 3 caller（ContextInjector + retro-scheduler + dispatch）真用 / SkillSystem own format / **interfaces stale**（spec 应然 align 实然）/ arch 表 2 + 表 1 耦合实然 align | ✅ **closed by ε**：interfaces/l2c.md SkillSystem 加 `formatForContext(): string` method 暴露 / arch 不动（实然已 align）/ design only / 0 代码 / 反对 α 名错（实然 `formatForContext` 不是 `getContextSummary`）+ 反对 β 反 M#1+M#3（SkillSystem own format / ContextInjector 仅 caller）+ 反对 γ 反 M#11（spec stale 不显式登记）|
| ~~**L2c.G2 (skill-system)** arch 表 2「reload 触发 rescan」与 interfaces register(skillDir) 增量模式~~ | **r65 cross-doc audit 浮出 / phase ε（2026-05-07）closed**：framing 推翻（同 phase 458 STALE + l6_watchdog A.spec-2 同型）/ Path #1 实测核浮出：retro skill 实然走 **per-execution lazy load** 模式（dispatch + retro-scheduler 各 `createSkillSystem(...DISPATCH_SKILLS_DIR)` 临时 create instance / 不经 main skillRegistry）/ retro skill 写到 `clawspace/dispatch-skills/` 与 main SKILLS_DIR_DEFAULT 隔离 / EvolutionSystem.skillRegistry field declared 但 0 真调用 = dead field cluster（同 phase 426 ContractManager.retroScheduler 模板）/ `skill_system_reload_triggered` + `RETRO_RELOAD_FAILED` audit events + 'reload_failed' EvolutionError code 全 phantom | ✅ **closed by ε**：interfaces/l2c.md G2 closed 注 + arch 表 2 + modules/l4_evolution_system.md reload 协调 phantom 全清 / EvolutionSystem.skillRegistry dead field 推 r+1 code phase 顺手清 / design only / 反对 α 不全（仅改 arch 未清 dead field 群体）+ 反对 β 反 M#8（reload() = over-engineering / 0 caller）+ 反对 γ 反 M#11 |
| **dispatch templates 二级 registry 机制**（phase382 framing 修订入 §B）| 显式设计 / `builtins/skill.ts:39-57` 守卫 `args.skillsDir` 路径 / schema 文档明示「Pass "clawspace/dispatch-skills" for dispatch templates」/ caller 主动传 skillsDir 参数即创建临时 registry 加载该目录 / 注入路径（`skillTool.skillRegistry`）+ 二级路径并存 / 与 dispatch-skills 归属错配 应然层 drift 相关但路径独立 | 出现滥用案例（生产路径 caller 滥传非 dispatch 目录）→ 升档加 audit `skill_dispatch_template_load` + `skill_dispatch_template_load_failed` / 或 EvolutionSystem 落地后 dispatch-skills 归属修正 / 二级机制可同步重设计 |
| **L2c.G7 (skill-system)** createSkillSystem `audit?: AuditLog` optional DIP enforce | **业务决策性 design-gap / phase 664 P2.13 推后 / r88 C fork 复评**：createSkillSystem(fs, skillsDir, audit?: AuditLog) / 5 callers 全传 audit（assembly:211 + retro-scheduler:44 + dispatch:71 + tools/skill.ts:47 ×2）/ 4 × `this.audit?.write(...)` optional chaining / **optional 未被利用**（全 5 callers 都传 non-null）/ **应然多解**：α required AuditLog（M#5+M#9 显式依赖 / 但 0 实际 gain / 丢失测试弹性 / 3/5）/ β 保 optional（实然全传 / optional 保留弹性 / YAGNI / 4/5）/ **28 原则 cross-check β 4/5 dominant** / **推荐 β 保 optional / 待用户拍板** | **✅ closed by r88 C fork / β 保 optional**：原则指导 β 微 dominant / M#8+M#9 微偏 α required 但 gain≈0 / optional 是显式声明 非 hidden / 保留测试弹性 / 全 caller 已传 / 0 src 改 / 0 code phase |
| **tests fixture 'skills' / 'dispatch-skills' 字面值未抽 const** | fidelity 维度 / 测试用字面值表达独立 fixture 上下文 | ⚓ accepted-stable（phase399 / `feedback_test_fixture_fidelity` 反向：用 const 与产 const 同源 = shim 风险）| 升档：(a) 测试出现 typo 因路径不一致漏检的 silent breakage / (b) 产 const 改值时测试未同步发现 / (c) tests fixture const 化整体规范变更 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：技能元信息注册表 + 渐进披露 + 上下文摘要 / 与「技能业务执行」（各工具层）独立可变
- **M#2 业务语义归属**：6 公共方法全由 SkillSystem 发起 / 调用方不遍历 metaMap 自行格式化
- **M#3 资源归属**：skillsDir（per-agent skills/）归 SkillSystem 独占 / dispatch-skills 归 EvolutionSystem（phase411 const 物理迁闭环）
- **M#4 持久化**：skillsDir 磁盘即权威 / metaMap 派生态可重建
- **M#5 依赖单向 / 禁循环**：L2 → L1 FileSystem + L2 AuditLog（per arch §14 表 1）/ ~~实然另 dep src/foundation/frontmatter/ shared utility~~ ✅ closed by phase 461（main `c15333e9` / DELETE foundation/frontmatter/ + skill-system/registry inline 27 行 parser / DRY reflex 反例落地）/ 0 反向 / publisher-subscriber 形态 B
- **M#6 依赖结构稳定**：构造期 fs + skillsDir + audit 三参数 / 运行期不变
- **M#7 耦合界面稳定**：6 公共方法 + createSkillSystem 工厂稳定（phase420 SkillRegistry → SkillSystem rename）
- **M#8 耦合界面最小**：6 方法按 5 组职责 / formatForContext 收敛上下文注入格式
- **M#9 显式表达编译器可检**：SkillMeta / FileSystem / 工厂签名全 tsc 强类型
- **M#10 不合理停下** / **M#11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D2 不得丢弃/静默**：phase180 闭环 / 失败 + duplicate 全 audit
- **D1b 状态可观察**：listMeta + formatForContext 任意时刻可查全量元信息
- **D1c 中断可恢复**：skillsDir 磁盘是权威态 / 重启后 loadAll 重建 metaMap
- **D1d 事后可审计**：phase180 闭环 / 3 audit 类型覆盖加载链路
- **D3 用户可观察**：formatForContext 输出在 system prompt 中可见
- **D5 日志重建**：audit 事件 + skillsDir 磁盘内容 + SKILL.md 是权威
- **D7 系统可信路径**：SkillSystem 系统组件 / 调用方经受信注入消费
- **D9 CLI 唯一外部入口**：N/A（本模块 L2 内部基础服务 / 0 外部入口）
- **D10 多 claw 不隔绝**：灰度（每 claw 独立 skillsDir / 跨 claw 共享当前无设计）
- **D11 motion 特殊**：motion 走 `clawspace/dispatch-skills` 独立目录（phase411 const 物理迁 EvolutionSystem own / dispatch templates 二级 registry 机制 phase382 framing）
- **D4 / D6 / D8**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：skillsDir 子目录结构是典型目录驱动
- **P2 上下文工程**：渐进披露（启动仅元 → 调用时加载完整）正是上下文经济范例
- **P3 分多个智能体加分子任务**：主 claw / motion 各自独立 skillsDir 表达 agent 能力差异
- **P4 系统为智能体服务**：决策所需信息（formatForContext）+ 工具 API（skill / dispatch）

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase169 / phase173 / phase177 / phase180 / phase285 / phase289 / phase296 / phase308 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase169 SkillSystem 粗糙重构 / createSkillRegistry 工厂首次落地（L5 第 2 契约）
- phase173 决策 #28：L5 → L2 重分类
- phase180 §7.A 4 条全清零 + 契约 rename l5_→l2_skill_system.md
- phase177 / phase285 / phase296 `new SkillRegistry` 临时实例化 4 phase 接力闭环（4 处 `new SkillRegistry` → 0 产品代码）
- phase308 SkillSystem 死代码清理（L2 非 L5 / cross-layer-up 不成立 / 死字段清）/ main `aac4ee0`
- phase399 字符串字面量抽常量 跨 phase 接力闭环（phase370 + phase399）/ NEW `DISPATCH_SKILLS_SUBDIR` + `DISPATCH_SKILLS_DIR` template literal 派生 + cli/skill.ts 2 caller / phase380「同字符串≠同概念」实证 / template literal 派生 const 模式首发 / main `d2217c66`
- 2026-05-03 / phase411 dispatch-skills 资源归属错配 闭环（main `07bc7e9f`）/ DISPATCH_SKILLS_SUBDIR + DISPATCH_SKILLS_DIR const 物理迁 skill/skill-paths.ts → evolution-system/dispatch-skills-paths.ts / caller import 改 / 资源 const 归属归 EvolutionSystem own / 同 phase 与 l4_contract_system handleReviewRequest 拆出（候选 2+5 强耦合一次治理）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Module Logic 命名 M1-M11 → M#1-M#11 / Design Principles D9 N/A + D10「多 claw 不隔绝」+ D11「motion 特殊」编号修 align principles.md / §3 资源改 table 「skillsDir + metaMap」+ 注脚 / 头 docblock §10 声明 + §10 工具通道 skill 5 维度承诺新立 align arch 表 3 + phase442 闭环 / §M#2 §M#7 §D7 stale 「SkillRegistry」→「SkillSystem」 align phase420 后命名）
- 2026-05-03 / phase 414c interfaces L2c audit（A.spec-1 closed）：interfaces/l2c.md align 实然 method 名（loadAll/register/listMeta/loadFull）+ SkillMeta shape + 删 SkillContent/SkillSystemError/contextSummary 3 应然幻象 type
- 2026-05-04 / phase 420 SkillRegistry → SkillSystem rename + 物理迁 closed（main `2b1f717c`）/ git mv `src/core/skill/{audit-events,index,registry,skill-paths}.ts` → `src/foundation/skill-system/`（4 files / 保 history）+ class rename + factory rename + 20 caller files cascade（48 SkillRegistry → SkillSystem + 12 createSkillRegistry → createSkillSystem）/ 第 5 例 ShellTool-style naming drift 治理 / 物理迁 + 工厂 + Assembly 三模板复合第 N+1 次
- 2026-05-04 / phase 442 skill 工具物理迁 closed（main `fa8f3582`）/ git mv `src/foundation/tools/builtins/skill.ts` → `src/foundation/skill-system/tools/skill.ts` + NEW dir / Assembly 显式 register / 业务工具归 owner module 第 4 实证（phase360 done + phase416 memory_search + phase440 send + 本 phase）
- 2026-05-04 / phase 461 parseFrontmatter shared utility 推翻 + 4 caller inline parser（main `c15333e9`）/ DELETE `src/foundation/frontmatter/` + 4 caller (codec-inbox + inbox-writer + **skill-system/registry** + memory_search) inline 27 行 / 净 -84 行 / DRY reflex 反例落地实证 / §M#5 stale ⚠ → ✅ closed
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_skill_system.md vs arch §14 + 表 1/2/3 + interfaces/l2c.md SkillSystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7/D10/D11 + D4/D6/D8/D9 N/A + Philosophy P1-P4 / **P2 渐进式披露核心**+P4 决策所需信息 + Path #1-#7）/ 5 主能力 align arch 表 2 / 2 dep + 6 caller list align arch 表 1 / skill 工具 align arch 表 3 / 修 §7.C M#5 「foundation/frontmatter ⚠ STALE」→ ✅ closed by phase 461 / 补 phase414c+420+442+461 closure timeline entry / L2c.G1 上下文摘要生成能力归属 + L2c.G2 reload 触发 rescan 描述精度 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改
- 2026-05-10 / **phase 656 createSkillSystem skillsDir default value 删**（B fork r82 / commit main `642edc43` / merge `c036e72a`）/ phase 650 sub-4 P1.6 浮出 / Path #1 实测 4 caller 全 explicit pass（retro-scheduler + dispatch + assemble + skill.ts）/ 删 `skillsDir: string = SKILLS_DIR_DEFAULT` default / phase 370 design 立场兑现（§3 注 (3)「skillsDir 是构造期参数 / 不预设默认值 / phase370 闭环」）/ 1 src + 0 NEW const + 0 NEW field + 0 NEW test + 0 caller cascade / 0 行为差 / **「fan-out review → r+1 P1 cluster fix single phase」第 4 实证累**（phase 636+646+653+656 / 已立 feedback）
- 2026-05-10 / **phase 659 r83 C fork phase 650 14 P2 batch land L3 SKILL_AUDIT_EVENTS re-export**（C fork r83 / commit `b8277902`）/ skill-system/index.ts barrel 加 `export { SKILL_AUDIT_EVENTS } from './audit-events.js';`（barrel 完整化 / M#9 align）/ §A.skill-audit-events-re-export-missing closed by phase 659 / 1 src + 0 NEW + 0 caller cascade（既有直 import 不变）/ **「P2 batch land 模板 mix 多类 status」第 3 实证升格阈值达**（phase 648+656+659 / 推 Meta 45 升格独立 feedback）
- 2026-05-10 / **r88 C fork P2.13 SkillSystem audit?: AuditLog DIP 评估**（design only / 0 src / 起步 SHA `9ea2ee9f`）/ phase 664 推后 P2.13 / Path #1 实测 createSkillSystem 5 callers 全传 audit / 4 × `this.audit?.write(...)` optional chaining / optional 未被利用 / 28 原则 cross-check β 4/5 dominant（实然全传 / optional 保留弹性 / required gain 极小）/ §B NEW L2c.G7 row + 推荐 β 保 optional / 待用户拍板 / per `feedback_business_decision_phase_user_ratify`

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#28 SkillSystem 归 L2（M5 反向依赖消解 + M2 SkillLookup 切断循环消解）| ✓（phase173 决策 / phase180 契约 rename）|
| KD（应然）skillsDir 必填 / 不预设默认值 | ✅ phase370 闭环（`skillsDir` 默认值硬编码 / main `0e51e81`）|
| KD（应然）dispatch-skills 归 EvolutionSystem / 不经 SkillSystem | ⚠ dispatch-skills 归属错配 drift（实然 dispatch.ts 仍走 SkillRegistry）|
| KD（应然）字符串字面量抽常量 | ✅ phase399 跨 phase 接力闭环（phase370 4/5 prod caller + NEW skill-paths.ts main `0e51e81` / phase399 补 cli/commands/skill.ts L57+L71 + NEW DISPATCH_SKILLS_SUBDIR + template literal 派生 main `d2217c66`）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **loadAll 路径**：空 skillsDir / 空目录 / 2 skill 正常 / 单技能失败
- **register 路径**：正常 / duplicate / frontmatter 缺字段 fallback
- **query 路径**：getMeta 未注册 / listMeta 全部
- **loadFull 路径**：已注册 / 未注册抛 ToolError
- **formatForContext 路径**：空 / 非空
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言

> `skill_loaded_full` 未实装 / 无测试（B 类候选 / 细化期补）。

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile 准入+不变量）derive 自 architecture.md 表 3。
> SkillSystem own 的 agent 工具：skill（L2c / phase442 物理迁自 foundation/tools/builtins/）。
> **工具构造**：`createSkillTool(skillRegistry: SkillSystem): Tool` 工厂闭包（phase 533 / caller DIP enforce / 0 module-level mutable / deps 编译时必选）。

### 10.1 skill

**【1. 用途】**

> **技能完整内容加载通道** — agent 通过 skill 工具按 skill 名加载完整 SKILL.md 内容（渐进式披露 / 启动仅元 / 调用时加载完整 / Philosophy P2 上下文工程 derive）。

**【2. 入参 schema】**

```
- name        (string, required)   skill 名（meta 中已注册）
- skillsDir   (string, optional)   显式 dir / 默认走装配方注入的 SkillSystem 实例 / 传入即创建临时 SkillSystem 加载该目录（dispatch templates 二级 registry 机制 / phase382 framing）
```

**【3. 返回语义】**

```
ToolResult { success: boolean, content: string }
```

- 成功：`content` = 完整 SKILL.md 内容（frontmatter + body）
- 未注册：success=false / content = error message
- skillsDir 显式传但 dir 不存在 / load 失败：success=false + audit

**【4. 副作用 + 跨通道影响】**

- **0 副作用**：read-only / 0 fs 写 / 0 inbox / 0 LLM 调
- **跨通道**：经 ToolRegistry 注册（phase442 物理迁后归 SkillSystem own register）/ 工具调用 audit 由 L2 Tools 框架 `tool_exec` 覆盖 + 业务 `skill_load_failed`（loadFull 抛错时）

**【5. profile 准入 + 不变量】**

profile 准入：
- ✓ `full`（motion + claw 主代理）含 skill
- ✓ `subagent`（spawn 出的子代理）含 skill（subagent system prompt 指引 load 那个 recipe）
- ✗ `miner` / `dream` / `verifier` 不含

不变量：
- **read-only**：execute 0 修改任何 skill 资源 / 0 触发 reload
- **渐进式披露**：仅按需 load 完整内容 / 不预加载 / 与 formatForContext 上下文摘要互补
- **二级 registry 显式守卫**：caller 显式传 `skillsDir` 才创建临时 SkillSystem / 默认走装配注入实例（防滥用）
