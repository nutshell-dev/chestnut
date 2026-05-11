# SkillSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
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

- **skill 资源目录加加载机制**：clawforum 内部 skill 资源访问必经 SkillSystem 间接访问 — 是 clawforum 对 skills/ 目录这个 agent 能力库的唯一调用入口。
- **`skillsDir`**：构造期参数 / per-agent skills/ 目录（motion 加各 claw 各自）/ 调用方装配指定 / 不预设默认值。
- **目录结构约定**：每个子目录即一个技能 / 内含 `SKILL.md`（frontmatter + 完整内容）。
- **metaMap 运行期派生态**：内存 / 不落盘 / 重启重建。
- **不 own dispatch-skills**（业务概念归 EvolutionSystem）。

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

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 保留 console.warn 双写（registry.ts:L56 + L84）| phase180 决策 / 双写运维即时见 | console 通道废止时一并清 |
| `loadFull` 无 audit 事件（应然 §5 silent / 实然 0 调用）| 细化期候选 / `skill_loaded_full` B 类未实装 | 出现需要追踪渐进披露的需求 |
| metaMap 只增不减 / loadAll 后无 hot-reload | 应然 silent / 重启即重建 | 出现 hot-reload 需求 |
| frontmatter 字段缺失走默认值（不告警）| 软校验 | 引入必填字段（如 category）|
| ~~dispatch-skills 仍走 SkillRegistry 管道~~ | ~~等 EvolutionSystem 落地~~ | ✅ phase411 EvolutionSystem 落地（main `07bc7e9f`）/ DISPATCH_SKILLS const 物理迁 evolution-system / SkillRegistry 仍是加载机制 / dispatch templates 二级 registry 机制延续（phase382 framing）|
| ~~`skillsDir` 默认值 `'skills'` 当前合理~~ ✅ phase370 升档闭环 / `skillsDir` 默认值硬编码 已治 / 应然 align | ~~~~ | ~~~~ |
| **dispatch templates 二级 registry 机制**（phase382 framing 修订入 §B）| 显式设计 / `builtins/skill.ts:39-57` 守卫 `args.skillsDir` 路径 / schema 文档明示「Pass "clawspace/dispatch-skills" for dispatch templates」/ caller 主动传 skillsDir 参数即创建临时 registry 加载该目录 / 注入路径（`skillTool.skillRegistry`）+ 二级路径并存 / 与 dispatch-skills 归属错配 应然层 drift 相关但路径独立 | 出现滥用案例（生产路径 caller 滥传非 dispatch 目录）→ 升档加 audit `skill_dispatch_template_load` + `skill_dispatch_template_load_failed` / 或 EvolutionSystem 落地后 dispatch-skills 归属修正 / 二级机制可同步重设计 |
| **tests fixture 'skills' / 'dispatch-skills' 字面值未抽 const** | fidelity 维度 / 测试用字面值表达独立 fixture 上下文 | ⚓ accepted-stable（phase399 / `feedback_test_fixture_fidelity` 反向：用 const 与产 const 同源 = shim 风险）| 升档：(a) 测试出现 typo 因路径不一致漏检的 silent breakage / (b) 产 const 改值时测试未同步发现 / (c) tests fixture const 化整体规范变更 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：技能元信息注册表 + 渐进披露 + 上下文摘要 / 与「技能业务执行」（各工具层）独立可变
- **M2 业务语义归属**：6 公共方法全由 SkillRegistry 发起 / 调用方不遍历 metaMap 自行格式化
- **M3 资源归属**：skillsDir（per-agent skills/）归 SkillSystem 独占 / dispatch-skills 应然归 EvolutionSystem（dispatch-skills 归属错配 drift）
- **M4 持久化**：skillsDir 磁盘即权威 / metaMap 派生态可重建
- **M5 依赖单向 / 禁循环**：L2 → L1 FileSystem + L2 AuditLog（per arch §14 表 1）/ 实然另 dep src/foundation/frontmatter/ shared utility ⚠ STALE 推 r61+ 反向 design phase / 0 反向 / publisher-subscriber 形态 B
- **M6 依赖结构稳定**：构造期 fs + skillsDir + audit 三参数 / 运行期不变
- **M7 耦合界面稳定**：6 公共方法 + createSkillRegistry 工厂稳定
- **M8 耦合界面最小**：6 方法按 5 组职责 / formatForContext 收敛上下文注入格式
- **M9 显式表达编译器可检**：SkillMeta / FileSystem / 工厂签名全 tsc 强类型
- **M10 不合理停下** / **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D2 不得丢弃/静默**：phase180 闭环 / 失败 + duplicate 全 audit
- **D1b 状态可观察**：listMeta + formatForContext 任意时刻可查全量元信息
- **D1c 中断可恢复**：skillsDir 磁盘是权威态 / 重启后 loadAll 重建 metaMap
- **D1d 事后可审计**：phase180 闭环 / 3 audit 类型覆盖加载链路
- **D3 用户可观察**：formatForContext 输出在 system prompt 中可见
- **D5 日志重建**：audit 事件 + skillsDir 磁盘内容 + SKILL.md 是权威
- **D7 系统可信路径**：SkillRegistry 系统组件 / 调用方经受信注入消费
- **D9 多 claw 不隔绝**：灰度（每 claw 独立 skillsDir / 跨 claw 共享当前无设计）
- **D10 motion 特殊**：motion 走 `clawspace/dispatch-skills` 独立目录（dispatch-skills 归属错配 drift / 待 EvolutionSystem 修）
- **D4 / D6 / D8 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：skillsDir 子目录结构是典型目录驱动
- **P2 上下文工程**：渐进披露（启动仅元 → 调用时加载完整）正是上下文经济范例
- **P3 多 agent 利用**：主 claw / motion 各自独立 skillsDir 表达 agent 能力差异
- **P4 系统为智能体服务**：决策所需信息（formatForContext）+ 工具 API（skill / dispatch）

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

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
