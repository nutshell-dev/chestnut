# FileTool 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2c.md](../interfaces/l2c.md) FileTool 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §16「FileTool 本质：agent 文件工具服务 / L2 agent 语义基础设施 / 把『文件 I/O 能力 expose 给 agent』封装成可重用基础服务 / 知 agent 概念（agent 自由输入路径需 sandbox）」加 M#1 / M#2 / M#3 / M#5 / Philosophy「上下文工程」加「系统为智能体服务」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），FileTool 的单一职责 = **把 OS 文件 I/O 能力翻译为 agent 友好的工具调用**：

- **agent 文件工具集合**：read / write / search / ls 等 — 这是「文件 I/O expose 给 agent」业务概念。
- **上下文工程**（核心 / Philosophy 直接 derive）：read 输出 LINE / CHAR 截断加分页 / write 大小阈值约束 — 防 agent 上下文窗口被一次性大文件撑爆。
- **沙箱守护**：路径越界守护加权限域检查加 Motion 单向跨 claw 访问权 — 让 agent 自由输入路径不破坏 clawforum 安全边界。
- **agent UX**：结构化错误信息加 Tip 提示 — 帮 LLM 自纠（D「不丢弃 / 静默」derive）。
- **版本化备份**：write overwrite 自动备份到统一 sync 目录 — 防 agent 误删（事后可审计 derive）。
- **错误统一转 ToolResult**：任何错误转结构化 `ToolResult { success: false, content }` 不抛框架边界（M#10 derive）。

> 具体 API 形态归 [interfaces/l2c.md](../interfaces/l2c.md) FileTool 节。具体实现细节（路径根 = `<clawDir>/clawspace/` 加 backup 路径 = `clawDir/tasks/sync/` 加截断阈值常量加 edit / multi_edit 设计中等）的存在依据是「OS 文件 I/O 翻译为 agent 工具」原语 — 实然采纳的细节差异加 sync dir 共享约定等登记 §7.B。

### 不做

- **不 own OS 文件 I/O 能力原语**（read / write / list 等归 L1 FileSystem）— derive 自 M#1 独立可变职责 + M#5 单向依赖（业务模块不直接 import OS API）
- **不 own 工具注册加派发加超时加 tool_exec audit**（归 L2 Tools 框架）— derive 自 M#1
- **不 own caller 权限策略**（哪个 caller 能用 FileTool 归 L6 Assembly 装配期）— derive 自 M#5
- **不 own 工具 schema 协议**（归 L2 ToolProtocol）— derive 自 M#1
- **不 own LLM 调用编排**（tool_use 解析加调度归 L3 StepExecutor）— derive 自 M#1
- **不 own 业务语义解读**（什么算「该读的文件」由 agent 决策）— derive 自 M#2
- **不 own 跨 claw / 跨 clawDir 内部访问**（跨 claw 走 CLI / 跨 clawDir 内部归系统信息通道）— derive 自 M#1 + M#5
- **不 own 上下文 budget 加截断阈值常量来源**（READ_MAX_LINES / WRITE_SIZE_LIMITS / 版本保留份数等归 L6 Assembly 装配期 own 加注入）— derive 自 M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），FileTool 的业务语义边界：

- **own**：「OS 文件 I/O 能力翻译为 agent 工具调用」业务语义 — 含上下文工程加 agent UX 加沙箱约束加版本化备份。这些是 FileTool 唯一懂的「业务」（agent 文件工具级）。
- **角色定位**：FileTool 是「**agent ← OS fs 翻译层**」非「**通用文件操作库**」。专为 agent 自由输入路径设计 / 不可信输入翻译为受限 OS 调用。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），FileTool 独占的资源：

- **agent 文件工具的 schema + execute 实现**：clawforum 内部 agent 的 read / write / search / ls 工具调用必经 FileTool 实现 — 是 clawforum 对「agent 文件工具」概念的唯一定义点。
- **路径根**：`<clawDir>/clawspace/` 装配期 clawDir 注入 / 运行期不变 / claw 完全 own 该目录读写权。
- **写入装配方注入的 syncDir**：write overwrite 备份落 `<syncDir>/<id>` / syncDir 路径由调用方装配期注入 / 本模块不 own 该目录 lifecycle / 清理归 Snapshot 触发（同 CommandTool 共用 scratch space / 两工具皆为写入方非 owner / 路径约定 + lifecycle 归装配方）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），FileTool 自身的持久化立场：

- **模块零状态**：FileTool 不持自有运行时状态 — 工具执行无状态（每次 execute 独立）。
- **write overwrite 备份**：备份文件持久化到装配方注入的 syncDir / turn-scoped / 清理归 Snapshot（commit 成功后清空整个 syncDir / crash recovery 持续到 recovery-snapshot commit 成功后再清）/ 本模块仅写入不 own lifecycle — 让「事后可审计」加「中断可恢复」前提成立。

## 5. 审计事件清单

> 事件常量集中定义于 `FILE_TOOL_AUDIT_EVENTS`（模块自治）。

应然：本模块不直接产 audit 事件 —— 通用执行事件由 L2 Tools 框架的 `tool_exec` 覆盖。

如未来需要业务事件（候选）：

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `file_tool_scope_denied` | 越界拒绝（candidate） | `{ tool, path, allowedRoots }` |

升档条件：观察到越界拒绝在生产中无声发生 / 难诊断时新增。

## 6. 层级声明

L2 基础设施（agent 语义子层 / 含 agent 业务概念）。下游 L3+（StepExecutor / AgentExecutor / SubAgent / Gateway）通过 ToolRegistry 间接消费 / 不直接 import。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 模块物理不存在~~ | structural drift / 高 | **✅ closed（phase428 / main `e8dd251b`）** | 应然独立目录 + `createFileTools` 工厂。phase428 实施 4 阶段同 commit：(1) git mv 4 tool files `src/core/tools/builtins/{read,write,search,ls}.ts` → `src/foundation/file-tool/`（保 history）(2) 4 file 内部 import path 修（dir 深度 3→2 级 / Tool/ToolResult/ExecContext 仍跨 import core/tools/executor.js / ToolProtocol cross-layer drift cascade / 推 r+1 治理）(3) NEW `src/foundation/file-tool/index.ts` 含 `createFileTools(options): Tool[]` 工厂 + `FileToolOptions` interface 占位 (4) builtins/index.ts 删 4 import + 4 register + 4 re-export（保 statusTool/sendTool/skillTool）+ assemble.ts 加 `createFileTools({})` register loop（同 phase378 模式）+ 3 测试 import path cascade / 0 行为改 / 1370+ 测试 PASS / **应然位置 align L2 = `src/foundation/`**（与 phase420/423/425 一致 / 不用本条原文 `src/core/file-tool/` / Path #1 实证纠正）/ **scope 收紧**：allowedRoots 配置 + 公共越界 helper（A.2 cascade）推 r+1+ 业务决策 |
| A.2 路径权限域策略碎片化 | semantic drift / 高 | open / Stage 2 | 应然：统一 `allowedRoots` 注入（M#7 耦合界面稳定 + M#11 边界对不上停下）/ 实然：每工具自治异构策略 —— `read.ts:16` 黑名单 `READ_BLOCKLIST=['logs/']` / `search.ts:15` 白名单 `SEARCH_ALLOWLIST=['clawspace/','skills/','prompts/']` / `ls.ts` 无路径白/黑名单 / `write.ts` 仅 size limit 无路径守护 / 与 A.1 同步治理 |
| A.3 ctx.fs 与 fsNative 双轨 | dependency drift / 中 | open（设计意图 / 须显式登记） | 应然：通过 L1 FileSystem 接口注入（M#3 资源唯一归属 + M#5 依赖单向）/ 实然：`read.ts:107` `search.ts:42,50,125-126,139` `ls.ts:77,80` 直 import `fsNative` 绕 ctx.fs 层 / 注释显式声明「Motion 跨 claw 访问刻意绕权限层」/ 候选治理：把跨 claw 访问能力下沉为 FileSystem L1 第二能力 `readCrossScope(clawId, path)` 而非工具直引 fsNative |
| ~~A.4 read / ls supportsAsync 过度准入~~ | ~~scope drift / 低~~ | **✅ closed（phase400 / main `3ed32b82`）** | 应然权威单源 = l2_command_tool §10.6（C 类 sync-only / 14 工具三分类）/ 实施：read.ts:61 + ls.ts:38 `supportsAsync: true` → `false`（同根 l2_tools §A.X-2 status 同 phase 治）/ 同根 drift 跨视角对齐模板首次实施期复用（Meta 31 立 feedback 升格后 / 元复利验证）/ design+code 单 phase 内联动模板第 2 实证（phase397 首发）|
| A.5 write overwrite 不强制 fully-read-before | semantic drift / 高 | open | 应然 §10.2.6：`mode='overwrite'` 触发时检查 path 是否在当前 session 已 **fully-read** 集合 / 不在则拒绝。fully-read 判据：read 未被截断（行+字符双层）/ partial 不算 / append 写不入集合 / overwrite 写入集合。`tasks/sync/` 事后保险 ≠ 事前知情。实然 `write.ts` 完全不检查 / agent 可拍脑袋 overwrite 任意文件。修复：(1) ExecContext 加 session-scoped `fullyReadPaths: Set<string>` / read 工具成功且未截断时 add / overwrite 写成功时 add（**append 不 add**）/ (2) write.ts mode='overwrite' 检查 path ∈ fullyReadPaths（文件存在前提下）。派生：main claw 大文件 overwrite 自然引导 spawn subagent + edit/multi_edit。源：r53+ §10.2 用户驱动决策（「.versions 兜底没有用」+「append write 完不表明知道全文」+「partial read 不够」三层精修）|
| A.6 write description 量化数字 + 实然有 size limit + .versions per-dir | semantic drift / 中 | open | 应然 §10.2：write 不内置 size limit（单次 content 由 LLM max_tokens 自然限）/ description 不写量化数字（防双源 drift）。备份位置应然 = `clawDir/tasks/sync/` + frontmatter 格式（详 §10.2.6+）/ turn-scoped lifecycle / 不需 keep N。实然 `write.ts`：(a) 既有路径前缀差异化 size limit + description 字面写「Size limits: MEMORY.md 50/200KB ...」/ 双源数字 / (b) per-dir `.versions/` 备份（散落各目录 / 应然集中 tasks/sync）/ (c) keep 10 同步清理 / 应然 turn-end 清空整 tasks/sync。修复：(1) 删 size limit 实然代码 + description 删数字 / (2) 备份位置改 clawDir/tasks/sync/ + 改 frontmatter 格式 / (3) 删 keep N 同步清 / 改 Snapshot commit hook 清整 dir / (4) crash 持续到 recovery-snapshot 后清 |
| A.7 edit / multi_edit 工具实然不存在 | feature gap / 中 | open（设计中 / 暂不实现）| 应然 §10.5 + §10.6：subagent profile 提供 edit + multi_edit 工具（str_replace 唯一匹配 / replace_all 显式 / `clawDir/tasks/sync/` 自动备份 / multi_edit 顺序应用 + 全量回滚 + 单次备份）。实然两工具均不存在 / subagent 想精修文件只能 read+write 全文（非局部 / token 浪费 + 全文备份冗余）。修复路径推 r53+ 实施 phase / 同 §A.1 治理（file-tool 模块物理化时一并加） |

A.1 + A.2 修复路径（合并独立 phase）：
1. 物理迁 `src/core/tools/builtins/{read,write,search,ls}.ts` → `src/core/file-tool/`
2. 抽 `createFileTools({ fs, allowedRoots })` 工厂 + 公共越界守护 helper（吸收当前 read 黑名单 / search 白名单为 `allowedRoots` 配置）
3. Assembly 装配点改 `createFileTools` + 注册 4 工具
4. modules.md 依赖图 + L2 Tools §7 同步去 builtins/
5. 测试位置 `tests/core/builtins.test.ts` 拆 `tests/core/file-tool/{read,write,search,ls,scope}.test.ts`

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| search 静默吞 readFile 错误 | `search.ts:46-60` `try { readFile } catch { onSkip() }` / D2「未经显式决策不丢弃」候选违反 / 实然单测覆盖 0 行报告 | 若生产中 search 命中数偏低难诊断 → 升 §A / 至少改为可观察的「skipped count」附在 ToolResult |
| write 静默吞 version cleanup 错误 | `write.ts:46-64` 版本清理失败 silently ignore | 若磁盘累积大量未清理 backup → 升 §A |
| audit 上下文有 writer 但工具不用 | `executor.ts:79` 注入 `auditWriter?: Audit` / 4 工具 0 调用 / 框架层 `tool_exec` 兜底 | 若需 `file_tool_scope_denied` 等业务事件 → §5 候选事件升档（与本条同步） |
| **clawspace 总占用限制完整 design** | design-gap / 不影响当前使用 | 原始设计文档 vision「软限制（提醒清理）/ 硬限制（拒绝写入）」未落地。完整 design 涉及多个互相关联的 sub-problem，需作为一个 unit 后续讨论：(1) 监测策略 = 实时（write 时扫）vs cron 周期 vs 增量缓存（性能 vs 准确性 trade-off）；(2) enforce 责任 = FileTool（业务语义本质 / M#2）；(3) 通知通道 = 软超 → claw inbox（agent 自治清理）/ 硬超 → 用户 outbox（失控兜底）；(4) **delete 不需专门工具**：agent 用 `exec 'rm -f <path>'` 即可（idempotent / cwd 默认 clawspace 自然范围限制 / AGENTS.md 教学不冲突）/ 撤回先前「缺 delete 工具」误判；(5) write_backups（已迁 `clawDir/tasks/sync/`）turn-end 清空 / 不再存在「自身是否计入占用」问题；(6) 配置 = clawforum.yaml + per-claw override（motion 可能需要更大空间）。升档条件：clawspace 占用频繁导致问题 / 或正式多 claw 长跑场景出现磁盘紧张。**当前用法下不阻塞使用 / 推后续独立 design phase** |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：「agent 操作文件系统」语义独立 / 不与其他工具共变
- M#2 业务语义归属：越界守护 + 路径权限域归本模块（不下沉 L1）
- M#3 资源唯一归属：本模块无资源；fs 资源归 L1
- M#4 持久化：无状态 / 不涉及
- M#5 依赖单向：L2 → L1 FileSystem + L2 ToolProtocol（Tool / ToolResult schema）（per arch §16 表 1）/ 不上引 L3+ / 不直 dep L2 Tools 框架（由 Assembly 装配期 register 进 ToolRegistry）
- M#6 依赖结构稳定：装配期固化 `allowedRoots` / 运行期不变
- M#7 耦合界面稳定：4 工具对象 + Tool 协议为对外表面
- M#8 耦合界面最小：跨边界只传 `{ path, content?, pattern? }` / 不暴露内部 helper
- M#9 显式编译器可检：所有签名 type-only / 越界拒绝走类型化 ToolResult
- M#10 不合理停下：工具边界吸收 fs 错误 / 不让原生异常逃逸框架
- M#11 边界对不上停下：发现 `allowedRoots` 不足以表达权限域时停下重构（不在工具内 ad-hoc 加白名单）

**Design Principles**

- D1 (信息不丢失 / 状态可观察 / 中断可恢复 / 事后可审计)：tool_exec 框架审计覆盖；越界拒绝走 ToolResult 留痕
- D2 (无显式决策不丢弃)：所有 fs 错误转 ToolResult / 不静默吞
- D8 (CLI 唯一入口)：本模块不与外部交互 / 全经 Tools 框架
- D11 (motion 单向访问)：`allowedRoots` 配置允许 motion 装配方注入 motion 域 + 其他 claw 域

**Philosophy**

- **P1 Agent 即目录**：路径根 `<clawDir>/clawspace/` 是 agent 文件操作目录锚点
- **P2 上下文工程**：**核心驱动**（read 截断分页 + write 大小约束 + 兜底落盘 / 防 agent 上下文窗口被一次性大文件撑爆）
- **P3 分多个智能体加分子任务**：edit / multi_edit 给 subagent 局部修改 / main claw 大文件 overwrite 自然引导 spawn 子代理
- **P4 系统为智能体服务**：把 OS 文件 I/O 复杂度收敛到工具边界 / agent 看简单语义

**Path Principles**

- 实然为唯一基准：§7.A 修复 phase 必先 Path #1 核 builtins/ 现状
- 反向测试：工具实现可独立换 fs 实现而不动 caller —— M#1 ✓

### 7.D 历史纪律

- 2026-04-26 / r31 新建模块契约（应然 / 实然 split）
- KD#27 业务语义按 α.1 决策声明归 FileTool 模块（modules.md 决策映射）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#27 | Tools 声明式归属（read/write/search/ls 归 FileTool / 与 CommandTool / Messaging tools 平行） | A.1 待物理落地 / 应然契约一致 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- read：正常读 / 越界拒绝 / ENOENT / offset/limit 截断 / 单行巨大场景
- write：原子写 / append vs overwrite / 备份到 `clawDir/tasks/sync/<id>` / 父目录不存在自动创建
- search：内容 + 文件名 unified / case sensitivity 切换 / 截断 metadata
- ls：单层平铺含详细信息 / recursive 树形不带详细信息 / includeHidden 切换
- scope：所有工具路径必相对 clawspace 根 / 越界统一拒绝
- `createFileTools` 工厂注入双侧契约（fs / clawDir）
- 审计回链：每次 invoke 触发框架 `tool_exec`（由 L2 Tools 套件覆盖）

## 10. 对智能体的承诺（agent-facing 工具通道）

> 本节是「6 通道 / 工具通道」对 agent 的应然承诺：模块通过 ToolRegistry 暴露给 agent 的工具 / agent 看 schema description 决策怎么用。
>
> 5 维度：用途 / 入参 / 成功返回 / 副作用 + 跨通道影响 / profile 准入 + 不变量。
>
> 失败语义留全工具集统一深度讨论后再落地（错误文本 keyword 表归属待定）。

### 10.1 read

**【1. 用途】** 读自己 clawspace 内文件文本内容。

**【2. 入参】**
- `path`        (string, required)   相对 clawspace 的路径
- `offset`      (number, optional)   起始行（1-based；负数从末尾倒数：`-1` 末行 / `-N` 倒数第 N 行；不传默认 1；**0 非法**）
- `limit`       (number, optional)   最大行数

**【3. 成功返回】**
- 文件文本内容
- 触发工具内部上限时截断 / 尾部嵌入 metadata：
  - 行数超限：`Showing lines 1-N of M. Use offset=N+1 to read more`
  - 字符超限（普通）：`Showing first N of M chars. Use offset/limit to read more`
  - 字符超限（单行巨大 / line offset 无能为力）：`Showing first N of M chars. Single line exceeds limit; use search to locate specific content.`

**【4. 副作用 + 跨通道影响】** 无 / 完全只读。

**【5. profile 准入 + 不变量】**
- profile：所有 profile（read 是普适只读能力）
- readonly: true / idempotent: true（fs 状态不变下）
- 工具执行不响应 abort（abort 在 LLM 输出阶段处理）
- 可并行（framework 走 readonly+sync 批量并发）

### 10.2 write

**【1. 用途】** 原子写入自己 clawspace 内文件。

**【2. 入参】**（mode 放 content 前 / 防 LLM 输出长 content 后忘记 mode）
- `path`        (string, required)   相对 clawspace 的路径
- `mode`        (string, optional)   `'append'`（默认 / 安全 / 既有内容不动）/ `'overwrite'`（显式覆盖原内容）
- `content`     (string, required)   写入内容

**【3. 成功返回】**
- 写入字节数
- mode='overwrite' 返回备份路径（`tasks/sync/<id>` / 跟 write 工具 §10.2.6 备份机制同型）
- mode='append' 无备份（既有内容未动）

**【4. 副作用 + 跨通道影响】**
- overwrite：自动备份原文件 → `clawDir/tasks/sync/<id>` → 覆盖
  - **位置**：`clawDir/tasks/sync/`（跟 CommandTool exec_overflow 共用 dir / sync 工具副产物统一存储 / 装配-level 约定不归 TaskSystem own）
  - **文件命名**：`<id>` 无扩展名 / `<id>` = ISO 8601 UTC + 短 random（例 `2026-04-30T14-30-12Z-a3f2`）/ 单层 dir / 无 collision
  - **文件格式**：YAML frontmatter + 原 content（length-prefix 防 collision）：
    ```
    ---
    source: write_backup
    original_path: notes/foo.md
    ts: 2026-04-30T14-30-12Z
    content_length: <bytes>
    ---
    <原文件 byte-perfect 内容 / 不依赖 frontmatter 闭合 `---` 判结束 / 靠 content_length>
    ```
    - frontmatter 内 `source: write_backup` 标识类型（区分 exec_overflow）
    - `content_length` 字段防 frontmatter 嵌套歧义（原文件可任意以 `---` 起 / 不影响解析）
    - 跟 exec_overflow 同型 frontmatter（统一 sync 工具副产物格式）
  - **生命周期**：turn-scoped / Snapshot commit 成功后清空整个 `clawDir/tasks/sync/`（前一 turn 的 sync 副产物已被 git 覆盖 / 无需保留）
  - **不需要 keep N 上限**：turn 内 overwrite 次数自然受 max_steps 钳制 / turn 结束清 / 累积可控
  - **crash recovery**：tasks/sync/ 持续到 recovery-snapshot commit 成功后再清（保留中间 turn-internal 状态可恢复）
- append：追加到文件末尾 / 既有内容完整不动
- 原子写（temp+rename / 崩溃不留半文件 / 完整写完或完全没动）
- 不存在路径两模式都创建（含父目录自动 ensureDir）
- 不内置 size limit（单次 content 大小由 LLM max_tokens 自然限）

**【5. profile 准入 + 不变量】**
- profile：full / subagent / miner / 不在 readonly / dream / verifier
- readonly: false
- idempotent: append=true（同 content 累积）/ overwrite=false
- 原子操作 / 工具执行不响应 abort
- 不可并行（同文件写冲突）

**【6. overwrite 强制 fully-read-before（design 锚点）】**

`mode='overwrite'` 触发时 / 系统检查 path 是否在**当前 session 已 fully-read 集合**：
- ✗ 文件已存在 + path 不在已 fully-read 集合 → 拒绝 + `Error: Read the file (fully) before overwriting; you must see all existing content to confirm overwrite intent.`
- ✓ 文件不存在 → 跳过检查（overwrite 等同 create / 无内容可丢）
- ✓ path 在已 fully-read 集合 → 正常执行
- ✓ 同一 session 内 **overwrite 写**后再 overwrite 同 path → 视为已 fully-read（写完知道全文）

**fully-read 判据**（只 fully read 才入集合 / partial 不入）：
- ✓ read 工具返回**未被截断**（行 + 字符两层都不截 / metadata 无 `truncated` 标记）
- ✗ offset/limit 切到子区间 → partial / 不入
- ✗ 即使 offset/limit 未传 / 但文件超阈值被截 → partial / 不入
- ✗ search / ls 不入（不展示内容全文）

**write 隐含 read 的边界**（append vs overwrite）：
- ✓ overwrite 写完 → path 入已 fully-read 集合（agent 写的就是新全文）
- ✗ append 写完 → path **不入**集合（append 不暴露既有内容 / agent 仍不知道既有部分）

设计意图：
- `tasks/sync/` 是**事后回滚保险** / 不是**事前知情保险**：agent 没 read 过根本不知道丢了什么 / 不会想去查备份
- 强制 fully-read-before = 让 agent 看见全文才能覆盖（事前知情）
- partial read 不够：覆盖时被替换的内容可能跨越 agent 没看到的区间 / 等同没看
- append 模式不强制（不丢内容 / 风险低）
- session scope（claw 当前会话内 / 跨 turn 持久 / 重启清）/ 不是单 turn（太严）/ 不是 lifetime（太宽）
- 不区分 main claw / subagent profile（一视同仁）

**派生设计影响**：
- main claw 想 overwrite 大文件（超 read 阈值）→ 单次 read 不够 fully-read / 自然引导 spawn subagent + edit/multi_edit 局部修改（避开 overwrite 全文）
- 这跟「main claw 不给 edit / 复杂修改 spawn 子代理」的工具集策略自洽 cascade

### 10.3 search

**【1. 用途】** 在自己 clawspace 内搜索内容 + 文件名（unified / 一次搜两类）。

**【2. 入参】**
- `pattern`        (string, required)    搜索字面 substring（不支持 regex）
- `path`           (string, optional)    限定子目录（不传 = 整个 clawspace）
- `caseSensitive`  (boolean, optional)   默认 false（case-insensitive 友好）/ true 严格匹配

**【3. 成功返回】**

分段输出：
- `[Filename matches]`：path 列表（相对 clawspace）
- `[Content matches]`：按 file 分组 / 每个 file 列「行号: 行内容」（1 行上下文）
- 双重命中（文件名 + 内容同时含 pattern）：列两次 / agent 看高相关
- 触发上限时尾部 metadata：`(N filename matches, M content matches; truncated, narrow pattern to see more)`

格式示例：
```
[Filename matches]
- notes/foo-list.md
- refs/foo-doc.md

[Content matches]
notes/baz.md
  42: ... foo bar baz ...
  78: another foo line

refs/qux.md
  13: do foo

(2 filename matches, 3 content matches)
```

行号 1-based / 跟 read 的 offset 一致 / agent 直接 `read(path="notes/baz.md", offset=42)` 续读。

**【4. 副作用 + 跨通道影响】** 无 / 完全只读。

**【5. profile 准入 + 不变量】**
- profile：所有 profile（readonly / 普适）
- readonly: true / idempotent: true（fs 状态不变下）
- 工具执行不响应 abort（搜大库慢但不打断 / 上限保护）
- 可并行

### 10.4 ls

**【1. 用途】** 列出自己 clawspace 内目录条目。

**【2. 入参】**
- `path`           (string, optional)    相对 clawspace 的目录（不传 = clawspace 根）
- `recursive`      (boolean, optional)   默认 false / true 递归列子目录树
- `includeHidden`  (boolean, optional)   默认 false / true 含 `.` 前缀文件

**【3. 成功返回】**

非递归（默认）：平铺 list / 含详细信息
```
notes/         dir       -      2026-04-28 12:34
config.yaml    file      512    2026-04-27 18:00
README.md      file      1024   2026-04-27 18:00
```

recursive=true：树形 / 不带详细信息（避免大目录撑爆 context）
```
├── notes/
│   ├── foo.md
│   ├── bar.md
│   └── refs/
│       └── doc.md
├── config.yaml
└── README.md
```

空目录返回 `(empty)` 标记 / 触发上限时尾部 metadata：`Showing first N entries. Use path= to narrow scope.`

**【4. 副作用 + 跨通道影响】** 无 / 完全只读。

**【5. profile 准入 + 不变量】**
- profile：所有 profile（readonly / 普适）
- readonly: true / idempotent: true
- 工具执行不响应 abort / 可并行

### 10.5 edit【设计中 / 暂不实现】

> **派生场景**：main claw spawn 子代理 / 子代理用 edit 精确局部修改 / 主 claw 节省上下文。
>
> **业界最佳实践**：str_replace + 唯一匹配（Anthropic Claude Code text_editor / Claude.ai built-in editor 同形态）。

**【1. 用途】** 精确替换自己 clawspace 内文件中的指定字符串（局部修改 / 节省上下文）。

**【2. 入参】**
- `path`         (string, required)    相对 clawspace 的路径
- `old_string`   (string, required)    要替换的内容（精确匹配 / 含空白 / 换行 / 缩进 / 默认必须**唯一**出现）
- `new_string`   (string, required)    新内容（可为空字符串 / 等同删除）
- `replace_all`  (boolean, optional)   默认 false（强制唯一匹配）/ true 替换所有出现

**【3. 成功返回】**
- 文件路径 + 备份路径（`tasks/sync/<id>` / 跟 write 工具 §10.2.6 备份机制同型）
- 修改片段（前后 ~3 行 context）+ 行数变化
- `metadata.replaced`：替换次数（即使 replace_all=false 也是 1）

**【4. 副作用 + 跨通道影响】**
- 替换前自动备份原文件到 `clawDir/tasks/sync/<id>` (跟 write 工具同型 frontmatter)
- 原子写（temp+rename / 崩溃不留半文件）
- 文件不存在 → 失败（不创建 / 创建走 write）
- 不内置 size limit（跟 write 一致 / 单次 LLM 输出由 max_tokens 自然限）

**【5. profile 准入 + 不变量】**
- profile：subagent / miner（write-capable subagent）/ **严格不在 main claw**（main claw 想精确改 → spawn 子代理 / 不给 main claw 加工具集认知负担）/ 不在 readonly / dream / verifier
- readonly: false / idempotent: false
- 不可并行（同文件写冲突）

**【6. 关键设计点】**
- **默认唯一匹配 = safety net**：多 match 拒绝 + 提示扩 old_string 含上下文使其唯一 / 0 match 拒绝
- **`replace_all=true` 显式批量**：agent 主动选择全替换 / 不是默认行为
- **跨多行支持**：old_string 可含 `\n` / 子代理直接给一段 / 工具按字符串原样匹配
- **read-before-edit 不强制**：写 old_string 自然要求子代理先看（read 工具天然鼓励）/ 系统不强加 cache 层
- **不重复 write 的 create 能力**：edit 只改既有文件 / 创建走 write
- **partial modify 路径**：`main claw → spawn(prompt="改 path 的 X 为 Y") → 子代理 read+edit / multi_edit → 异步回 inbox 结果`

### 10.6 multi_edit【设计中 / 暂不实现】

> **派生场景**：subagent 同文件多处机械改（变量重命名 / API 改名 / 批量 typo / 配置项批量更新）/ 一次原子写完成。
>
> **业界最佳实践**：Anthropic Claude Code MultiEdit / 顺序应用 + 全量回滚。

**【1. 用途】** 同一文件内一次完成多处精确替换（原子 / 顺序应用 / 任一失败全回滚）。

**【2. 入参】**
- `path`     (string, required)    相对 clawspace 的路径
- `edits`    (array, required)     edit 列表 / 顺序应用 / 单条形态同 `edit` 工具：
  - `old_string`   (string, required)
  - `new_string`   (string, required)
  - `replace_all`  (boolean, optional / default false)

**【3. 成功返回】**
- 文件路径 + 备份路径（**单次备份** / 应用前快照原文件 / 不是每条 edit 各备份一份）
- 修改总览（每条 edit 的 replaced count + 整体行数变化）
- `metadata.results`：`[{ index, replaced }, ...]`

**【4. 副作用 + 跨通道影响】**
- 应用前**单次** backup 写入 `clawDir/tasks/sync/<id>`（覆盖前快照 / N 条 edit 共享一份备份）
- **顺序应用**：edits[0] → edits[1] → ... 任一失败 abort 不写
- **原子写**：要么全部成功 + 1 次 fs write / 要么 0 改动（不写 + 错误返回）
- 文件不存在 → 失败
- 不内置 size limit

**【5. profile 准入 + 不变量】**
- profile：subagent / miner / **严格不在 main claw**（同 edit）/ 不在 readonly / dream / verifier
- readonly: false / idempotent: false（顺序敏感）
- 不可并行（同文件写冲突）

**【6. 关键设计点】**
- **何时用 multi_edit vs edit**：3+ 处改 → multi_edit（原子性 + token 效率）/ 1-2 处 → edit（schema 简单）/ 子代理自决策
- **顺序敏感警告**：edits[i] 的 old_string 可能引用 edits[<i] 已替换后的文本 / agent 自负顺序设计
- **失败回滚语义**：任一 edit 找不到 / 多 match（replace_all=false）→ 全部 abort + 错误信息含失败 index
- **单次备份 vs 多次**：N edit 共享 1 份 sync 快照（节省存储 / 回滚一次性恢复完整原文件）
- **vs 多次单 edit 的中间态风险**：单 edit 串行调用 / claw 中途 crash / 文件停留在中间态。multi_edit 单次原子写消除此风险

### 10.7 跨 claw / 跨 clawDir 不在本工具通道（防 future drift）

| 场景 | 路径 | 备注 |
|---|---|---|
| 自己 clawspace 操作 | 工具通道（read/write/search/ls）| 路径相对 clawspace 根 |
| 跨 claw（含未来 claw 互读 clawspace）| **CLI**（motion 用 exec / 用户代办语义）| 工具不带 `clawId` 入参 |
| motion 跨 clawDir 内部（contract/ inbox/ stream.jsonl 等）| **系统信息通道**（系统按需推送）| 不归工具通道 |

**设计原则锚点**：
- 工具通道 mental model 极简（agent 不用思考「我能跨吗 / 跨权限是啥」/ 路径就是 clawspace 内）
- L1 FileSystem 不内化分布式（保 L1 干净 / 分布式归 CLI 网络层）
- D11 motion 单向访问 = 能力（用户代办）/ 不是工具入参 / 不暴露 motion 概念给普通 claw

### 10.8 跨工具偏好不在本节（归系统信息通道）

工具 description **只写工具自身决策需要的信息**（自含信息）。跨工具偏好（如「用 write 不用 exec: cat」/「用 search 不用 read+grep」）归 AGENTS.md 等系统信息通道写 / 不在工具 schema 描述里。

判据：
- ✓ 写 schema：`tasks/sync/` 自动备份（write 自身事实）/ offset 负数从末尾倒数（read 自身入参语义）
- ✗ 不写 schema：「优先 write 不用 cat」（跨工具）/「200 行 / 8000 字符」具体阈值数字（让 metadata 反馈）

### 10.9 待统一深度讨论

- 失败语义错误文本 keyword 表（5 工具统一）/ agent 决策路径（哪些可重试 / 哪些终态）
- 跨 claw 走 CLI 的具体 CLI 形态（命令名 / 参数 / motion 用 exec 调的 invocation 模板）
- 系统信息通道（motion 跨 clawDir 内部 / claw 看 contract/ status / dispatch-skills 装配 等）的设计
