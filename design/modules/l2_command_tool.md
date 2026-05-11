# CommandTool 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2c.md](../interfaces/l2c.md) CommandTool 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §17「CommandTool 本质：agent 命令工具服务 / L2 agent 语义基础设施 / 把『命令能力 expose 给 agent』封装成可重用基础服务 / 知 agent 概念（agent 自由命令需 sandbox）」加 M#1 / M#2 / M#3 / M#5 / Philosophy「上下文工程」加「系统为智能体服务」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），CommandTool 的单一职责 = **把 OS 进程执行能力翻译为 agent 友好的工具调用**：

- **agent 命令工具**：exec 工具暴露给 agent — 这是「命令能力 expose 给 agent」业务概念。
- **上下文工程**（核心 / Philosophy 直接 derive）：stdout / stderr 截断加截断兜底落盘 — 防 agent 上下文窗口被一次性大输出撑爆。
- **agent UX**：失败附 cwd hint 防 LLM 路径上下文幻觉 — 帮 LLM 自纠（D「不丢弃 / 静默」derive）。
- **可选准入约束**：装配期注入 allowList / denyList / 命中拒绝软失败返 ToolResult — 让装配方按业务策略给 agent 加准入限制。
- **错误统一转 ToolResult**：任何错误转结构化 ToolResult 不抛框架边界（M#10 derive）。

> 具体 API 形态归 [interfaces/l2c.md](../interfaces/l2c.md) CommandTool 节。具体实现细节（command 整体 string 不拆 argv 加 cwd 默认 clawspace 加合并 output 加 sync 落盘等）的存在依据是「OS 进程执行翻译为 agent 工具」原语 — 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own OS 进程能力原语**（exec / spawn / kill 等归 L1 ProcessExec）— derive 自 M#1 独立可变职责 + M#5 单向依赖（业务模块不直接 import OS API）
- **不 own 工具注册加派发加框架级超时加 tool_exec audit**（归 L2 Tools 框架）— derive 自 M#1
- **不 own caller 权限策略**（哪个 caller 能用 CommandTool 归 L6 Assembly 装配期）— derive 自 M#5
- **不 own 工具 schema 协议**（归 L2 ToolProtocol）— derive 自 M#1
- **不 own shell 解析**（`~` 展开加 env var 替换归 shell 自身）— derive 自 M#1
- **不 own shell mode 选项暴露**（caller 在 command 里显式 `bash -c` 自负 OS 差异加 injection 风险）— derive 自 M#8 耦合界面最小
- **不 own env 字段**（L1 ProcessExec 未支持）— derive 自 M#8
- **不 own cwd 权限校验**（caller 保证可访问）— derive 自 M#1
- **不 own 上下文 budget 加截断阈值常量来源**（EXEC_MAX_STDOUT / EXEC_MAX_STDERR 等归 L6 Assembly 装配期 own 加注入）— derive 自 M#5
- **不 own 命令黑白名单 const**（具体 list 由 L6 Assembly 装配期 own 加注入）— derive 自 M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），CommandTool 的业务语义边界：

- **own**：「OS 进程 exec 能力翻译为 agent 工具调用」业务语义 — 含上下文工程（截断 + sync 兜底落盘）加 agent UX（cwd hint 防幻觉）加准入约束加错误透传。这些是 CommandTool 唯一懂的「业务」（agent 命令工具级）。
- **角色定位**：CommandTool 是「**agent ← OS proc 翻译层**」非「**通用进程执行库**」。专为 agent 自由命令设计 / 不可信命令翻译为受限子进程调用。
- **失败语义 owns**：准入拒绝 → 软失败 ToolResult / spawn 失败 → 软失败 / 超时 → 软失败 / 进程非零退出 → success=true 透出 metadata.exitCode（执行完成由 caller 判读）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），CommandTool 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 工具执行无状态（每次 execute 独立）|

**无磁盘资源** — CommandTool 是 OS 进程执行 → agent 工具的翻译层 / 不 own 业务资源（无连接池 / 无进程跟踪 / 进程生命周期 100% 委托 L1 ProcessExec）。

> 注：(1) **写入 syncDir** = `clawDir/tasks/sync/`（应然 phase 507+：CommandTool 写到 `tasks/sync/exec/<uuid>.md` 子目录 / 与 FileTool `tasks/sync/write/` 子目录区隔 / 装配方注入 syncDir base + 本模块拼 `exec/` 子目录 / 两工具皆为写入方非 owner / lifecycle 归 Snapshot 触发清理）/ (2) agent 命令工具 schema + execute 实现集中 `src/foundation/command-tool/exec.ts`（实施细节归 §1.做 + §10 / 非 M#3 业务资源）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），CommandTool 自身的持久化立场：

- **模块零状态**：CommandTool 不持自有运行时状态 — 工具执行无状态（每次 execute 独立）。
- **截断兜底落盘**：超阈值时 head + tail 显示 + 完整 output 落装配方注入的 syncDir / 路径约定归装配方 / 本模块仅写入 — 让事后可审计 + 上下文可控双保。

## 5. 审计事件清单

> 事件常量集中定义于 `COMMAND_TOOL_AUDIT_EVENTS`（模块自治）。

应然：本模块不直接产 audit —— 通用执行事件由 L2 Tools 框架的 `tool_exec` 覆盖。

候选业务事件（升档候选）：

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `command_tool_command_rejected` | 命中 denyList / 不在 allowList | `{ command, matched: 'deny' \| 'not-in-allow', pattern }` |

升档条件：观察到拒绝在生产中无声发生 / 安全审计需粒度查证时新增。

## 6. 层级声明

L2 基础设施（agent 语义子层 / 含 agent 业务概念）。下游 L3+（StepExecutor / AgentExecutor / SubAgent）通过 ToolRegistry 间接消费 / 不直接 import。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 模块物理不存在~~ ✅ closed | structural drift / 高 | **✅ closed**（phase378 / main `14c7767`）| ~~exec 工具源码位于 builtins/exec.ts~~ → α 落地：物理迁 `src/core/tools/builtins/exec.ts` → `src/core/command-tool/exec.ts`（git mv 保 history）+ NEW `src/core/command-tool/index.ts`（createCommandTools 工厂 + CommandToolModule + CommandToolDeps 接口预留）+ Assembly 显式 register（assemble.ts 经 commandTools.exec）+ builtins/index.ts 删 execTool 3 处 / 同根 drift 跨视角对齐模板第 2 实证（phase374 首发 derive + phase378 实施落地）/ M2 反向测试通过 / M11 边界对停下 / cross-ref l1_process_exec §A.3 ✅ |
| A.2 准入策略缺失 | semantic drift / 高 | **partial closed**（phase378 接口预留 / 真实装推 r52+/r53+）| 应然：装配期注入 `allowList?` / `denyList?` 命令准入约束（M#11 边界对不上停下 / D7 系统可信路径）/ phase378 落地：`createCommandTools` 工厂签名预留接口（`CommandToolDeps`）/ 真实装（命令匹配 + 拒绝路径）推 r52+/r53+ 业务决策 |
| ~~A.3 profile 暴露过宽~~ | ~~scope drift / 中~~ | **✅ closed**（phase 481 / main `ba66d039`）| ~~应然契约 §5：exec 仅 `full` profile / 实然 `profiles.ts:41-46` 暴露在 `full` / `subagent` / `miner` / `verifier` 4 profile（verifier 暴露最值得关注：read-only 角色不应有 exec）~~ → phase 481 实测核：verifier 0 真 caller 通过 profile gate（ContractSystem `manager.ts:1278-1281` 直 build empty registry + register `ReportResultTool` / system prompt 明确「Do NOT execute tasks」/ TOOL_PROFILES['verifier'] 0 业务 caller）/ EXEC_TOOL_NAME 是**应然 spec 幻象**（同 phase 414c statusCommand 同型 / framing_overturn §应然 spec 幻象子形态）/ 删 dead spec / 0 行为改 / align 应然 §10.1 §5「exec 仅 full profile」。subagent + miner 仍含 EXEC（应然 §5 silent on 这两个 / 不在本 phase scope）。**应然 spec 幻象 cleanup 累 2 实证**（phase 414c + 481 / 推 r+ Meta 升格 framing_overturn §应然 spec 幻象子形态独立 feedback）。**G2 phase 479 推迟 → phase 481 实测核锁定模板首发**（推 r+ Meta 升格「推迟决策的实测核 follow-up 模板」）|
| ~~A.5 stdout+stderr 拼接 `[stderr]:` 标记 → 应然时序合并~~ | ~~semantic drift / 高~~ | **✅ closed**（phase 483 / main `9edb895c`）| ~~§10.5 决策：exec 默认返时序合并 output / 实然 `exec.ts:69-72` 是事后拼接 stdout+stderr 加 `[stderr]:` 标记 / 行序丢失~~ → phase 483 实施：L1 process-exec/exec.ts 改 child_process.spawn 替 execFileAsync / 双 stream 'data' event 同 callback 推 buffers / Buffer.concat utf-8 decode / **时序合并保留**（NEW 测试 verify）/ ExecResult schema stdout+stderr → output 单字段 / ProcessExecError 同改 / L2 command-tool 删 `[stderr]:` 拼接 + 删 stderr 单独 truncate / caller cascade 10 文件（snapshot stderr→output / git-errors classifyGitError substring match 兼容 / contract manager+acceptance err.output / tests mock spawn EventEmitter 重写）/ **副产物**：snapshot 'nothing to commit' git stdout 内容现在能 match（之前漏 / 仅看 stderr）。**3 原则全 align**：D5 信息不丢失 + M#1 独立可变职责（双流→单流归 L1）+ D7 OS truth 可信路径。|
| ~~A.6 截断阈值 8000 → 应然 ~2000~~ | ~~param drift / 中~~ | **✅ closed**（phase 483 / 同 A.5 同 phase）| ~~实然 EXEC_MAX_STDOUT=8000 / EXEC_MAX_STDERR=500~~ → phase 483 实施：删 EXEC_MAX_STDOUT + EXEC_MAX_STDERR / 加 `EXEC_MAX_OUTPUT = 2000`（合并后单一阈值 / G3 derive）/ command-tool 截断逻辑简化（单一 output truncate）。**M#7 稳定**（单常量替双常量）+ **M#8 最小**（更小耦合界面）。|
| ~~A.7 截断兜底落盘机制全新~~ | ~~feature gap / 高~~ | **✅ closed**（phase 485 / main `9b703d7e` / merge `5e687e65`）| ~~应然 §10.4 新机制：截断时落 `clawDir/tasks/sync/<id>` 完整合并 output + frontmatter (source=exec_overflow + content_length) + head+tail 截断 + 单一规则 + turn-scoped lifecycle + 跟 FileTool 共用 sync dir~~ → phase 485 实施：(1) ExecContext +`syncDir: string` 字段（装配-level 共享 dir）/ Assembly + motion bootstrap 装配 = clawDir/tasks/sync (2) command-tool truncateHeadTail (HEAD=600 + TAIL=1400 + 字节标记) / persistOverflow (uuid8 + frontmatter `source: exec_overflow`+content_length+created_at) / 失败 case 同型落盘（应然 §10.4 单一规则）/ ToolResult content 加 `Full output saved to: <relPath>` 提示 (3) Snapshot ctor +syncDir + commit success 后 generic clean syncDir / cleanup 失败 best-effort 不抛 + audit SYNC_CLEAN_FAILED (4) SNAPSHOT_IGNORE_PATTERNS 加 tasks/sync 防 commit 循环。**Cluster A r+1 收官**（4/4 全闭 / phase 481+482+483+485 / r53+ §10 应然完整落地）。**3 原则全 align**：M#3 资源唯一归属（syncDir 装配级共享 / 不归 AsyncTaskSystem own）+ M#1 副产品归本模块（command-tool 自检 / Snapshot 自身清）+ M#5 防反向注入 handler（强排除 Assembly handler 注入选项）。共享 dir：跟 FileTool write_backups 共用 tasks/sync（应然 §A.6 / Cluster B file_tool phase 推 r+1）|
| ~~A.8 env 字段 schema 暴露 → 应然砍~~ | ~~scope drift / 低~~ | **✅ closed（phase402 / main `31b5b00a`）** | 应然 §10.2「不接受 env」（YAGNI / L1 ProcessExec 未支持）/ 实施：删 exec.ts:43-46 schema env 字段 + 58-59 dead 注释（共 -6 行）/ framing 精化：实然本就 0 args.env 提取 / 0 传 ProcessExec / dead 量小于估（dispatch 估含「execute 提取代码」/ 实测 0 处）/ 反向 phase378 §A.4 部分决策（YAGNI 收紧）/ 同步 line 55 ExecArgs + line 169 M#8 删 env? 字段（应然内部一致性）|
| A.9 AGENTS.md exec 段单工具信息越界（cross-doc）| doc drift / 低 | cross-ref | 信息架构原则：单工具信息归工具 description / AGENTS.md 仅补跨工具教学。AGENTS.md 现文「exec is only for: ...」段落含多项 exec 单工具信息越界：(1) 「Synchronous mode (default): blocks until result, up to 120 seconds」timeout drift（实然 30s 先触发）+ 单工具信息（应归 description / 实际 description silent on timeout 数值 = 防双源 drift / 用户调参不破契约）/ (2) 「⚠️ exec is non-idempotent」非幂等警告 = 单工具规则（应归 exec description / §10 已加「Read the file instead of re-running — some commands have side effects」覆盖）/ (3) 「Async mode: add async: true ...」async meta 用法 = 跨工具教学（A 类 inherently / B 类 sync+async-meta / C 类 sync-only 三分类）/ 应保留但移到通用 async meta 段（不绑死 exec）。drift 不在 CommandTool 契约范围（AGENTS.md 归系统信息通道）/ 此处仅 cross-ref 备忘 / 待 AGENTS.md 治理 phase 按信息架构重排 |
| ~~A.4 args schema 与契约脱节~~ ✅ closed | interface drift / 中 | **✅ closed**（phase378 / main `14c7767`）| ~~仅 command + timeout + dead async~~ → α 落地：schema 加 `cwd?` + `env?` / `timeout` → `timeoutMs` 重命名 / 删 dead `async` 字段 / execute 函数 args.cwd ?? ctx.clawDir + args.timeoutMs 提取 + args.env 注入 / 行为契约扩 D1d（修 bug 副作用 / dead 字段清 + 命名对齐）|
| ~~A.10 code 命名 drift `ShellTool` ↔ 应然 `CommandTool`~~ | naming drift / 中 | **✅ closed**（phase421 / `1f2c06e6`）| **应然权威 = architecture.md §17 + 多表「CommandTool」**（modules.md / interfaces/l2c.md / 本文件全 align）。实然 phase378 物理迁时 commit author 采用 `ShellTool` 命名（commit `14c7767` 标题 = "physical relocation L2 ShellTool"）/ 实际目录 `src/core/shell-tool/`（非 §A.1 status 所述 `command-tool/`）/ 工厂 `createShellTools`（非 `createCommandTools`）/ `@module L2.ShellTool` 注解 / 引「应然单源：design/modules/l2_shell_tool.md」（该文件不存在）。**phase421 实施**：git mv `src/core/shell-tool/` → `src/core/command-tool/` 保 history + 4 token rename（`ShellToolModule`→`CommandToolModule` / `ShellToolDeps`→`CommandToolDeps` / `createShellTools`→`createCommandTools` / `ShellTool`→`CommandTool`）+ 2 caller 改（assemble.ts + builtins.test.ts）+ `@module L2.ShellTool` → `@module L2.CommandTool` + 「应然单源」path align / 0 行为改 / **闭 phase378 commit author naming drift 核心案例 / 反向 rename 第 4 例**（phase416/417/418 + 本 phase）/ §A.1 status 行 path 描述当时已与实然不符（已被本条覆盖 / 不二次修史）|
| **A.11 CommandTool cross-layer location drift** | layer drift / 中 | **✅ closed（phase433 / main `9843fbc8`）** | 应然 = L2 模块物理位置 = `src/foundation/`（与 dialog-store / skill-system / file-tool / process-manager / tools / messaging / audit / snapshot / stream / llm-orchestrator 全 align）。实然 phase378 起 dir 在 `src/core/command-tool/` (L4 location for L2 module) / phase421 反向 rename 时保 dir 不动 / 仅改 ShellTool→CommandTool 名 / 未触动 cross-layer。phase433 实施 3 阶段同 commit：(1) git mv 2 file `src/core/command-tool/{exec,index}.ts` → `src/foundation/command-tool/`（保 history）+ rmdir 旧 dir (2) 内部相对 import path 修（`'../../foundation/{tools,process-exec}/'` → `'../{tools,process-exec}/'`）(3) 2 caller cascade（assemble.ts + tests/core/builtins.test.ts）/ 0 行为改 / 1370+ 测试 PASS / **L2 cross-layer drift 全收 6/6**（phase420 SkillSystem + phase423 DialogStore + phase425 PM 工厂 + phase428 FileTool + phase431 Tools + 本 phase）/ foundation/ 0 反向 cross-layer to core/ 验证通过 |
| ~~**A.12 spawn 子代理工具注册缺失**~~ | ~~functional gap / 高~~ | **✅ closed（phase475 / main `805983ba`）** | ~~AsyncTaskSystem 构造函数创建空 registry（`new ToolRegistryImpl()` + `registerBuiltinTools()` 空函数），未从 Runtime registry 复制工具 / 导致 spawn 子代理的 effectiveRegistry 为空 / LLM 收不到 tools 参数 / 子代理无法调用任何工具（exec/read/write 等全失效）~~ → phase475 根治：AsyncTaskSystemOptions +registry 必填 / Assembly 装配期注入 / `registerBuiltinTools` no-op + 整 `src/foundation/tools/builtins/` dir 删（dead code）/ subagent 0 tool_use bug 根治 / 详 [l4_task_system.md A.12](l4_task_system.md) 权威单源（本条仅交叉登记 / 同根 drift 跨视角对齐）|

A.1 + A.2 + A.4 修复路径（合并独立 phase / 与 FileTool A.1 / l1_process_exec A.3 治理目标对应）：
1. 物理迁 `src/core/tools/builtins/exec.ts` → `src/core/command-tool/exec.ts`
2. 抽 `createCommandTools({ processExec, allowList?, denyList?, defaultTimeoutMs? })` 工厂
3. Assembly 装配点改调工厂 + 注册 exec
4. schema 补 `cwd` / `env` / 重命名 `timeout` → `timeoutMs` / 删 dead `async` 字段
5. modules.md 依赖图 + L2 Tools §7 同步去 builtins/exec.ts
6. profiles.ts 缩窄 exec 至 `full`（A.3 同步）/ 若产品方决定保留多 profile，升档为契约修订而非代码改

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| CommandTool 显式 `sh -c` 包装（phase 482 后） | L1 ProcessExec.exec 已删 sh -c 隐式包装（phase 482 / `1d3e7a77` / l1_process_exec §A.4 closed）/ sh 包装现 L2 CommandTool 显式 `exec('sh', ['-c', cmd], ...)` (`command-tool/exec.ts:56`) / agent description 仍「Runs via `sh -c` on Unix」（caller 显式 sh 自负合规模式 / 不算 L1 leak）/ Windows 无 cmd 分支 | 出现 Windows 部署需求 → 加 cmd 分支或换 PowerShell |
| 输出截断硬编码 8000/500 字节 | exec.ts:17-20,62-63,94-95 / 框架级 ToolResult 截断 / 不可装配期配置 | 若 agent 抱怨被截 / 长输出业务出现 → 升档作为装配参数 |
| cwdHint 错误兜底信息 | exec.ts:73,78,89,99 在错误返回里附 `cwdHint` / 应然契约 silent 但实然采选「帮助 LLM 自纠」 | 已合规默认行为 / 若契约要明确语义 → 升档为接口约束 |
| command-tool 借 ProcessExec.DEFAULT_TIMEOUT_MS | `src/core/command-tool/exec.ts:41` description 字符串引 `PROCESS_EXEC_DEFAULT_TIMEOUT_MS` / 应然「command-tool 工具默认 timeout 是 command-tool 自身业务决策」/ 实然借 ProcessExec 内部运维常量 / M#7 弱违反（跨模块耦合 operational 值） | command-tool 默认 timeout 与 ProcessExec 内部 clamp 范围不同步时 → command-tool 自治默认值 / 推 r62+ LLM 拆模块 design phase 顺手清理 |
| ~~cwd 相对路径解析失败~~ | ~~drift~~ | **✅ closed (phase 506 / commit `87148671`)** | exec.ts:80 改 `cwdArg ? path.resolve(ctx.clawDir, cwdArg) : path.join(ctx.clawDir, 'clawspace')` / 相对路径以 clawDir 为基准 resolve align file_tool / 绝对路径不变（path.resolve 对绝对路径返回原值）/ NEW test verify |
| ~~**工具默认路径不一致（`exec` cwd ≠ `read`/`write` 默认路径）**~~ | ~~drift / 中~~ | **✅ closed (phase 506 / commit `87148671`)** | exec.ts:80 改 默认 cwd = `path.join(ctx.clawDir, 'clawspace')` / 与 read/write/search/ls 默认 align（全 default `clawspace/`）/ description + schema cwd 同步「clawspace/ directory」/ cwdHint 改报真 cwd（非 ctx.clawDir）/ 28 原则核：M#3 资源唯一归属 + D7 系统内部走可信路径 + AGENTS.md 「优先 clawspace」一致性 / 需要 clawDir 访问显式 `cwd: '..'` 或绝对路径 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：「agent 调用外部命令」语义独立 / 不与其他工具共变
- M#2 业务语义归属：命令准入策略（allow/deny）归本模块 / 不下沉 L1
- M#3 资源唯一归属：本模块无资源；进程资源归 L1 ProcessExec
- M#4 持久化：无状态 / 不涉及
- M#5 依赖单向：L2 → L1 ProcessExec + L2 ToolProtocol（Tool / ToolResult schema）（per arch §17 表 1）/ 不上引 L3+ / 不直 dep L2 Tools 框架（由 Assembly 装配期 register 进 ToolRegistry）
- M#6 依赖结构稳定：装配期固化 allow/deny / 运行期不变
- M#7 耦合界面稳定：1 工具对象 + Tool 协议为对外表面
- M#8 耦合界面最小：跨边界只传 `{ command, cwd?, timeoutMs? }` / 不暴露 shell mode
- M#9 显式编译器可检：所有签名 type-only / 准入拒绝走类型化 ToolResult
- M#10 不合理停下：工具边界吸收 spawn / 超时错误 / 不让原生异常逃逸框架
- M#11 边界对不上停下：发现 allow/deny 不足以表达准入策略时停下重构（不在工具内 ad-hoc 加白名单）

**Design Principles**

- D1a-d 信息不丢失 / 状态可观察 / 中断可恢复 / 事后可审计：tool_exec 框架审计覆盖 / 准入拒绝走 ToolResult 留痕
- D2 不丢弃 / 静默：所有 spawn/超时错误转 ToolResult / 不静默吞
- D3 用户可观察：tool_exec audit + 兜底落盘文件可观察
- D4 LLM 调用恢复：N/A（本模块不调 LLM / 工具 sync 或 async 经 AsyncTaskSystem）
- D5 日志重建：tool_exec audit 序列 + tasks/sync/ 兜底落盘可重建命令执行链路
- D6 子代理后不阻塞：N/A（async meta 经 AsyncTaskSystem 调度 / 本模块仅 exec 实现）
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 2 轮 src 实测核 align）：所有走 AsyncTaskSystem subagent-executor 路径子代理（spawn/dispatch 智能体调度工具 + retro/random_dream 系统调度 / ask_caller 是子代理内部询问 main caller 工具不调度新子代理 / 不在本继承范围）经 `main registry.getForProfile('subagent')` 派生子 registry / **CommandTool exec module-level const 同源 reuse**（实然 `createCommandTools(_deps)` deps 完全 ignored / 总返同 execTool / 0 caller 配置语义 / phase378 deps 接口预留 0 实装 / phase 52+ 实装后才有「同配置」语义）+ **ctx.clawDir 透传** → cwd 默认 `${ctx.clawDir}/clawspace/` 自动 align / exec 边界 100% 隐式 align caller / 非字段透传机制 / 例外：ContractSystem.verifier-job 不走 AsyncTaskSystem（empty registry + 0 CommandTool / 不存在继承语义）/ deep_dream 不创 SubAgent N/A
- D7 系统可信路径：profile (`full` 限定) + allowList / denyList 兜底
- D8 事件驱动：N/A（被动框架 / 不发事件）
- D9 CLI 唯一外部入口：N/A（本模块不与外部直接交互 / 全经 Tools 框架）
- D10 多 claw 不隔绝：N/A（cwd 默认 clawspace / 跨 claw OS 操作走 motion CLI 中介 / 详 §10.7）
- D11 motion 特殊：N/A（exec 不持 identity 分支）

**Philosophy**

- **P1 Agent 即目录**：cwd 默认 `<clawDir>/clawspace/` + 兜底落盘 `clawDir/tasks/sync/` 是 agent 命令执行目录锚点
- **P2 上下文工程**：**核心驱动**（截断阈值 + 兜底落盘 / 防 agent 上下文窗口被一次性大输出撑爆 / 大输出引导 spawn 子代理处理）
- **P3 分多个智能体加分子任务**：长输出 / 长任务自然引导 spawn 子代理（async meta + AGENTS.md 教学）
- **P4 系统为智能体服务**：把 OS shell 复杂度收敛到工具边界 / agent 看简单语义

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：§7.A 修复 phase 必先 Path #1 核 builtins/exec.ts 现状（治理动作要 grep 实然代码佐证 / 注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立换 ProcessExec 实现而不动 caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-26 / r31 新建模块契约（应然 / 实然 split）
- KD#27 业务语义按 α.1 决策声明归 CommandTool 模块（modules.md 决策映射）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Design Principles D8「CLI 唯一入口」错位修：D8 verbatim「事件驱动」+ D9「CLI 唯一外部入口」+ 加 D3-D7+D10-D11 显式 align principles.md / §3 资源改 table 「无」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim + Module Logic 命名 已正确）
- 2026-05-05 / §A.12 同根 drift 跨视角对齐（l4_task_system.md A.12 已 closed phase 475 / `805983ba` / 本文件 A.12 标 closed + 引权威单源 / 0 src 改 / design doc internal stale 治理）
- 2026-05-05 / phase 479 design phase（Cluster A exec 通道 / G3+G4+G5 锁定 / §A.5+§A.6+§A.7 closed-design 推 phase 482+483 / G2 §A.3 推迟 r+1 实测 verifier subagent 实然行为再定 / G1 涉 L1 见 l1_process_exec §A.2+§A.4）
- 2026-05-05 / phase 481 verifier EXEC_TOOL_NAME dead spec 删（main `ba66d039` / 应然 spec 幻象 cleanup / G2 phase 479 推迟 → 实测核锁定 / 1 行 src 删 / 0 行为改 / 第 2 实证（phase 414c statusCommand 后））
- 2026-05-05 / phase 483 L2 stdout/stderr 时序合并 + 单一阈值落地（main `9edb895c` / G3+G4 phase 479 锁定 / L1 spawn 重写 + ExecResult.output schema breaking + EXEC_MAX_OUTPUT=2000 单常量 / 10 文件 ~150-200 行 / 时序合并 NEW 测试 verify / 副产物 'nothing to commit' git stdout match 隐 bug 顺手修 / Cluster A r+1 第 3 phase 落地（4/4 拆完 3/4））
- 2026-05-05 / phase 485 exec 截断兜底落盘 + Snapshot 清 sync 落地（main `9b703d7e` / merge `5e687e65` / G5 phase 479 锁定 / **Cluster A r+1 收官 4/4**（phase 481+482+483+485）/ NEW 基础设施：ExecContext +syncDir + Snapshot ctor +syncDir + commit success generic clean hook + command-tool truncateHeadTail (HEAD=600+TAIL=1400) + persistOverflow (frontmatter source/content_length/created_at) + Assembly+motion 装配 syncDir + SNAPSHOT_IGNORE_PATTERNS 加 tasks/sync 防循环 / r53+ §10 应然完整落地 / phase 号 race 顺延 phase 484→485 实证累 6）
- 2026-04-29 / phase378 CommandTool 模块物理立首发（main `14c7767`）/ git mv `src/core/tools/builtins/exec.ts` → `src/core/shell-tool/exec.ts` (commit author 命名 ShellTool / phase421 后改 CommandTool) + NEW createShellTools 工厂 + CommandToolModule + CommandToolDeps 接口预留 + Assembly 显式 register / A.1+A.2 接口预留+A.4 schema 修同 phase / **同根 drift 跨视角对齐模板第 2 实证**（phase374 首发 derive + phase378 实施落地 / Meta 31 立 feedback）/ M2 反向测试通过 / cross-ref l1_process_exec §A.3 ✅
- 2026-05-01 / phase402 env 字段砍闭环（main `31b5b00a` / r58 D fork）/ 删 exec.ts:43-46 schema env 字段 + 58-59 dead 注释 / A.8 closed / framing 精化：实然本就 0 args.env 提取 / 反向 phase378 §A.4 部分决策（YAGNI 收紧）/ 同步 line 55 ExecArgs + line 169 M#8 删 env? 字段（应然内部一致性）
- 2026-05-04 / phase421 ShellTool → CommandTool 反向 rename + 物理迁闭环（main `1f2c06e6`）/ git mv `src/core/shell-tool/` → `src/core/command-tool/` 保 history + 4 token rename + 2 caller 改 + @module rename + 「应然单源」path align / A.10 closed / **反向 rename 第 4 例**（phase416/417/418 + 本 phase）/ **闭 phase378 commit author naming drift 核心案例**
- 2026-05-04 / phase433 CommandTool cross-layer location 闭环（main `9843fbc8`）/ git mv `src/core/command-tool/` → `src/foundation/command-tool/` 保 history + 内部相对 import path 修 + 2 caller cascade / A.11 closed / **L2 cross-layer drift 全收 6/6**（phase420 SkillSystem + phase423 DialogStore + phase425 PM 工厂 + phase428 FileTool + phase431 Tools + 本 phase）/ foundation/ 0 反向 cross-layer to core/ 验证通过
- 2026-05-04 / phase475 spawn 子代理 0 tool_use bug 根治同根 drift 跨视角登记（main `805983ba`）/ A.12 同根 drift（权威单源 l4_task_system.md A.12 / 本文件交叉登记）/ AsyncTaskSystem 不再 own ToolRegistry / Assembly 装配期注入 / `registerBuiltinTools` no-op + 整 `src/foundation/tools/builtins/` dir 删 / subagent 工具调用体系恢复
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_command_tool.md vs arch §17 + 表 1/2/3 + interfaces/l2c.md CommandTool 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D7 + D4/D6/D8/D9/D10/D11 N/A + Philosophy P1+**P2 核心驱动**+P3+P4 + Path #1-#7）/ exec 主能力 align arch 表 2 / 2 dep + caller Assembly + 耦合 shell mode 自负 align arch 表 1 / exec 工具 align arch 表 3 / 补 phase378+402+421+433+475 closure timeline entry / phase 479+481+483 r64 Cluster A 序列已记 / design only / 0 src 改
- 2026-05-05 / r65 重核补 §7.B 「sh -c 硬编码」偏差描述同步 phase 482 闭环（L1 ProcessExec.exec 删 sh -c 隐式包装 / sh 包装现 L2 CommandTool 显式 / l1_process_exec §A.4 已 closed）
- 2026-05-05 / phase 492 Cluster B 收官联动 milestone（main `0dec4f5b` / Cluster A 4 phase 481+482+483+485 + Cluster B 4 phase 487+488+490+492 = **r53+ §10 应然完整落地里程碑**（exec 通道 + file 工具 + 共享 syncDir 协议双 cluster 闭环 / 5 月 5 日单日 8 phase 完成）/ **shared helper backupToSync 抽出**（4 source 参 / write+edit+multi_edit+exec_overflow 共用 / phase 485 NEW 基础设施 phase → caller phase 改用模板累 6 实证 / **必硬化升格独立 feedback**）/ **double cluster design+code 联动 5 阶段最大形态完整闭环模板第 2 实证**（phase 479+487 双 design phase + 7 r+1 code phase 全闭）|

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#27 | Tools 声明式归属（exec 归 CommandTool / 与 FileTool / Messaging tools 平行） | ✅ closed phase378（A.1 物理迁 `src/core/command-tool/exec.ts` + createCommandTools 工厂 + Assembly 显式 register / main `14c7767`）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- exec 正常执行 / stdout+stderr 正确返回
- 超时（args.timeoutMs 优先于 defaultTimeoutMs / 与 ProcessExec 超时不重复触发）
- 非零退出（视作执行完成 / exitCode 透出 metadata）
- 命令不存在 / spawn 失败 → ToolResult.success=false
- allowList 命中 / 不命中拒绝
- denyList 命中拒绝 / 优先级高于 allowList
- 首 token 切分 + 正则模式匹配
- `createCommandTools` 工厂注入双侧契约（processExec / allow / deny / defaultTimeoutMs）
- 审计回链：每次 invoke 触发框架 `tool_exec`（由 L2 Tools 套件覆盖）
- 合并 output 返回（stdout + stderr 时序混合 / 应用层合并 / 跟 terminal 体验一致）
- 截断时（合并 output 超阈值）→ head + tail 显示 + 兜底完整落 `clawDir/tasks/sync/<id>` / metadata 给路径（相对 clawspace）
- 截断格式：head + `[...truncated XX bytes...]` + tail（偏向尾保错误诊断）
- 失败 cwdHint 必附（防 LLM 路径上下文幻觉）
- async 路径：`async: true` 走 `scheduleTool` / 立即返 taskId / 完成 inbox 投递（覆盖归 L4 AsyncTaskSystem 套件）
- `exec_output/` 文件归 claw 所有 / claw 自管理（系统不强制清理）

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 成功返回 / 副作用+跨通道 / profile准入+不变量）。失败语义留全工具集统一深度讨论。

### 10.1 exec

**1) 用途**

> 执行工具 —— 通用 OS 能力入口 / 跑测试 / 装依赖 / 调外部 CLI / git 操作 / 自定义 pipeline / 读 / 写 / 列 / 搜之外的常规任务都走 exec。

设计意图：
- exec 是 claw 的核心工具之一（不是兜底 / 是「OS 能力主通道」）
- 结构化文件工具（read / write / search / ls）专精文件操作 / **AGENTS.md 引导文件操作走结构化工具而非 exec**（`exec: cat/echo` 绕过 .versions 备份 + 大小限制 + 路径白名单）/ 文件操作之外的所有 OS 能力都用 exec
- 不预设 agent 能干什么 / 给最大灵活度 + 截断契约保 agent 上下文窗口

**2) 入参 schema**

```
- command    (string, required)    shell 命令字符串 / 整体经 sh -c 执行 / agent 自负转义
- cwd        (string, optional)    工作目录 / 默认 clawDir/clawspace/
- timeoutMs  (number, optional)    同步超时毫秒 / 默认 30000
- async      (boolean, optional)   异步执行 / 立即返 taskId / 完成经 inbox 投递（用法详见 AGENTS.md）
```

**关键决策**：
- `command` 整体一个 string / 不拆 argv 数组 / 让 agent 用 shell 完整能力（pipe / redirect / subshell）
- **`cwd` 默认 = `clawDir/clawspace/`**（与 file_tool 路径根对齐 / agent 心智一致 / 系统私域 .audit/.versions/.exec 自然不可见）
- `timeoutMs` 默认 30000（PROCESS_EXEC_DEFAULT_TIMEOUT_MS）/ agent 长任务标 `async: true`
- **不接受 `env` 字段**（YAGNI / 当前 L1 ProcessExec 未支持 / 加进 schema 反误导 agent）/ 应然反向 phase378 加 env 决策
- **`async` 在 schema 列入**（让 LLM 见到合法字段 / 防困惑）/ description 一行简介（不教用法 / 跨工具用法集中归 AGENTS.md）/ 实现层 step-executor.ts:564 提取 meta flag

**description 明文**（schema 内 / 每次 agent 看到）：
- 「Execute a shell command. Runs via `sh -c` on Unix.」
- 「Returns combined stdout + stderr in time order (like terminal output). To split or filter, redirect explicitly: `cmd 2> log.err` (split stderr to file) or `cmd 2> /dev/null` (drop stderr).」
- 「When output is truncated, head and tail are kept and the full output is saved to a file (path in result). Read the file instead of re-running — some commands have side effects.」

**3) 返回语义**

```
ToolResult { success: boolean, content: string, metadata?: { ... } }
```

承诺：单一 output 模型 / 不区分 stdout 和 stderr / 时序合并（应用层 / Node spawn 双 stream → 单 buffer 按 'data' event 到达顺序）/ 跟 terminal 体验一致。

| 场景 | success | content | 兜底落盘 |
|---|---|---|---|
| exit 0 / 短输出（< 阈值）| true | 完整合并 output | 0 |
| exit 0 / 超阈值 | true | 头 N + `[...truncated XX bytes...]` + 尾 M + 「full output saved to: <path>」 | `clawDir/tasks/sync/<id>` 完整合并 output |
| exit ≠ 0 / 短输出 | false | 完整合并 output + error message + `[cwd]: <path>` | 0 |
| exit ≠ 0 / 超阈值 | false | 头 N + `[...truncated XX bytes...]` + 尾 M + error + cwdHint + 路径 | `clawDir/tasks/sync/<id>` 完整合并 output |
| sync timeout kill | false | partial 合并 output（kill 前已收到的）+ timeout error + cwdHint | 超阈值时落盘同上 |
| async 调度 | true | 「Async task queued. Task ID: <x>. Result delivered to inbox.」 | tasks/queues/pending/`<x>`.json（归 L4 AsyncTaskSystem）|
| async 完成 | (via inbox) | 同步路径同型 / 经 result-delivery 投递 | 同步路径同型 |

承诺细节：
- **失败必附 cwdHint**（防 LLM 路径上下文幻觉）/ 应然承诺（已是实然行为 / §10 提升）
- **截断阈值不写量化数字**（系统常量 / 调参不破契约 / 防双源 drift）/ metadata 反馈实际字节数
- **截断格式 head + tail**（前 ~600 + 尾 ~1400 / 中间 `[...truncated XX bytes...]` 标记 / 偏向尾保错误诊断）/ 数值非应然硬性承诺
- **partial output 在 timeout 时返**（agent 进度感 / 超阈值同样截断走兜底）
- **兜底落盘统一**：成功 / 失败 / timeout 三场景同型 / 仅当超阈值才落盘（短输出不落 / 0 浪费）/ 不区分流（合并后单 buffer）
- **timeout error 文案明确归因**（区分 default vs agent 显式）：
  - **Case A**（agent 没传 timeoutMs / hit default）：
    ```
    [clawforum exec] Timed out after 30000ms (default).
    Pass "timeoutMs" to extend, or set "async": true for long-running.
    [cwd]: <path>
    ```
  - **Case B**（agent 传了 timeoutMs / hit own limit）：
    ```
    [clawforum exec] Timed out after 60000ms (your timeoutMs setting; default is 30000ms).
    Increase timeoutMs further, or set "async": true.
    [cwd]: <path>
    ```
  - 两点说明：
    - `[clawforum exec]` prefix 明示 framework 触发 / 非 OS / 非命令自杀（区分 OS-level OOM kill / SIGKILL from outside）
    - timeout 值 + default 值都 dynamic interpolate 当前实际配置 / **不破「description silent on numbers」原则**（description 静态 / error message 动态运行期值）/ 运维改 default 后自动反映

**4) 副作用 + 跨通道影响**

- **OS 副作用 agent 自负**：写文件 / 改环境 / 改 git / 调外部 API ... 系统不拦截
- **cwd 私域保护**：默认 clawspace / agent 用 `cd ../.audit` 等越界 = 显式动作 / 系统不阻断（信任 + 审计兜底）
- **跨工具一致性**：cwd 默认 clawspace 跟 file_tool 路径根同型 / agent 心智无切换
- **跨 claw 不在工具通道**：claw 间 OS 操作（互删文件 / 互看进程）= 必经 motion CLI 中介（与 file_tool §10.6 同纪律 / D11）
- **审计**：每次 invoke 经 L2 Tools 框架 `tool_exec` 落盘 / CommandTool 本模块不直产 audit
- **async 路径副作用**：调度后立即返 / 进程在 background 跑 / agent 可在 inbox 完成消息到达前继续其他工具调用 / claw 重启 task-recovery 自动恢复
- **跨通道**：async 完成时经 inbox 通道（L2 Messaging）注入消息 / 大结果走 `results/<id>.md` resultRef
- **跨工具组合**：long-running 命令的标准 pattern = `async: true + 2> log.err` + 中途 read log.err 看进度 / 完成 inbox 收最终结果

**5) profile 准入 + 不变量**

profile 准入归 Tools 框架决策 / **§10 不表态**（与其他工具一致 / 各 profile 见 `core/tools/profiles.ts` / §A.3 verifier 暴露过宽是治理债 / 不在本节承诺）。

不变量：
- 不解析 shell 语法 / 不展开 `~` / 不替换 env var（caller / shell 自负）
- 不暴露 shell 选择（caller 想换 bash → 自己写 `bash -c '<x>'` 在 command 里）
- 工具不抛异常出框架边界 / 任何错误转 ToolResult（M#10）

### 10.2 跨工具偏好归系统信息通道

「优先用 read / write / search / ls 而非 exec 实现读写」「常见命令最佳实践」「shell injection 自负」「长输出引导 spawn 子代理处理（保 claw context window）」/ 这些跨工具偏好和教学引导归 **AGENTS.md** 系统信息通道 / 不写 exec schema description（防字段膨胀 / agent 每次 invoke 看到的都是 self-contained 自身决策信息）。

### 10.3 跨 OS 风险登记（防 future drift）

- 当前应然 + 实然：`sh -c` 硬编码 / Unix-only
- description 明示「Runs via sh -c on Unix」/ 不假装跨平台
- Windows 部署需求出现 → 升档 §B「ProcessExec 硬编码 `sh -c`」（ProcessExec 多 shell 入口）
- agent 拼跨 OS 命令是 caller 风险 / 不在工具承诺范围

### 10.4 截断契约 + 兜底落盘（防 future drift）

- description 明示截断行为 / 不写量化字节数（让运维侧调参不动 description / 防双源 drift）
- 阈值：~2000 字节（试用 / 覆盖典型简洁输出 / 大输出 → 系统兜底落盘 + AGENTS.md 引导 spawn 子代理处理 / 保 claw context window）
- **截断格式**：头 ~600 + `[...truncated XX bytes...]` + 尾 ~1400 / 偏向尾（错误诊断常在末尾）/ 单一规则（成功 / 失败 / timeout 同型）
- **兜底文件位置**：`clawDir/tasks/sync/<id>`（跟 write_backups 共用 dir / sync 工具副产物统一存储 / 装配-level 约定不归 AsyncTaskSystem own）
- **文件命名**：`<id>` 无扩展名 / `<id>` = ISO 8601 UTC + 短 random（例 `2026-04-30T14-30-12Z-a3f2`）/ 单层 dir / 无 collision
- **文件格式**：YAML frontmatter + 原 content（length-prefix 防 collision）：
  ```
  ---
  source: exec_overflow
  exec_id: <id>
  ts: 2026-04-30T14-30-12Z
  content_length: <bytes>
  ---
  <合并 output 完整字节 / 不依赖 frontmatter 闭合 `---` 判结束 / 靠 content_length>
  ```
  - frontmatter 内 `source: exec_overflow` 标识类型（区分 write_backup）
  - `content_length` 字段防 frontmatter 嵌套歧义（原文件可任意以 `---` 起 / 不影响解析）
  - 跟 write_backups 同型 frontmatter（统一 sync 工具副产物格式）
- **生命周期**：turn-scoped / Snapshot commit 成功后清空 `clawDir/tasks/sync/`（前一 turn 的 sync 副产物已被 git 覆盖 / 无需保留）
- **落盘触发**：仅当超阈值（短输出不落盘 / 0 浪费）/ 不区分成功失败（统一规则）
- **TBD（待 spawn 工具讨论）**：
  - ToolResult 截断 hint 文本最终形态 / 不教 read（claw 不应该自己读长文本）/ 未来教 spawn 调用模板（待 spawn §10 设计时统一闭环）
  - 当前应然先标 path 事实（`tasks/sync/<id>` 相对 clawDir）/ 不指定 tool 调用方式
  - read 路径根决策（clawspace 严限 vs clawDir 宽）一并待 spawn 讨论

### 10.5 合并 output 设计(防 future drift)

- 应然承诺：exec 默认返合并 output（stdout + stderr 时序混合 / 跟 terminal 体验一致）
- 实现路径：β 应用层合并（ProcessExec / Node spawn 双 stream → 单 buffer 按 'data' event 到达顺序）/ **不在 shell 层加 `2>&1`**
- α 方案否决理由：shell 层 `sh -c 'cmd 2>&1'` 包装会破坏 agent 自己写的重定向 / shell 重定向左到右处理 / `cmd 2> log.err 2>&1` 第二个 `2>&1` 覆盖第一个 / agent 的 `2> log.err` 失效
- agent 区分 stdout/stderr 的方式（X3 路径）：靠**内容语义**（工具自带 `ERROR:` / `WARN:` / stack trace 缩进 / `error TS2304:` 等前缀）/ 不靠流身份
- agent 想分流（高级用法）→ 自己显式 redirect：`cmd 2> log.err`（分文件）/ `cmd 2> /dev/null`（丢 stderr / 想要纯 stdout 的结构化输出）
- 反对方案登记：
  - α shell `2>&1` 包装 → 否决（破 agent redirect）
  - X1 行级 `[O]/[E]` 前缀 → 否决（破 terminal 一致性 / chunk 边界切行 / size 膨胀）
  - X2 metadata 给 stderr 字节范围 → 否决（agent 用不上 / token 浪费）
  - 之前 stdout-only + 失败兜底 stderr → 否决（agent 心智 3 套规则 / 认知负担重）
- 行序保真度：~95%（Node spawn 'data' event 调度近似 OS 写入顺序 / 极端高频混写可能 chunk 边界乱序 / 实战 OK）

### 10.6 异步路径（agent 显式 async / 0 新机制）

- schema 列 `async` 字段（简洁 description）/ 用法教学集中归 **AGENTS.md** 系统信息通道（防工具 description 冗余教学）
- 触发：tool_use.input 含 `"async": true` / step-executor.ts:564 提取 meta flag / 不传工具
- 路径：`tools/executor.ts:172` `options.async` → `AsyncTaskSystem.scheduleTool` → `ToolTask` kind / `tasks/queues/pending/<id>.json` 落盘 / `tool-executor.ts` 异步执行 / `result-delivery.ts` 完成投递 inbox
- 完成消息形态：inbox `.md` / from=task_system / 含 taskId + 执行结果 / 大结果走 `results/<id>.md` resultRef
- claw 重启：`task-recovery.ts` 恢复 pending tasks（不丢任务）
- **同步 timeoutMs 30s 不自动转 background**（P2 路径已否决 / 需 agent 先验决策 / 没标 async + 同步超时 = 干净失败 / agent 看到 timeout 知道下次该标 async）

**工具 async 三分类**（AGENTS.md 教学清单）：
- A 类 inherently async：spawn / dispatch / ask_motion（调用即返 schedule / 不需要标 async / supportsAsync = false / ask_motion 应然漏列补登 phase403 r58 D）
- B 类 sync-by-default + async-meta：search / memory_search / exec（加 async: true 转 ToolTask 异步）
- C 类 sync-only：read / ls / status / write / send / skill / done / ask_user / notify_claw（不接受 async）

### 10.7 跨 claw / 跨 clawDir 不在工具通道

- claw 间 OS 操作（互删文件 / 互启进程 / 互看资源）= 必经 motion CLI 中介
- D11 motion 单向访问能力 / 用户能干的 motion 都可代办 / claw 自身边界明确
- 与 file_tool §10.6 同纪律
