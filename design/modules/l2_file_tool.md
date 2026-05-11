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

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 工具执行无状态（每次 execute 独立）|

**无磁盘资源** — FileTool 是 OS 文件 I/O → agent 工具的翻译层 / 不 own 业务资源。

> 注：(1) **路径根** = ExecContext.workspaceDir（装配期 per-callerType 注入 / 主代理 = `<clawDir>/clawspace/` / 子代理 = `<clawDir>/tasks/subagents/<task-id>/` / phase 507+ workspaceDir 概念 / phase 512 落地）/ claw own clawspace / subagent own 自己的 subagents/<id>/ 临时工作区 / FileTool 仅消费 workspaceDir / (2) **写入 syncDir** = `clawDir/tasks/sync/`（应然 phase 507+：FileTool write/edit/multi_edit backup 写到 `tasks/sync/write/<uuid>.md` 子目录 / 与 CommandTool `tasks/sync/exec/` 子目录区隔 / 装配方注入 syncDir base + 本模块拼 `write/` 子目录 / 两工具皆为写入方非 owner / lifecycle 归 Snapshot 触发清理）/ (3) agent 文件工具 schema + execute 实现集中 `src/foundation/file-tool/{read,write,search,ls,edit,multi-edit}.ts`（实施细节归 §1.做 + §10 / 非 M#3 业务资源）。

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

### 7.A.invariant 模块级硬约束（phase 537 sharpen）

> 本节集中登记 §A 必修违规所参照的**模块级硬约束**（应然语义 / 不在 §10 工具通道描述里展开 / 此处单独硬登记 / `§A.x` row 引用本节锚点）。

1. **Cross-claw 路径解析必 trailing-sep prefix 守护**：3 cross-claw 工具（read / ls / search）解析 `claws/<id>/...` 路径后 / 边界检查必满足 `targetPath === clawRoot || targetPath.startsWith(clawRoot + path.sep)` / 仅 `startsWith(clawRoot)` 不充分（兄弟前缀 `claws/c1` vs `claws/c11` 误 match / `c1` token 守护被 `c11` 路径绕过）。
2. **`fullyReadPaths` 同 claw 写闸隔离**：`ExecContext.fullyReadPaths` 表达 **「同 claw 同 path 已读 → 可覆盖」** 语义（phase 487 G6 (a) + phase 490 闸源）/ **cross-claw 分支不得 add 此集合**（target claw 的 path 不属于 caller claw 的写闸授权 / 加入即同 claw 写闸被绕）。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 模块物理不存在~~ | structural drift / 高 | **✅ closed（phase428 / main `e8dd251b`）** | 应然独立目录 + `createFileTools` 工厂。phase428 实施 4 阶段同 commit：(1) git mv 4 tool files `src/core/tools/builtins/{read,write,search,ls}.ts` → `src/foundation/file-tool/`（保 history）(2) 4 file 内部 import path 修（dir 深度 3→2 级 / Tool/ToolResult/ExecContext 仍跨 import core/tools/executor.js / ToolProtocol cross-layer drift cascade / 推 r+1 治理）(3) NEW `src/foundation/file-tool/index.ts` 含 `createFileTools(options): Tool[]` 工厂 + `FileToolOptions` interface 占位 (4) builtins/index.ts 删 4 import + 4 register + 4 re-export（保 statusTool/sendTool/skillTool）+ assemble.ts 加 `createFileTools({})` register loop（同 phase378 模式）+ 3 测试 import path cascade / 0 行为改 / 1370+ 测试 PASS / **应然位置 align L2 = `src/foundation/`**（与 phase420/423/425 一致 / 不用本条原文 `src/core/file-tool/` / Path #1 实证纠正）/ **scope 收紧**：allowedRoots 配置 + 公共越界 helper（A.2 cascade）推 r+1+ 业务决策 |
| ~~A.2 路径权限域策略碎片化~~ | ~~semantic drift / 高~~ | **✅ closed**（phase 488 / main `1db105eb` merge `93556b4b`）| ~~应然：统一 `allowedRoots` 注入 / 实然：每工具自治异构~~ → phase 488 **实测核 reframe**：实然已有 PermissionChecker 基础设施（permission-context.ts / Assembly 注入 factory / 4 工具全用 `getChecker(ctx.clawDir).resolveAndCheck()`）/ READ_BLOCKLIST + SEARCH_ALLOWLIST 是 secondary 异构双层守护（多余）/ ls + write 已合规单层。**phase 487 G8 (a) ExecContext +allowedRoots 是 over-engineering**（不知 PermissionChecker 已存在）/ **phase 488 G8 reframe (a)' 选项 1 锁定**：删 BLOCKLIST + ALLOWLIST + 删测试 / 仅 PermissionChecker 单 source / ~25 行 src 净删 + 1 测试删。**3 原则 align**：M#7 稳定（单 source）+ M#8 最小（删双层）+ M#3 路径权限归 PermissionChecker。**行为差登记**：(1) `read('logs/')` 现解禁（agent 在 sandbox 内 / 合规）(2) search 范围扩到全 sandbox（之前限 clawspace+skills+prompts 3 dir）/ 用户接受（业务决策 / sandbox 内合规）。**「实测核 reframe over-engineering 设计」模板首发**（推 r+ Meta 升格 feedback）|
| ~~A.3 ctx.fs 与 fsNative 双轨~~ | ~~dependency drift / 中~~ | **✅ closed（phase467 / main `1421e620`）** | 应然：通过 L1 FileSystem 接口注入（M#3 资源唯一归属 + M#5 依赖单向）/ ~~实然：`read.ts:107` `search.ts:42,50,125-126,139` `ls.ts:77,80` 直 import `fsNative` 绕 ctx.fs 层~~ → phase467 治理：8 fsNative calls 全清 / 改用 per-target NodeFileSystem 实例化（cross-baseDir 显式 / 同 phase455+460 cluster 模板）/ (1) ls.ts cross-claw branch readdir+stat → `new NodeFileSystem({baseDir: clawRoot}).list('', {includeDirs:true})` (2) read.ts cross-claw branch readFile → 同型 (3) search.ts walkNative recursive helper 加 fs 参 + claw=* iter 改 `clawforumFs.listSync('claws', {includeDirs:true})` + per-claw `new NodeFileSystem({baseDir: claws/<id>})` / 「skip ctx.fs permissions」语义保留：cross-claw 用别 claw 实例 / PermissionChecker 不注入即默认无限制（同 phase445 既证）/ 行为 0 改 / **bypass cluster L1-L5 真完结里程碑**（phase434+436+439+455+460+467 累 7 phase / 60+ + 8 = 68+ calls 全清）|
| ~~A.4 read / ls supportsAsync 过度准入~~ | ~~scope drift / 低~~ | **✅ closed（phase400 / main `3ed32b82`）** | 应然权威单源 = l2_command_tool §10.6（C 类 sync-only / 14 工具三分类）/ 实施：read.ts:61 + ls.ts:38 `supportsAsync: true` → `false`（同根 l2_tools §A.X-2 status 同 phase 治）/ 同根 drift 跨视角对齐模板首次实施期复用（Meta 31 立 feedback 升格后 / 元复利验证）/ design+code 单 phase 内联动模板第 2 实证（phase397 首发）|
| ~~A.5 write overwrite 不强制 fully-read-before~~ | ~~semantic drift / 高~~ | **✅ closed**（phase 490 / main `e9fe3e6d`）| ~~应然 §10.2.6 fully-read gate / 实然 0 检查~~ → phase 490 实施：(1) ExecContext +`fullyReadPaths: Set<string>` schema 扩 / 默认 new Set() / cloneExecContext Object.assign 共享 Set 引用（**0 特殊代码 / 默认行为即真合规**）/ subagent getExecContext 装配新 Set 隔离 (2) read.ts 截断检测后 / 未截断时 `ctx.fullyReadPaths.add(normalized)` / 截断 (LINES > 200 或 CHARS > 8000) 不 add (3) write.ts overwrite gate：`if (!append && exists && !ctx.fullyReadPaths.has(filePath))` reject + hint「use append=true or read first」/ overwrite 写成功后 add（append 不 add）。**3 原则 align**：D2 不丢弃/静默忽略（拍脑袋 overwrite 反 D2）+ M#7 耦合界面稳定（fullyReadPaths 单一字段）+ Philosophy P2 上下文工程（导引 spawn workflow）。**行为差**：main agent 直接 overwrite 现有文件 reject / 引导 read 先 + spawn subagent 局部修改（接受 / phase 487 G6 (a) 锁定）|
| ~~A.6 write description 量化数字 + 实然有 size limit + .versions per-dir~~ | ~~semantic drift / 中~~ | **✅ closed**（phase 490 / 同 A.5 同 phase）| ~~实然 size limit + .versions/ per-dir + keep N~~ → phase 490 实施：(1) 删 `WRITE_SIZE_LIMITS` + `WRITE_VERSION_RETENTION` 常量 (2) 删 `getSizeLimits` + softLimit/hardLimit 检查 (3) write.ts description 删数字（删「Size limits: ...」+ 「Auto-backups to .versions/ (keep 10)」）(4) NEW `backupToSync(ctx, filePath)` 函数 / 复用 phase 485 syncDir 协议 / frontmatter `source: file_backup` + original_path + content_length + created_at（同 phase 485 exec_overflow 模板）/ ToolResult content 加 `(backup: <relPath>)` 提示 (5) 删 keep N cleanup（Snapshot commit hook 已 generic clean / phase 485 已立）。**3 原则 align**：M#3 资源唯一归属（共享 syncDir 不归 FileTool own）+ M#8 耦合界面最小（删 size limit 双源数字 + 删 keep N）+ NEW 基础设施 phase 模板复用（phase 485 立 syncDir + commit hook）。**5 实证累 NEW 基础设施 → caller 改用模板**（phase 432+446+485 立 + phase 489+490 caller-side migration）|
| ~~A.7 edit / multi_edit 工具实然不存在~~ | ~~feature gap / 中~~ | **✅ closed**（phase 492 / main `0dec4f5b`）| ~~应然 §10.5 + §10.6: edit + multi_edit / 实然 0 实施~~ → phase 492 实施：(1) NEW `foundation/file-tool/edit.ts` / countMatches indexOf 字面 / 唯一/多 match/0 match 三态 / replace_all 显式批量 / backupToSync 备份 / writeAtomic 原子 / 文件不存在 reject (2) NEW `foundation/file-tool/multi_edit.ts` / 顺序应用 in-memory / 任一失败 0 fs write 回滚 + failed_index + hint「修第一个后再试 / 后续 edit 可能 invalidate」/ 全部成功单次 writeAtomic / 单次备份 (3) NEW `foundation/file-tool/sync-backup.ts` shared helper / 4 source 参（file_backup / edit_backup / multi_edit_backup / exec_overflow）/ write.ts refactor 改用 (4) profiles.ts subagent + miner +EDIT+MULTI_EDIT（main/motion/readonly/dream/verifier 不加 / G1 (a) 锁定）(5) NEW edit.test + multi_edit.test。**G1-G5 全 verify 落地**（5 决策 18 原则推力 align）：G1 subagent+miner profile / G2 source=edit_backup 复用 phase 485 模板 / G3 multi_edit 回滚 + index + hint / G4 0/多 match fail loud / G5 subagent 自治。**Cluster B r+1 收官**（3/3 全闭 / phase 488+490+492）/ **r53+ §10 应然完整落地**（Cluster A 4 phase + Cluster B 4 phase = 8 phase 总收）。注：用户文 ask_claw vs 实然 ask_caller 命名 drift 推 r+1 独立 phase（不在本 cluster scope）|

#### G1-G7 design-gap（phase474 / 等用户拍板）

**G1 main claw profile 准入策略（关键决策）**

- **背景**：当前 §10.5「严格不在 main claw（main 想精改 → spawn 子代理）」/ 实然 Motion 直 sed/exec 试错 / 不 spawn / 编辑费力
- **选项**：
  - (a) 维持 spec / Motion 治本走 spawn 工作流 + AGENTS.md 引导 + ask_caller 配套
  - (b) 放开 main claw edit 准入 / Motion 流畅 / 但 main 工具集 +2（破坏 P2 上下文工程）
  - (c) 折中：仅 edit 给 main / multi_edit 仍仅 subagent
- **主会话推荐**：(a) / 治根 = spawn 工作流引导 + ask_caller / 加 edit 给 main 是治标
- **等用户**：拍板 (a)/(b)/(c)

**G2 sync/ 备份 frontmatter 字段集**

- **背景**：§10.5 「跟 write 同型 frontmatter」/ §A.6 应然 `source: write_backup`+`original_path`+`ts`+`content_length`
- **问**：edit 备份是否记 old_string/new_string（审计粒度）/ 还是仅 source 区分
- **主会话推荐**：仅 `source: edit_backup` + write 同型字段 / 不入 edit 内容（diff 即可审计）
- **等用户**：是否需 edit 内容入 frontmatter

**G3 multi_edit 失败回滚 token 反馈形态**

- **选项**：(a) 全部失败 detail / 多 token (b) 仅第一个 fail-fast / 少 token (c) 失败 index list + 第一个 detail
- **主会话推荐**：(c) + hint「修第一个后再试 / 后续 edit 可能 invalidate」
- **等用户**：(a)/(b)/(c)

**G4 0 match / 多 match 错误信息形态**

- **0 match**：fuzzy match 提示 vs fail loud / 推荐 fail loud + hint 扩 old_string
- **多 match**：列 match 行号+context vs count+hint / 推荐前者
- **等用户**：fuzzy 是否实现 / 多 match 详情粒度

**G5 ask_caller 配合时机**（phase 466 落地后）

- **问**：subagent edit 0 match → ask_caller 反问 main / 还是 subagent 自 read 重看
- **主会话推荐**：subagent 自 read 重看（先 stale 检查）/ 真不可解才 ask_caller
- **等用户**：escalation 路径

**G6 fully-read 集合 partial vs subagent**

- **背景**：§10.2 §6 fully-read session-scoped / subagent 与 main 不同 session
- **选项**：(a) edit 不强制（同 §10.5）(b) overwrite 也强制（subagent 同 main 一视同仁）(c) subagent 完全免
- **主会话推荐**：(b) 同 main / 简化语义
- **等用户**：subagent overwrite/edit 的 fully-read 策略

**G7 phase475+ code phase Step 拆**

- **选项**（详 phase474/Step C 文件）：
  - (a) 单 phase 治全部 / 大 PR
  - (b) 拆 2 phase（write 改造 → edit/multi_edit）
  - (c) 拆 3 phase / 各 concern 单 phase
  - **(d) 单 phase 多 Step A-F**（推荐 / 模板成熟 / cascade 一致）
- **主会话推荐**：(d) / 6 Step 单 PR / 同 phase 411+446+450+453+465 模板
- **等用户**：phase 拆 + Step 划分
| **A.8 FileTool L2 → core/permissions L4 反向 dep** | dependency drift / 中 | **✅ closed（phase445 / main `06648736`）** | phase430 删 NodeFileSystem ctor PermissionChecker 注入 / 但 FileTool 4 file 自治 import L4 反向（8 instances）/ M#5 单向依赖违反。phase445 实施 5 阶段同 commit：(1) NEW `src/types/permission.ts` 含 PermissionChecker interface（cross-cutting type / 同 errors.ts/message.ts/paths.ts 模式）(2) `core/permissions/claw-permissions.ts` 删 interface 定义 + re-export shim from types/permission.ts (3) NEW `src/foundation/file-tool/permission-context.ts` shared `setPermissionCheckerFactory` + `getChecker` helper / `createFileTools` 工厂签名加 `permissionCheckerFactory` deps (4) 4 file (ls/read/search/write) 删 L4 反向 import + 改用 shared helper (5) Assembly 装配期 inject `createClawPermissionChecker` factory function / 0 行为改 / 1370+ 测试 PASS / **foundation/file-tool/ 0 反向 cross-layer to core/ 验证通过** / 工厂注入模板复用（同 phase419 Watchdog 工厂）|
| ~~A.9 read.ts:84 cross-claw 兄弟前缀逃逸~~ | ~~security drift / 高~~ | **✅ closed**（phase 537 / main `47fdb542`）| 应然：trailing-sep prefix 守护（§7.A.invariant 第 1 条）/ ls.ts:79 + search.ts:180 已合规。~~实然 read.ts:84 `targetPath.startsWith(nodePath.join(clawsDir, clawParam))` 无 sep~~ / 攻击 `claw="c1"+path="../c11/secret"` 经 `nodePath.resolve` 扁平化后落 `/.../claws/c11/secret` / 仍 startsWith `'/.../claws/c1'` → 兄弟 claw 读穿 → phase 537 Step B 改 align ls/search：`targetPath !== clawRoot && !targetPath.startsWith(clawRoot + nodePath.sep)`（α 决策 5/5 原则一致 / 不抽 helper）|
| ~~A.10 cross-claw read 污染同 claw fullyReadPaths~~ | ~~semantic drift / 高~~ | **✅ closed**（phase 537 / main `47fdb542`）| 应然：fullyReadPaths 是同 claw 写闸（§7.A.invariant 第 2 条 / phase 487 G6 + phase 490）/ cross-claw 读不入。~~实然 read.ts:142-143 cross-claw 分支汇流后仍 `ctx.fullyReadPaths.add(resolved)`（resolved 为 caller 本地路径）~~ → caller 后续同 path 本地 write 直接通过 phase 490 gate / 同 claw 写闸被绕 → phase 537 Step B 改：cross-claw 分支单独短路 `if (!isTruncated && clawParam === undefined)` 不 add（γ 决策 5/5 一致 / 不动 schema）|

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
| **clawspace 总占用限制 design**（**phase 476 复审拆分 / 6 sub-problem 状态分类 / phase 545 G fork closure**）| **6/6 全 closed**（phase 476 复审 4 + phase 490 (5)+(6) FileTool obsolete + phase 545 (3)+(6) closure） | **phase 476 复审（r64 D fork / 2026-05-04 / design only / 0 src 改）**：原 framing「6 sub-problem 完整 design」substantive 自核后浮出 4/6 是应然描述错位 / 真 design 决策仅 2 项。状态分类： — **(1) 监测策略 ✅ closed by 复审**：实然 `disk-monitor.ts:30+` cron 周期 + getDirSize 已实施 / 应然方向 = **cron only**（实时扫违 M#5 反向 dep / 增量缓存当前 ROI 低）。— **(2) enforce 责任 ✅ closed by 复审 / 描述错位修**：原描述「FileTool / 业务语义本质 / M#2」**违 M#1+M#2**（FileTool 单实例视野 ≠ 跨 claw 视野 / 不可能 own 跨 claw 总占用 enforce）/ 修正：**enforce 归 disk-monitor cron own** + 通知 agent 通过 inbox / FileTool 仅守 per-file（~~实然 `write.ts:110-138` hardLimit/softLimit enforce 已实施~~ → phase 490 删 size limits / FileTool 0 size config 概念）。— **(3) 通知通道 ✅ closed by phase 545**（design lock B / 实施升档登记 / r66 G fork）：~~应然方向待用户拍板~~ → 5/6 原则 align lock B（M#2 业务语义归属 + Philosophy P1 agent 即目录 + P2 上下文工程 + D2 不丢弃 + D11 motion 特殊 / 仅 YAGNI 单项 favor A）/ C 反 YAGNI（audit 双轨 cron+claw 既证）/ **应然 lock B（design-close）/ 实施前提 = claw-side disk-warning handler（当前 0）/ 升档条件登记 = claw-side handler 实施时 reopen**（推 r67+ / Path #1 实测 grep `cron_disk_warning` claw-side caller 0 命中 / B 实施是 pre-feature）。— **(4) delete 工具 ✅ closed by 复审**：撤回先前「缺 delete 工具」误判 / **agent 用 `exec 'rm -f <path>'` 实然路径已足够 ROI**（idempotent / cwd 默认 clawspace 自然范围限 / AGENTS.md 教学已含）/ 论证升级：非 DRY reflex 反例 / 是「最小工具集 vs 完整对称」trade-off / 实然路径 ≥ dedicated tool 收益。— **(5) write_backups ✅ closed by phase 490**：~~实然 per-dir `.versions/` 散落~~ → phase 490 A.6 closed（删 .versions per-dir + 改用 backupToSync syncDir 集中 + commit hook generic clean）/ §A.6 同源 drift 已合 main `e9fe3e6d`。— **(6) 配置 ✅ closed by phase 545 + phase 490**：~~实然 hardcode constants / 应然方向待用户拍板~~ → 原 framing 「FileTool clawspace 配置 DI」**已被 phase 490 obsoleted**（A.6 closed / FileTool 0 size config 概念 / δ/ε/ζ 全 N/A）/ 剩 disk-monitor.limitMB 已 yaml DI（`assemble.ts:511` `globalConfig.watchdog.disk_warning_mb ?? 500` → opts.limitMB / γ pattern 合规）/ 微 namespace smell（应在 `cron.jobs.disk_monitor.limitMB` 而非 `watchdog.disk_warning_mb`）推 r+1+ 顺手清。**effectively closed by phase 490 + 现有 yaml DI**。**整体状态**：6/6 全 closed / open 数 = 0 / 推 r67+ B 实施触发条件 = claw-side disk-warning handler。 |
| ~~validateArgs 不拒绝未定义参数~~ | ~~`executor.ts:validateArgs`~~ | **✅ closed（phase 531 / main `f39f8d09`）**：strict additionalProperties / 迭代 args keys + reject schema.properties 外字段 + error message 含 unknown field 名 + sorted allowed list（LLM 反馈友好）+ 0 参数工具传字段也 reject / Step 0 sweep 18 工具 schema vs args 引用 0 漏（实施期顺手修 4 既有测试 mock schema 不匹配 / Path #1 副发现）/ silent X cluster 防御扩 tools 层（同 phase 523 chat-viewport silent X 同型）/ **业务决策性 design-gap → 原则 derive 自决** 第 4 实证（5/5 原则一致选 strict / 0 σ trade-off）|
| ~~read schema 含 async 但 supportsAsync=false~~ | ~~`read.ts:44`~~ | **✅ closed（phase 530 Step A / main `81275057`）**：read.ts:44-47 + ls.ts:36-39 删 async schema 字段 align supportsAsync=false（phase 400 supportsAsync true→false 时漏删 / ε spec correction）/ search.ts 真 supportsAsync=true 不动 / write/edit/multi_edit 实然无 async 字段 |
| ~~ls 跨 claw 列出路径显示异常~~ | ~~`ls.ts:124`~~ | **✅ closed（phase 530 Step B / main `81275057`）**：lines.map 加 `clawParam !== undefined` 条件分支 / cross-claw 时直接用 e.path（targetFs baseDir = targetPath / e.path 已是 target claw 内相对）/ same-claw 保 nodePath.relative(resolved, e.path) 既有逻辑 / phase 514 解禁 cross-claw read 时漏改 displayPath / bug fix |

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

- D1a-d 信息不丢失 / 状态可观察 / 中断可恢复 / 事后可审计：tool_exec 框架审计覆盖 / 越界拒绝走 ToolResult 留痕
- D2 不丢弃 / 静默：所有 fs 错误转 ToolResult / 不静默吞
- D3 用户可观察：tool_exec audit + 备份文件可观察
- D4 LLM 调用恢复：N/A（本模块不调 LLM / 工具 sync 执行）
- D5 日志重建：tool_exec audit 序列 + tasks/sync/ 备份可重建文件操作链路
- D6 子代理后不阻塞：N/A（工具执行 sync / 派 subagent 归 caller / spawn 本身在 AsyncTaskSystem own）
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 2 轮 src 实测核 align）：所有走 AsyncTaskSystem subagent-executor 路径子代理（spawn/dispatch 智能体调度工具 + retro/random_dream 系统调度 / ask_caller 是子代理内部询问 main caller 工具不调度新子代理 / 不在本继承范围）经 `main registry.getForProfile('subagent')` 派生子 registry / **FileTool 6 工具 module-level const 同源 reuse** + **ctx.clawDir 透传** → `getChecker(ctx.clawDir)` module-level cache 拿同 PermissionChecker / sandbox 形状由 claw-permissions.ts hardcoded SYSTEM_PATHS+WRITABLE_PATHS derive（非 caller 配置）→ FileTool 边界 100% 隐式 align caller / 非字段透传机制 / 例外：ContractSystem.verifier-job 不走 AsyncTaskSystem（empty registry + 0 FileTool / 不存在继承语义）/ deep_dream 不创 SubAgent N/A
- D7 系统可信路径：受信组件 / 经 ToolRegistry register 装配
- D8 事件驱动：N/A（被动框架 / 不发事件）
- D9 CLI 唯一外部入口：N/A（本模块不与外部交互 / 全经 Tools 框架）
- D10 多 claw 不隔绝：N/A（FileTool sandbox 限自身 clawspace / 跨 claw 走 CLI / 详 §10.7）
- D11 motion 特殊：`allowedRoots` 配置允许 motion 装配方注入 motion 域 + 其他 claw 域（A.3 ctx.fs 双轨需治理）

**Philosophy**

- **P1 Agent 即目录**：路径根 `<clawDir>/clawspace/` 是 agent 文件操作目录锚点
- **P2 上下文工程**：**核心驱动**（read 截断分页 + write 大小约束 + 兜底落盘 / 防 agent 上下文窗口被一次性大文件撑爆）
- **P3 分多个智能体加分子任务**：edit / multi_edit 给 subagent 局部修改 / main claw 大文件 overwrite 自然引导 spawn 子代理
- **P4 系统为智能体服务**：把 OS 文件 I/O 复杂度收敛到工具边界 / agent 看简单语义

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：§7.A 修复 phase 必先 Path #1 核 builtins/ 现状（治理动作要 grep 实然代码佐证 / 注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：工具实现可独立换 fs 实现而不动 caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-26 / r31 新建模块契约（应然 / 实然 split）
- KD#27 业务语义按 α.1 决策声明归 FileTool 模块（modules.md 决策映射）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Design Principles D8「CLI 唯一入口」错位修：D8 verbatim「事件驱动」+ D9「CLI 唯一外部入口」+ 加 D3-D7+D10 显式 align principles.md / §3 资源改 table 「无」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim + Module Logic 命名 已正确）
- 2026-05-04 / phase467 fsNative bypass 治理（main `1421e620`）/ ls.ts + read.ts + search.ts 8 calls 全切 NodeFileSystem 实例化（per-target + per-claw cross-baseDir 模式 / 同 phase455+460 cluster）/ walkNative helper 加 fs 参 / search claw=* iter 改 listSync / **bypass cluster L1-L5 全闭里程碑**（phase434+436+439+455+460+467 累 7 phase / 68+ calls）/ A.3 closed
- 2026-05-04 / phase428 FileTool 模块物理立首发（main `e8dd251b`）/ git mv 4 tool files `src/core/tools/builtins/{read,write,search,ls}.ts` → `src/foundation/file-tool/`（保 history）+ NEW `createFileTools(options): Tool[]` 工厂 + FileToolOptions 占位 + Assembly 显式 register loop（同 phase378 模式）/ A.1 closed / **业务工具归 owner module 第 2 实证**（phase360 done + 本 phase / 后续 phase416+440+442+446 累 6 实证模板成熟）
- 2026-05-04 / phase400 supportsAsync 过度准入闭环（main `3ed32b82`）/ read.ts:61 + ls.ts:38 `supportsAsync: true` → `false` align l2_command_tool §10.6 sync-only / A.4 closed / **同根 drift 跨视角对齐模板首次实施期复用**（Meta 31 立 feedback 升格后 / 元复利验证）+ design+code 单 phase 内联动模板第 2 实证
- 2026-05-04 / phase445 FileTool L2 → core/permissions L4 反向 dep 闭环（main `06648736`）/ NEW `src/types/permission.ts` cross-cutting type + claw-permissions.ts 改 re-export shim + NEW `src/foundation/file-tool/permission-context.ts` shared helper + 4 file (ls/read/search/write) 删 L4 反向 import + Assembly inject createClawPermissionChecker factory / A.8 closed / **foundation/file-tool/ 0 反向 cross-layer to core/ 验证通过** / 工厂注入模板复用（同 phase419 Watchdog）
- 2026-05-04 / phase474 edit/multi_edit 工具 design sharpened（design only / r64 user-driven motion 实测编辑费力）/ §10.5+§10.6 应然 + G1-G7 design-gap 等用户拍板（G1 main claw profile 准入 / G2 sync/ 备份 frontmatter / G3 multi_edit 失败回滚 token / G4 0 match / 多 match 错误信息 / G5 ask_caller 配合 / G6 fully-read 集合 / G7 phase475+ code phase Step 拆）+ §A.5+§A.6+§A.7 cascade 同 phase 治理推 phase475+
- 2026-05-04 / phase476 clawspace 总占用限制复审拆分（design only / r64 D fork / 6 sub-problem 状态分类 / 4 closed by 复审（监测策略 / enforce 责任 / delete 工具 / write_backups 推 r65+）+ 2 open design-gap（通知通道 / 配置 DI）/ §B row 状态分类登记 / 等用户拍板 r65+ design phase）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_file_tool.md vs arch §16 + 表 1/2/3 + interfaces/l2c.md FileTool 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7 + D4/D6/D8/D9/D10/D11 N/A + Philosophy P1+**P2 核心驱动**+P3+P4 + Path #1-#7）/ 3 主能力 align arch 表 2 / 2 dep + caller Assembly align arch 表 1 / 4 工具 align arch 表 3 / 补 phase428+400+445+474+476 closure timeline entry / A.2/A.5/A.6/A.7 open drift 推 phase475+ code phase 同 phase 治理 / design only / 0 src 改
- 2026-05-05 / phase 485 共享 syncDir 协议立（main `9b703d7e` / Cluster A r+1 收官 4/4 / FileTool §A.6 cross-ref 标 partial / 共享 dir 装配协议已就位 / write.ts 改用 ctx.syncDir 替 per-dir .versions/ 仅需 caller-side 改 / 推 Cluster B file_tool code phase）
- 2026-05-08 / phase 530+531 §7.B drift 1+2+3 全闭（main `81275057` + `f39f8d09`）/ phase 530 双 ε spec correction（read+ls async schema 删 align supportsAsync=false / phase 400 漏删收尾）+ ls cross-claw displayPath bug 修（phase 514 解禁 cross-claw read 漏改）/ phase 531 validateArgs strict additionalProperties（业务决策性 5/5 原则一致选 strict / **silent X cluster 防御扩 tools 层** 同 phase 523 chat-viewport silent X 同型）/ Step 0 sweep 18 工具 schema vs args 引用 0 漏字段 / 实施期 Path #1 副发现 4 既有测试 mock schema 不匹配 / 「业务决策性 design-gap → 原则 derive 自决」第 4 实证累
- 2026-05-05 / phase 487 Cluster B master design phase（design only / 整合 phase 474 G1-G7 + 加 G8 §A.2 路径权限域统一 / 8 决策全锁定 / 0 推迟 / 全原则推力 align verify）/ §A.2+§A.5+§A.6+§A.7 closed-design 推 r+1 phase 488+489+490 严格顺序 / phase 拆 strategy：488 §A.2 (allowedRoots) → 489 §A.5+§A.6 (write 改造 / fully-read gate + .versions→syncDir + 删 size limit) → 490 §A.7 (edit/multi_edit NEW) / 用户文核 G1-G8 8 决策全 verify Philosophy P2+P3 + D2/D5/D7 + M#5/M#7/M#8/M#10/M#11 多原则强 align / **设计决策从原则推导矩阵呈板模板第 3 实证**（phase 479+485+487 / 累达升格阈值）/ phase 号 race 顺延 phase 475→487 实证累 7
- 2026-05-05 / phase 488 A.2 路径权限域统一落地（main `1db105eb` merge `93556b4b` / Cluster B r+1 第 1 phase / **G8 phase 487 (a) → phase 488 (a)' reframe**：实测核浮出 PermissionChecker 已是统一基础设施 / 不立 ExecContext +allowedRoots / 删 read/search BLOCKLIST + ALLOWLIST 异构 const + 删测试 + 仅 PermissionChecker 单源 / ~25 行 src 净删 + 1 测试删 / 行为差接受（read logs/ 解禁 + search 范围扩到全 sandbox / 用户拍板）/ **「实测核 reframe over-engineering 设计」模板首发**（推 r+ Meta 升格 feedback）/ **复用已有基础设施 / 不立新轮子**模板复用（同 phase 461 反 DRY reflex）
- 2026-05-05 / phase 490 A.5+A.6 write 改造落地（main `e9fe3e6d` / Cluster B r+1 第 2 phase / G6+G2 phase 487 锁定 / NEW ExecContext +fullyReadPaths Set + read add 未截断时 + write overwrite gate + write 删 size limit + backupToSync 改 syncDir + frontmatter source: file_backup / 行为差：overwrite 强制 fully-read 前提（接受 / 引导 spawn workflow）/ **NEW 基础设施 phase → caller phase 改用模板第 5 实证**（phase 432+446+485 立 + phase 489+490 caller-side migration / 累 5 实证 / 推 r+ Meta 必硬化）/ **「默认 Object.assign 行为即真合规」实证**（cloneExecContext 共享 Set 引用 / 0 特殊代码 / 反 over-engineering）/ phase 号 race 顺延 phase 489→490 实证累 8）
- 2026-05-05 / phase 492 A.7 edit + multi_edit NEW 工具落地（main `0dec4f5b` / **Cluster B r+1 收官 3/3**（phase 488+490+492）/ G1-G5 锁定 18 原则推力 align verify / NEW 3 文件（edit + multi_edit + sync-backup shared）+ write.ts refactor + profiles.ts subagent+miner +EDIT+MULTI_EDIT + tool-names.ts + 2 NEW 测试 / 12 文件 ~600-750 行 / **r53+ §10 应然完整落地**（Cluster A 4 phase 481+482+483+485 + Cluster B 4 phase 487+488+490+492 = 8 phase 总收 / 5 月 5 日单日完成 phase 481-492）/ **NEW 工具 phase 模板**（同 phase 446 StatusService / phase 470 ask_caller / phase 477 notify_claw）/ **shared helper 抽出模板**（backupToSync 4 source / NEW 基础设施 phase → caller phase 改用模板累 6 实证 / **必硬化升格独立 feedback**）/ **double cluster design+code 联动 5 阶段最大形态完整闭环模板第 2 实证**（phase 479→481+482+483+485 + phase 487→488+490+492）/ phase 号 race 累 9（phase 491 race step-executor 拆分）|
- 2026-05-08 / phase 537 §A.9+§A.10 cross-claw 隔离 closed（main `47fdb542` / r65 B fork / 起步 SHA `81275057` / 主会话 Step A design + user Step B+C code）/ §7.A.invariant 加 2 行硬约束（trailing-sep prefix 守护 + fullyReadPaths 同 claw 写闸隔离 / cross-claw 不入）+ §7.A 加 A.9 read.ts:84 兄弟前缀逃逸（α 单点小改 5/5 原则一致 / align ls.ts:79+search.ts:180）+ A.10 cross-claw read 污染 fullyReadPaths（γ 不 add 5/5 一致 / 不动 ExecContext schema）/ 与 l6_cli §A.spec-2 同 phase（CLI 标识符 traversal 守护）/ commit 8 files +195 -4 / **「业务决策性 → 原则 derive 自决 → r+1 code phase 落地」第 N 实证累**（phase 520+521+522+531+537）/ **「same-root cluster 跨 2 模块（L2+L6）单 phase 治理」候选 feedback**（推累 ≥ 2 实证升格）|
- 2026-05-08 / phase 545 G fork r66 §B clawspace 占用 (3)+(6) closure（design only / 0 src）/ (3) 通知通道 5/6 原则 lock B 应然（升档条件登记 = claw-side handler 实施时 reopen）/ (5) write_backups closed by phase 490 (A.6 同源)/ (6) 配置 DI effectively closed by phase 490（FileTool size limits 删 / 0 config 概念）+ 现有 yaml DI（disk-monitor.limitMB at assemble.ts:511）/ **6/6 全 closed**（phase 476 复审 4 + phase 490 (5)+(6) + phase 545 (3)+(6)）/ 与 l5_cron §7.B B.6 closure 同 phase / **「relay phase 影响 design 闭口连环」**（phase 490 → phase 545 G.2 (5)+(6) closure / phase 542 → phase 545 G.1 closure）/ **「design closure phase 单 Step A 形态」累 N 实证**（phase 503+505+545）/ 「业务决策性 → 28 原则核 5/N derive → dominant 自决」累 7（phase 520+521+522+531+537+542+545）

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
  - **位置**：`clawDir/tasks/sync/`（跟 CommandTool exec_overflow 共用 dir / sync 工具副产物统一存储 / 装配-level 约定不归 AsyncTaskSystem own）
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
- **edit 与 overwrite 知情门设计意图一致 cascade**：overwrite gate = `fullyReadPaths` 集合（agent 必须知全文）/ edit gate = `old_string` 精确字面（agent 必须知 old_string 字串 / 0 match 拒绝即天然门）/ 两者都强「事前知情」/ 详 §10.5 第 6 节

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

### 10.5 edit【✅ 已实施（phase 492 / main `0dec4f5b`）】

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
  - **vs §10.2 overwrite 强制 fully-read 一致性**：edit 与 overwrite 不同型 / overwrite 替换全文（agent 必须知全文才能确认覆盖意图 / fullyReadPaths gate）/ edit 替换 old_string 子串（agent 必须知 old_string 精确字面才能匹配 / `old_string` 自带知情验证 / 0 match 拒绝即天然门）/ 两者设计意图一致：「事前知情才允许写」
- **不重复 write 的 create 能力**：edit 只改既有文件 / 创建走 write
- **partial modify 路径**：`main claw → spawn(prompt="改 path 的 X 为 Y") → 子代理 read+edit / multi_edit → 异步回 inbox 结果`
- **backup 依赖 §A.6 治理**：「跟 write 同型 frontmatter」依赖 §A.6 写备份机制改造（实然 `.versions/` per-dir / 应然 `clawDir/tasks/sync/<id>` 集中 + frontmatter）/ edit 落地 code phase 同步治 §A.6

### 10.6 multi_edit【✅ 已实施（phase 492 / 同 §10.5 同 phase）】

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
  - **依赖 §A.6 sync 备份机制改造**（同 edit / 实然 `.versions/` per-dir / 应然 `clawDir/tasks/sync/<id>`）
- **vs 多次单 edit 的中间态风险**：单 edit 串行调用 / claw 中途 crash / 文件停留在中间态。multi_edit 单次原子写消除此风险

### 10.7 跨 claw / 跨 clawDir 不在本工具通道（防 future drift）

| 场景 | 路径 | 备注 |
|---|---|---|
| 自己 workspace 操作（默认）| 工具通道 / bare path / `read/write/search/ls/edit/multi_edit` | path 默认 resolve against workspaceDir / **主代理 + 子代理共享 default = clawspace/**（phase 518 align / subagent 是 caller 延伸 / 不再是另一 claw）/ subagent 推荐用 `cwd: 'tasks/subagents/<my-id>'` 创建临时文件（教学建议 / 非 strict）|
| 自己 claw 内其他子目录（MEMORY.md / memory/ / contract/ / logs/ 等）| 工具通道 + `cwd: '<rel\|abs>'` | `cwd: '..'` 访问 claw root / `cwd: 'memory'` 访问 memory subdir / phase 517 NEW `cwd` 参数（同 exec 模式）|
| **跨 claw read（specific target）** | 工具通道 read tools 含 `claw: "<id>"` 参数 | phase 514 解禁 motion-only / D11 互访 align / 任意 callerType 可用 |
| **跨 claw broadcast (`*`)** | 工具通道 search 含 `claw: "*"` 参数 | Motion-only privilege 保（D11 motion 单向访问设计）|
| 跨 claw write | **不支持工具通道**（write 工具无 `claw` 参数）| 写隔离（per-claw enforcement）/ cross-claw write 推 r+1+ 业务决策 |
| motion 跨 clawDir 内部（contract/ inbox/ stream.jsonl 等）| **系统信息通道**（系统按需推送）| 不归工具通道 |

**设计原则锚点**（phase 517 后更新）：
- 工具通道 mental model 极简：所有工具（exec + 6 file tool）默认 base = `ctx.workspaceDir` / bare path 即可 / 同 mental model
- LLM 不需思考「我在哪 / 跨权限是啥」/ 路径就是 workspace 内
- **path 解析模式同 exec 模式**：`cwd?: string` 参数显式 override base（默认 workspaceDir / `cwd: '..'` claw root / `cwd: '<subdir>'` 同 claw 子目录 / 绝对路径直透）
- L1 FileSystem 不内化分布式（保 L1 干净 / 分布式归 caller cascade in tools 层 / `claw` 参数走 cross-claw 独立 branch）
- **D11「claw 互访」** code 落地：read tools `claw: "<id>"` 任意 callerType（specific target / phase 514）/ broadcast `*` Motion-only
- 写隔离：write tools 无 `claw` 参数 / cross-claw 不可写 / 防意外污染
- **NEW shared helper `resolveWorkspacePath(ctx, path, cwd?)`**（phase 517 / 6 file tool 共用 / clawDir-rel 输出供 ctx.fs + PermissionChecker）

### 10.8 跨工具偏好不在本节（归系统信息通道）

工具 description **只写工具自身决策需要的信息**（自含信息）。跨工具偏好（如「用 write 不用 exec: cat」/「用 search 不用 read+grep」）归 AGENTS.md 等系统信息通道写 / 不在工具 schema 描述里。

判据：
- ✓ 写 schema：`tasks/sync/` 自动备份（write 自身事实）/ offset 负数从末尾倒数（read 自身入参语义）
- ✗ 不写 schema：「优先 write 不用 cat」（跨工具）/「200 行 / 8000 字符」具体阈值数字（让 metadata 反馈）

### 10.9 待统一深度讨论

- 失败语义错误文本 keyword 表（5 工具统一）/ agent 决策路径（哪些可重试 / 哪些终态）
- 跨 claw 走 CLI 的具体 CLI 形态（命令名 / 参数 / motion 用 exec 调的 invocation 模板）
- 系统信息通道（motion 跨 clawDir 内部 / claw 看 contract/ status / dispatch-skills 装配 等）的设计
