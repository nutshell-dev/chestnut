# Design Practices — 治理实践与契约书写

> 本文档收集 clawforum design 文档书写、drift 登记、const 抽取、测试断言等**治理实践**。每条由具体 phase 立项推动浮出，是「过去推导出的判据 + 现在的做法」，不是预先制定的强制规则。
>
> 与 `principles.md`、`architecture.md`、`interfaces.md`、`modules/*.md` 等**静态描述**性文档区分：本文档是**动态实践**，随项目演进而增。

---

## path:linenum drift snapshot 规范（phase 372）

**§7.A / §7.B drift 表 + §8.D 历史纪律 changelog 内 path:linenum 引用**：可保留，是「实然事实快照」，用于说明 drift 当前位置或闭环时刻位置（含 main SHA）加上已发生历史。

**§3 接口 / §4 层级 / §5 上游依赖 / §6 不可消除耦合 等契约规范本体**：不绑行号，应用：

- `function.name` 或 `Class.method` 名（grep 即可定位）
- 必要时附 grep 指令（如 `grep -n 'createSkillRegistry' src/core/skill/registry.ts`）
- 不写 `src/path/file.ts:123` 形态

理由：契约规范是「应然永驻」，行号是「实然瞬时快照」，二者绑定即应然被实然侵蚀。drift 描述表与历史 changelog 则相反，行号是被描述的实然事实，保留合理。

立项：phase 372 / B.p201-drift 真治理加上释义豁免双轨。

---

## const 抽取概念识别（phase 380）

**抽 const 的判据是「同概念」，不是「同字符串」**：相同字面量在不同语义域出现，必先做语义分类，同概念域内抽 const，跨域强制同 const 即隐含「同概念」误导（M#7 反向违反）。

判据决策矩阵（按字面量 caller 实测加 advisor 复核）：

- **单一概念 + 高 caller 复用（≥ 5 caller）** → 抽 const（如 `LOGS_DIR = 'logs'`）
- **多语义混叠** → 命名空间隔离（如 `STATUS_SUBDIR = 'status'` 仅 subdir 域，与 `STATUS_TOOL_NAME` 区隔，cli cmd 域字面量保留加注释）
- **partial drift caller**（const 已立但 caller 部分未改）→ 完成 caller refactor，**必先按概念域分类**（避免不同概念合并）
- **低 ROI（< 3 caller）+ 单一概念** → 不抽，字面量保留，不引入间接层（M#8 反向）

立项：phase 380 / B.p376-1 短 token const 评估 derive / Path β。

---

## dispatch table aging 非契约 drift（phase 388）

**范围**：phase372 §path:linenum drift snapshot 规范覆盖 design 契约（`design/modules/*.md`），**不覆盖 dispatch table**（`coding plan/r<N>/分发表.md`）。

**dispatch table 性质**：working document，写作时刻与实施时刻可能差数日，行号自然过期是预期现象，不属契约 drift，不入 design/modules/*.md §7 drift 表（防污染契约 drift 表）。

**覆盖纪律**：修订完整性自检纪律组「Path #1 必先做」已 cover 实施期识别（grep 实测对照 dispatch 行号）。

立项：phase 388 / B.p384-1 closed as not-a-drift / framing 推翻形态分级第 2 次（phase379 首发加 phase388）。

---

## 测试字符串值断言是 cross-check 设计（phase 393）

**范围**：测试断言 audit event 名时硬编码字符串值（如 `expect(audit.write).toHaveBeenCalledWith('snapshot_commit_failed', ...)`），而非 prod const ref（如 `DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED`）。

**性质**：有意的 cross-check 设计，非 caller 风格并轨遗漏。

**论证**：

- audit event 名是字符串值契约（audit.tsv TSV 文件，跨进程消费者经 grep，字段值匹配）
- 测试断言对象 = 字符串值契约，不是 const ref 名契约
- 改 prod const 字符串值（如大小写漂移）→ 测试用字符串值 → 测试 fail，漏报回归
- 改 prod const 字符串值 → 测试用 const ref → 测试自动 PASS，**失去回归保护**
- phase386 反向 1（改字符串值大小写 → 测试 fail）正是利用此 cross-check 设计

**类比**：phase173 console 决策（L2 writer.ts catch 用 console.error，递归边界释义豁免）同型，有原则 derive 加上模板支撑即健康。

立项：phase 393 / 测试载荷断言扩展候选 closed as not-a-drift / framing 推翻形态分级第 3 次（phase379 首发加 phase388 第 2 加 phase393 第 3）。

> 关联：phase 706 audit key naming 决策树（L2761）/ 同 audit string family / phase 393 测试侧 string match vs phase 706 prod 侧 key 命名 derive 同根

---

## 测试质量 review 判据：narrowing + 业务索引（phase 543）

**触发**：r66 F fork 起步 review 列 8 site test quality issue / Path #1 实测后 5/8 完全推翻 + 1/8 部分修正 + 1/8 真问题 + 1/8 不算问题 / review claim 大幅 stale。

**Why**：reviewer 易把 narrowing pattern 与业务索引断言误标为「weak / fragile」/ 实然这是测试合规模式 / 推翻成本高 / 立判据防 reviewer reuse。

**判据**：

### narrowing pattern（不视作 weak）

```ts
expect(match).toBeTruthy();        // narrowing for non-null access
const frontmatter = match![1];
expect(frontmatter).toContain(...); // 真行为断言
```

- `toBeTruthy()` / `not.toBeNull()` / `toBeDefined()` 后**紧跟** `unwrap !` + 真行为断言 = narrowing pattern / 测试合规
- 单独存在（无后续真断言）才视作 weak
- 同根：vitest TypeScript narrowing 标准模式 / `match![1]` access 需先确认非 null

### 业务索引断言（不视作 fragile）

```ts
// 测试名「Critical should be first despite being written second」
expect(entries[0].message.content).toBe('Critical');
expect(entries[1].message.content).toBe('Normal');
```

- 测试名明示业务排序契约（priority / batch order / 等）→ `entries[0]` `entries[1]` 是行为索引契约
- 改用 sort key（如 `entries.find(e => e.priority === 'high').content`）反破业务行为断言 / 失去「critical 必首」覆盖
- 无业务排序语义 / 仅依赖 mock fs 返回顺序时才视作 fragile（推荐改 set-equality）

### 冗余 vs 弱 区分

| 形态 | 例 | 视作 |
|---|---|---|
| 冗余 | `toBeDefined()` 后紧跟 `toContain(value)` | 冗余但**非弱** / 可清洁 / 不必入 review P 级 |
| 真弱 | 仅 `not.toBeNull()` / `toBeDefined()` 无后续真断言 | 真弱 / P1+ 入 review |
| narrowing | `toBeTruthy()` 后紧跟 `match![1]` access + 真断言 | 合规 / 不入 review |

### isolated mock vs 集成测试 责任分离（不视作 problem）

```ts
vi.mock('../../src/core/.../_pending-task-writer.js', () => ({
  writePendingSubagentTaskFile: mockWriteFile,
}));
```

- unit test 验证「按 mode 决定 messages 内容传给 writeFile」业务逻辑 / 用 mock 隔离真 fs
- 集成测试是不同 file 责任（如 `tests/integration/dispatch-flow.test.ts`）/ 不在 unit test scope
- **不视作**「mock 后真路径未验证」problem / unit + integration 责任分离是 test infrastructure 设计

### env 真 mutate（视作真问题）

```ts
process.env.ANTHROPIC_API_KEY = 'sk-test';  // ❌ 真问题
delete process.env.X;                        // ❌ 真问题
```

- 测试间 pollution / 测试隔离破 / 真 P1
- **应改**：`vi.stubEnv(key, value)` + `afterEach(() => vi.unstubAllEnvs())` / vitest 内置 own / 自动 cleanup

### `describe.skipIf(!toolAvailable)` 合理兜底（不视作全 skip）

```ts
let gitAvailable = false;
try { execSync('which git', { stdio: 'ignore' }); gitAvailable = true; } catch {}
describe.skipIf(!gitAvailable)('Snapshot', () => { ... });
```

- CI 必装 git → skipIf 永不命中 → 测试永跑
- dev 环境无 git → 跳过整 describe / 给 dev 友好兜底
- 不视作全 skip / 是合理 graceful degradation

立项：phase 543 / r66 F fork review claim 大幅推翻治理 / **「review claim Path #1 实测前不入 phase scope」纪律候选**（同 phase 540 D.2 完全推翻 / 累 2 实证 / Meta 38 阈值候选 升格独立 feedback）。

> 关联：phase 675 test mock/spy hygiene cluster（L2448）/ phase 711 spy lifecycle gap（L2883）/ 同 test discipline family

---

## 应然 rule 必有现实功能依据（phase r61+）

**范围**：architecture.md 与各 modules/*.md 中所有应然层 rule（如「业务模块禁止直 import X」「必经某模块」「不允许某操作」等架构级约束）。

**判据**：rule 必从下列至少一项 derive：

- 当前已享受到的功能好处（如错误归一化、测试 mock 便利、并发安全、安全边界）
- principles.md 已明示的功能要求或演进方向（如分布式部署、跨 OS 平台）
- 已识别的具体业务约束（如 agent 自由输入路径需 sandbox）

凭空规则或纯 baseline_rigor 包装（「这样比较好」「显得规整」「应该如此」）是反向。

**rule 显式标 derive 源**：让读者能从规则走到依据。例：「业务模块禁止直 import `node:fs`，derive 自 Design Principle『clawforum 支持分布式部署和跨 OS 平台』」。

立项：phase r61+ FileSystem 应然层讨论触发。user 戳「I/O 唯一入口只在分布式跨 OS 才有作用」浮出 rule 凭空风险。同 phase 补 Design Principle「clawforum 支持分布式部署和跨 OS 平台（未来演进方向）」作为该类 rule 的 derive 源。

---

## 应然层文档书写纪律（phase r61+）

**范围**：principles.md、architecture.md、interfaces.md、modules/*.md §1-§6（应然层文档族）。

**纪律 1：禁止包含实然 drift 信息**

应然层文档只描述「应然形态是什么」，不描述「当前实然偏离了什么、要在哪一轮推什么」。「r N+ 推」「应然 vs 实然违反列表」「待重构」等实然 path 信息归 modules/*.md §B drift 表，practices.md（治理实践）亦可登记历史 violation 教训。

反向案例：FileSystem 章节最初写「权限策略，PermissionChecker 是 L2 agent 语义，r62+ 重构挪 L2」是把实然 drift 时间表混入应然 non-goals。修正为「权限策略归 L2 agent 语义层」，剥离 r62+ 字眼。

**纪律 2：层归属判据 derive 自层定位本身**

L1 至 L6 各层的本质（参考 architecture.md「模块层定位」表）就是 sharp 判据。某模块归哪一层、某能力 own 哪一层，都从层定位 derive，不需要每个细决策上抛 user 拍板。

反向案例：「KV cache 标记是 L1 还是 L2」「Transport 与 Gateway 关系」等问题，L 层定位（L1 = OS 中性接口、L2 = 横切封装）已经决定答案。问 user 是 pseudo_decision 反向（已 r60 Meta 32 升格 feedback）。

**纪律 3：不在 derive 出来的事情上立新 principle**

某条「看起来很对的元规则」如果能从已有 Philosophy、Design Principles、Module Logic Principles derive，则不立新 principle，直接在 architecture.md 或 modules/*.md 引用 derive 链条即可。

反向案例：「对智能体的承诺是 first-class dimension」最初想立 Module Logic Principle，user 戳穿是 Philosophy「系统为智能体服务」加 Design Principle「智能体是决策主体，系统在智能体需要决策时交付相关信息」的 derive。直接 architecture.md 表 3 落地，不立新 principle。

立项：phase r61+ L1 5 模块讨论收官回顾。三类反向（实然混入应然、pseudo_decision 上抛、过度立 principle）反复触发，合并为应然层文档书写纪律单条治理。

---

## architecture.md 命名权威单源（phase 414b）

**范围**：interfaces/*.md、modules/*.md、code 中所有跨模块**模块名 + 概念名 + 接口类型名**。

**判据**：

- architecture.md 明示某层（模块名、能力名、概念）→ 全 design 层 + code 层 align 该名
- architecture.md silent 在某层（如 method 名 / 内部 API 形态）→ 该层抽象自由（interfaces/*.md 可保抽象命名 / modules/*.md 可记录实然命名）
- 不一致时**永远以 architecture.md 为权威修正其他层**（包括 code rename / interfaces 重命名 / modules 修史）

**应用三态**：

1. **interfaces/*.md 类型引用纪律**：跨模块 type 引用必援引 canonical 接口名（interfaces/*.md own 的接口名），不直引 impl class 名。  
   反向案例：interfaces/l5.md `RuntimeDependencies` 用 `contractManager: ContractManager`（impl class 名）而非 `contractSystem: ContractSystem`（canonical 接口名 / arch §22 + 多表权威）/ 违反 DIP「依赖于抽象而非具体实现」/ phase414b 修。

2. **物理迁/重命名 phase 必含 architecture 命名核**：  
   commit author 在物理迁 phase 自治起命名时必先 grep architecture.md 核 authoritative name，命名分歧立时停手。  
   反向案例：phase378 commit author 自治采用 `ShellTool` 命名 commit + 目录 + 工厂 + Module type 4 处（commit `14c7767` 标题 = "physical relocation L2 ShellTool"）/ 但 architecture.md §17 + 多表权威是 `CommandTool` / 5 phase（379-413）cascade 未察觉 / phase414b 浮出登记 modules/l2_command_tool.md §A.10 / 推 r+1 phase rename code 全 align。

3. **arch silent ↔ 抽象自由 / arch 明示 ↔ 全 align**：  
   防过度治理。如 arch 在 method 级 silent，则 interfaces 用 `interface StepExecutor { step(...) }` 抽象命名合法，无需 align impl `executeStep` 自由函数；如 arch 明示模块名 `ContractSystem`，则 interfaces + modules + code 全 align，不允许 `ContractManager` 在 RuntimeDependencies 类型字段出现。

**反向风险**：commit author 起名 / fork 推荐起名 / 重构期 rename 都可能引入 arch 不知的命名 — 必含 architecture.md 命名核步。

立项：phase 414b / interfaces 二轮全面 audit / 用户「以 architecture.md 为准」决策路径 / 暴露 phase378 ShellTool 命名 drift 5 phase 未察觉 / 同 phase 修 contractManager → contractSystem (D 类) + createFileTools / createCommandTools (C 类) / 同 phase 推 B 类全保抽象（arch silent → 抽象自由）。

---

## DRY reflex vs M#2 format 自治（phase r61+）

**范围**：跨 caller 共享代码抽出决策（utility / shared parser / shared helper 等）。

**判据**：抽出 shared utility 前必核两个问题：

1. **真共享 spec 还是巧合相同 syntax**：N caller 用「相同代码」是因为 design 上真共享同一约定（spec / protocol / format），还是各自独立选了相同 industry standard / language idiom 巧合相同？
2. **抽出的部分是「独立可变职责」还是「各 caller 业务的 implementation detail」**：M#1 反向测试 — 共享部分变化 vs 各 caller 业务变化是否真独立？

### 反例 case study：phase361 抽出 parseFrontmatter

**phase361 决策**：从 L2 Messaging codec 抽出 `parseFrontmatter` 到 `src/foundation/frontmatter/` shared utility / 因 SkillSystem registry + memory_search 也需要解析 YAML frontmatter / 避免代码复制。

**真核 (r61+)**：

| 维度 | phase361 假设 | 真情况 |
|---|---|---|
| 3 caller 真共享 spec? | 假定共享 YAML frontmatter spec | 各 caller 自己 own format（schema 完全不同：type/source/priority vs name/description vs ...）/ 共享的只是 YAML key:value 行业 syntax / 不归 clawforum own |
| parser 是独立可变职责? | 假定独立（M#1 抽出 share owner）| **不独立** — 是各 caller format 业务的 implementation detail（M#2 业务语义归属）/ Messaging 改 inbox schema 不影响 SkillSystem / SkillSystem 改 SKILL schema 不影响 Memory |
| DRY 真痛点? | DRY = 避免 38 行复制 | **38 行 stable yaml parser / 几乎不变 / 复制成本 0** / DRY 是 reflex 不是真痛点 |
| 抽出耦合? | shared utility = 解耦 | 反而 **artificial coupling**：改 shared parser 强制 lockstep 3 caller / 各自 inline 才独立可变 |

**真合规设计**：3 caller 各自 inline 自己的 parser（38 行 yaml parser 复制 = 正确的本地化 / 不是 DRY 违反）。

**治理路径**：删 `src/foundation/frontmatter/` + Messaging codec / SkillSystem registry / memory_search 各 inline 38 行 yaml parser。

### M#1 / M#2 / M#9 联合 derive

| 原则 | 抽出 shared utility | 各 caller inline |
|---|---|---|
| M#1 独立可变 | ✗ artificial coupling（改 parser 强制 3 caller lockstep） | ✓ 各自独立演化 |
| M#2 业务语义归属 | ✗ 把 format implementation detail 从各 caller 业务剥离 | ✓ format（含 parser）归各 caller 业务 own |
| M#9 显式耦合 | ✗ 强加假共享 spec 让编译器追踪 | ✓ 真不耦合 / 不需要显式 |

### 抽出 shared utility 的真合规判据

只有当 **N caller 真共享 spec / 改一处真需要改其他** 时才抽出：
- 真 protocol（如 LLM 协议 messages schema）
- 真业务 invariant（如 audit event TSV 格式 / 跨进程 grep 必须相同）
  > 关联：phase 706 audit key naming（L2761）/ TSV 字段值匹配纪律的 prod 侧具体 derive
- 真 type 单源（如 Tool / ToolResult interface schema）

**不抽** 的场景：
- 各 caller 独立选了相同 industry standard syntax（YAML / JSON / regex / etc）
- 各 caller 自己的 format implementation detail
- DRY reflex（看到代码复制就抽 / 没 derive 真共享 spec）

### 反向风险

「shared utility 抽出」是工程师 DRY reflex / 容易越界 / 必先 derive 真共享 spec / 不然引入：
- artificial coupling（改一处影响其他）
- M#2 violation（implementation detail 从业务剥离）
- 概念分类困惑（utility 不属任何 layer / 反复在 L1 / L2 / utility 之间纠结）

立项：phase r61+ Frontmatter 模块讨论。user 戳「为什么改一处要改另一处」+「为什么 skill / messaging 要用同样的格式」/ 浮出 phase361 是 DRY reflex 不是真 derive / 撤回应然「应然外通用 parser」合规 claim / 改 STALE 推 r61+ 反向 design phase 删 utility + 各 caller inline。

**2026-05-04 phase 461 实然落地（`c15333e9`）**：DELETE `src/foundation/frontmatter/index.ts` + dir + `tests/foundation/frontmatter.test.ts` / 4 caller (codec-inbox / inbox-writer / skill-system/registry / memory_search) 各自 inline 27 行 parser（紧凑后从 37 行精简）/ 6 files +112 -196 = 净 -84 行 / 1356 tests PASS / 0 行为改 / **反例 case study → 实证落地** / **「Path #1 实测核浮出 hidden drift」第 3 实证累达硬化阈值**（继 phase 454 + 458 / 推 r+ Meta 必硬化「Path #1 实测核浮出 hidden drift 治理模板」独立 feedback）。

---

## 应然层资源字段与持久化判据（phase r61+）

**范围**：architecture.md 表 1 资源字段加 modules/*.md 资源描述，以及 Module Logic Principle M#4「持久化一切信息」的 spirit 解读。

### 资源字段写什么判据

**写**：核心业务 state owner 边界 — 其他模块需要意识到「这是 X 模块 own 的 state，不直接碰，要访问必经 X 接口」。

- disk 持久化业务状态：dialog（DialogStore）、audit（AuditLog）、stream（Stream）、contracts（ContractSystem）、tasks（TaskSystem）、PID 注册表（ProcessManager）等
- mem 核心业务状态：Transport 连接表加接收缓冲（连接生命周期是 Transport 业务核心）、FileWatcher 订阅集合（订阅是模块本质）、SkillSystem 元信息表（元信息查询单位）等

**不写**：implementation 细节 — instance internals 其他模块本来就碰不到，不构成 owner 边界。

- 容错机制内部状态（circuit breaker、provider health、failover state、active call 跟踪等）
- runtime cache（性能优化的中间结果）
- runtime probe state（探测试探记录）

判据：模块本质 vs implementation detail。Transport 「连接表」是模块本质（无连接表 Transport 不成立），LLMOrchestrator「circuit breaker」是容错 implementation（去掉 circuit breaker LLMOrchestrator 仍能调 LLM 加做 failover 加 retry，只是没了具体容错策略）。

### 持久化判据（M#4 修订「持久化一切信息」spirit）

字面 M#4「持久化一切信息」不是字面解读所有 mem state，而是：

**持久化**：重启后仍有 marginal utility 的业务状态。

- dialog（重启后 messages 数组仍真实，恢复后 agent 接着跑）
- audit（事后审计需要历史 log）
- stream（事件流需要回放）
- contracts（业务流程 state 跨重启）
- tasks（调度 state 跨重启）
- PID 注册（进程持续标识）

**不持久化**：重启后 stale 的 runtime probe state — 恢复反而带着 stale 信息工作。

- circuit breaker：重启后 provider 真实健康可能已变（恢复或仍坏），从磁盘恢复 stale 状态等于带着错误信息工作
- 连接表：连接已断，重启重连即可
- 计时器：runtime ephemeral，重启重置 OK
- runtime probe / cache：重启 reset 是正确行为

判据：重启后该状态**仍代表当前真实**还是**已 stale**？仍真实就持久化，已 stale 就不持久化（重启视为重新评估）。

### 反例 case study

**LLMOrchestrator circuit breaker**：

- 我（主会话）propose 把 circuit breaker、provider health、failover state、active call 跟踪写入资源字段（「容错运行时状态，派生态，重启重置」）
- user 戳：circuit breaker 状态持久化没用，因为它本质是「runtime 试探记录」，重启后就 stale —— provider 真实健康可能已变，从磁盘恢复 stale state 等于带着错误信息工作
- 修正：LLMOrchestrator 资源保持「无」（implementation detail 不入资源字段）

立项：phase r61+ L2 LLMOrchestrator 资源字段讨论。user 修正双重错（implementation detail 当 owner 边界写、没意识到 stale state 持久化反而有害），derive 出资源字段判据加持久化 spirit。

---

## r61+ 反向 design phase 系列总清单（phase r60+ 收尾）

**背景**：r60+ 长 deep verify session 浮出多类应然 vs 实然 drift / 治理胜利推翻 / over-engineering 反思。本节集中索引所有待清理 design debt / 推 r61+ 系列 design phase 处理。

### 1. 反向 design phase（撤旧治理 / 用真合规设计替换）

| 项 | 应然真合规 | 详 |
|---|---|---|
| **5 port pattern 撤回** | 重新分配职责 / 让源头模块不需要调上层 / 不加 port 绕过 | feedback_governance_workaround_smell + 27+ design STALE 标 |
| ~~**parseFrontmatter shared utility 删**~~ ✅ closed (phase 461 / `c15333e9`) | 各 caller (Messaging codec/inbox-writer / SkillSystem registry / memory_search) inline 自治 27 行 yaml parser / 6 files +112 -196 = 净 -84 行 / 1356 tests PASS | 上节「DRY reflex vs M#2 format 自治」phase 361 反例 → phase 461 实然落地 / **「Path #1 实测核浮出 hidden drift」第 3 实证累达硬化阈值** |
| **FileSystem PermissionChecker 注入撤** | NodeFileSystem ctor 删 PermissionChecker / caller (L4) 自治 check 后 call FileSystem | l1_filesystem.md §A.1 + §A.7 STALE |

### 2. 实然 rename phase（design 已 sharpened / 实然 src/ 待跟）

| rename | 状态 |
|---|---|
| LLMService → LLMProvider + LLMOrchestrator | phase413 部分落地（src/ 物理拆 + class rename）/ shim 留向后兼容待清 |
| SessionManager → DialogStore | pending |
| ShellTool → CommandTool | pending（commit author 自治起名 / arch §17 权威 CommandTool）|
| ContractManager → ContractSystem | pending |
| ClawRuntime → Runtime | pending |

### 3. bypass 模式治理（caller 直 import OS API 绕 L1）

| bypass | 修正 |
|---|---|
| ContractSystem `manager.ts` 直 import `node:fs` 绕 FileSystem L1 | caller 经 FileSystem L1 |
| ProcessManager + Watchdog 直 import `node:child_process` 绕 ProcessExec L1 | caller 经 ProcessExec L1 |

### 4. 应然层 propagation 待补

| 项 | 修正 |
|---|---|
| claw-permissions L4 立项 | arch §22+ 加节 + interfaces/l4.md 加节 + design/modules/l4_claw_permissions.md 立 |
| SubAgent 4 drifts 实施修 | l3_subagent.md §A.r60+1~+4（messages 经 DialogStore / 路径 caller 注入 / daemon.log 决策 / arch deps 同步）|
| modules/l2-l6 §1-§6 应然层剥离 STALE/phase/r N+ | 24 modules（L1 5 modules 已完成 / L2-L6 剩 24）|

### 5. 元层 design phase

| 项 | 状态 |
|---|---|
| arch dep graph 元规则定义（dep concept 定义 / cross-cutting 判据 / 同层标记规范）| 推 r61+ |
| Frontmatter utility 删后应然定位 | 应然 0 立项决策已显式 / 实然 src/foundation/frontmatter/ 删后各 caller inline |

### 启动判据

r61+ 启动时按 4 类优先级：
1. **大改且影响实然 caller 多** — FileSystem PermissionChecker 撤（125+ caller）/ 5 port 撤（多模块 caller）
2. **rename 系列**（实然 src 改名 + caller 切换）
3. **bypass 治理**（caller refactor）
4. **L2-L6 modules 应然层剥离**（design only / 不动 src）

启动前必先 substantive 复核每项 design debt 是否仍真存在（避免 stale claim / Path #1 实测）。

立项：phase r60+ deep verify session 收官（2026-05-03）。约 50 turn 长 session 浮出 27+ port pattern STALE + 多类反向 design candidates / 集中索引避免散落。

---

## port pattern 反向 design cluster 全闭环模板（phase422-432）

**范围**：clawforum 历史立的 7 个 port abstraction 整套反向 / cluster 7 闭 7 全收官（含 L3 TaskScheduler port）。

**7 port cluster 与真合规设计**：

| port | 来源 phase（错治理）| 反向 phase | 真合规设计 |
|---|---|---|---|
| WatchdogPort H9 | phase348 | phase422 | CLI 直 dep watchdog 公共 export（同层 L6→L6）|
| TaskLifecyclePort | phase412 | phase424 | random-dream 等 caller 直 dep TaskSystem class（同层 L4→L4）|
| RetroScheduler | phase364 | phase426 | EvolutionSystem 直 dep + emit `contract_completed` event 单向订阅 |
| ContractVerifierScheduler | phase340+364 | phase427 | inline thin wrapper 回 ContractSystem（删整 verifier-scheduler.ts 112 行）|
| Runtime 11 余 ports（DispatchTool / RuntimeDependencies port 等）| phase335 H7+H8 | phase429 | Runtime 直 dep concrete L2/L4 模块（删整 runtime-ports.ts ~140 行）|
| PermissionChecker | phase377+phase373+phase368 | phase430 | FileSystem 0 PermissionChecker dep / FileTool 4 工具自治调 claw-permissions check（删 permissions.ts 整文件）|
| **TaskScheduler L3 port** | phase163 历史 debt（callback closure）| **phase432** | **ToolTask schema +args+parentClawDir + fs-driven ingest（同 SubAgentTask 模式）+ ToolRegistry execute / 删整 task-scheduler.ts + scheduleTool callback API + pendingCallbacks Map / closure 不可跨进程 → declarative schema 重启可恢复（D1c）**|

**合规路径 = 3 替代模式**（避 port）：

| 反向需求 | 错（port abstraction）| 对（真合规设计） |
|---|---|---|
| 低层模块需要被高层调 | 低层 own port / 高层实现 | **职责重分配**：拉到高层 / 低层只暴露 raw 能力（PermissionChecker / WatchdogPort 模式）|
| 同层模块循环 / 反向引用 | 一方 own port / 对方实现 | **event subscription**：emit 单向 / 订阅方自治 / 不知 emitter（RetroScheduler 模式）|
| 模块需要业务回调 | port + adapter | **同层直 dep / 删 abstraction**：caller 同层（L4→L4）或降层（L4→L2/L3）直 dep concrete（TaskLifecyclePort / VerifierScheduler / Runtime 11 ports 模式）|

**模板复用判据**（每次 port 复用前必核）：

- N 次 phase 复用 ≠ best practice / N 次复用是 N 个真应然合规 phase 还是 N 个绕过 M#5 的 work-around
- 应然原则核：M#1 反向测试（独立可变职责？）+ M#3（真该 own 这资源？）+ M#5（真该 dep 这层？）
- 三问任一否 → 重新分配职责 / 让原本不需要这机制（不是发明 port）

**净 source delete ~370+ 行**（cluster 7 phase 累 / port abstraction 整删 + caller 同层直 dep / phase432 加 TaskScheduler L3 port + closure callback API + pendingCallbacks Map 全删）/ 1366+ 测试 PASS / 0 行为改变。

**cluster 收官元元**：

- 「N 次复用 = 模板成熟 = best practice」叙事**整套推翻**（7 framing 推翻历史登记 / 含 phase348/335/340/364/377/163 等）
- 「治理 work-around 是 design smell」7 实证累（含 phase414c 浮出 phase378 ShellTool drift cluster 触发点）
- 「真合规设计应当 0 治理需求」元判定确立 / 出现治理需求 = 应然层缺陷 / 应当回头修应然
- **「callback closure 是 cross-process design smell」phase432 立项**：closure 不可跨进程持久化 → 凡需 fs-driven 持久化的调度业务必用 declarative schema (toolName + args + minimal ctx 重建字段) / closure callback API 必反向

立项：phase422-432 cluster（2026-05-03）/ feedback_governance_workaround_smell 真合规落地全闭环 / 7 port 含 1 个 L3 closure callback port (TaskScheduler / phase432 闭)。

---

## OS 级守护无条件执行原则（phase430）

**范围**：L1 模块的 OS 级安全守护（如 NodeFileSystem 的 base-dir traversal + symlink 检查）。

**判据**：

- L1 OS 级守护**应无条件执行** / 不能依赖 caller 是否注入业务概念（如 PermissionChecker 是否注入）
- 条件守护（如 phase377 立的 `if (hasInjectedChecker) { symlink check + permission check }`）**掩盖 caller bug**：caller 不注入业务对象时 OS 级守护被跳过 / caller 的不合规用法（跨 baseDir 写 / mock 不一致）被静默放过

**phase430 实施期暴露 3 隐藏 bug**（无条件守护后立即浮出）：

1. **根目录 baseDir (`/`) + path.sep 错位**：`realBase + path.sep` 当 realBase 已是 `/` 时变成 `//` / realTarget 不以 `//` 开头 → false negative withinBase 检查 / 修：`realBase.endsWith(path.sep) ? realBase : realBase + path.sep`
2. **测试 mock 路径不一致**：daemon-command.test 的 getClawDir + getClawforumRoot mock 路径不一致 → ProcessManager 跨 baseDir 写 / 真问题是 mock 没保持生产路径关系 / 修：mock 一致化
3. **跨 baseDir 写**：random-dream.test 用 clawforumDir 的 fs 写 motionDir 下文件 / clawforumDir + motionDir 是独立临时目录 / 修：motionDir = clawforumDir/motion

**性质**：之前 phase377 的条件守护让这些 bug 不暴露 / phase430 改无条件守护后立即浮出 → **守护条件改严暴露隐藏 caller bug 是健康信号**（同 observability 债偿还模式）。

**应然立场**：

- **L1 模块 0 知业务概念**（PermissionChecker / claw-space boundary 等）→ 业务校验归 caller / L4 自治
- **L1 OS 级守护无条件执行**（base-dir traversal `..` + symlink 检查 + 根目录 path.sep 边界）→ 不依赖业务对象注入
- **caller 自治校验业务边界**（如 FileTool 自治调 createClawPermissionChecker 后 call fs / per-clawDir 缓存模式）

**反模式**：条件守护「只在注入 PermissionChecker 时执行 OS 级 symlink 检查」= 把 OS 安全锚定到业务概念是否提供 / L1 失去独立守护能力。

立项：phase430 PermissionChecker STALE 推翻收官（2026-05-03）/ port pattern reversal 第 5 例。

---

## code phase 收尾必触发 design 重审（phase 432+438 async tool cluster 收尾）

**范围**：模块边界重构类 phase 完结后 / 其改动可能让既有 §B drift 标自然 align 真合规 / 不需 code 改一行就能 close。

**判据**：

- code phase 改的字段 / API / dir 出现在多个 §B drift 描述里
- §B drift 标过「待 X 类 phase 清理」/ X 类已发生
- 自然语义已 align（实然行为 = 应然原则）/ 仅 drift 描述滞后

**模板**（4 步 / 0 代码）：

1. **grep 字段 / API 名**遍历 design/modules/ + design/interfaces/ 找所有 mention
2. 每条 mention 实测核（grep src/ 实然 / 与 design 描述对照）
3. 已 align 的 closed / 含义已扩的更新描述 / framing 错的推翻
4. 同步 §1+§2+§7.D 描述（不只 §B 表 / 历史里程碑加一条 design 重审记录）

**实证**：phase 432+438 后 §B 3 子条 1 次 close（pendingQueue 字段保留 / async tool 与 subagent 调度源双轨 / 待清 path）+ §1「双轨语义」改「双 type 单轨调度」+ §2「内存路径异步 tool 历史遗留」改「双轨已收敛」+ §7.C M#4 「async tool 内存主存待迁」改「fs-driven ✓」+ §7.D 加 milestone。

**关键发现**：「pendingQueue 从 drift 重定义为合理派生态」— 同样的代码 / 不同的 framing → 0 代码 close。phase432 后 ToolTask 也经 fs / pendingQueue 现在是「fs ingest 后内存等调度的派生态统一队列」/ §3 资源表本就标派生态 / 应然 align。

**反模式**：

- ❌ code phase 完后只改 §B 那一条 / 不扫 §1/§2 的描述同步
- ❌ drift 标「待 X phase 清理」久挂不审 / 实然 X phase 早完
- ❌ 假设应然描述为真 / 不 grep 实测核（接 framing 推翻案）

立项：2026-05-03 async tool cluster 收尾 design 重审（phase432 + phase438 后 / 0 代码）。

---

## spec 描述错位推翻（framing 推翻第 2 类 / phase 414c L6 audit 后续）

**范围**：design 文档里的应然 spec 描述本身可能错（不是 code drift / 是 spec 幻象 + location 错位 + export 清单不全）。

**3 子类 framing 错位**：

| 子类 | 案例 | 表现 |
|---|---|---|
| **port abstraction STALE** | phase422 H9 WatchdogPort 推翻 + cluster 7 闭 | 应然写 port pattern 治理胜利 / 实然 = design debt / 真合规 = 删 port |
| **location 错位** | l6_watchdog A.spec-2「3 命令在 cli/ 不在 watchdog」全错 | 应然描述 src/ 位置 / 与实然完全相反 |
| **export 应然幻象** | l6_watchdog A.spec-2 statusCommand 应然 export 实然不存在（watchdog 0 own status 子命令 / 全系统 status 在 CLI 模块）| 应然清单写了实然没有的 export |

**真合规模板**：

- **实测先行**：`grep -n "^export.*Command" src/<module>/` 真清单
- **应然幻象删**：实然 0 export 的应然清单条目直接删（不是 underspec / 是 spec 自创概念）
- **位置归属决策**：跨模块 export 决定哪个模块 own / 看「业务语义动词集」+ 「资源唯一归属」M#3
- **同模块内应然+实然双向同步**：modules/<l>.md §1 业务语义 + §A.spec-* + §7.D 历史里程碑同步修订 / interfaces/<l>.md 应然 export 清单 + 注实然位置

**关键发现 — 「watchdog 状态查询」归属决策**：

- 状态查询**原子**（`getWatchdogPid` + `isWatchdogAlive` + `getWatchdogEntryPath`）归 Watchdog 模块（M#3 资源 own）
- 状态查询**复合命令**（`clawforum status` 报 watchdog+motion+claws）归 CLI 模块（M#1 业务语义 = 多模块综合状态 / 跨模块编排）
- watchdog 不 own 任何 `*Command` 子命令名为 status / 真 own 的子命令仅 start+stop（生命周期动词）
- → 模块边界判据：原子归资源 own 模块 / 复合编排归 CLI 等编排层

**反模式**：

- ❌ 应然 spec 列实然不存在的 export（如 phase414c 修订加 4 实然 export 时漏删 1 应然幻象 statusCommand）
- ❌ location drift 描述未实测核就登记（A.spec-2 描述「3 命令在 cli/」/ 实然 start+stop 在 watchdog.ts）
- ❌ 把跨模块综合命令归到资源 own 模块（status 综合命令应归 CLI 不归 Watchdog）

**升格信号 / framing 推翻案累**：

- 跨多 phase / 多类形态：phase422 port STALE + phase432 callback closure design smell + phase 426/427/429/430 5 port cluster + 本次 spec 错位
- 应然 spec drift 周期性自审是必修（同 code drift / 不只 §B 标 open / 整 design 文档需周期性 framing 实测）

立项：2026-05-03 l6_watchdog A.spec-2 framing 推翻 closed（design only / 0 代码）。

---

## 3 doc 层职责严格分离（2026-05-04）

**arch.md / interfaces/*.md / modules/*.md 职责边界**：

| Doc | 性质 | 允许内容 | 禁止内容 |
|---|---|---|---|
| **architecture.md** | 逻辑层 | 模块本质 + 层归属 + 表 1+2+3 + 拓扑 + 装配归属维度 + 三 principle sets explicit cite | class/function/file/const/import 名 / src path / @module 注解 / phase ref |
| **interfaces/*.md** | 代码层 / 跨模块 contract | 生产/消费方 + 接口签名（TS）+ 使用语义 + 归本/不归本 + 不可消除耦合理由 + 上游 deps line | 模块内部 §7 drift 登记 / 应然原则对照 / 历史纪律 / src path（除非 cross-cutting type 位置）|
| **modules/*.md** | 代码层 / 模块内部 | §1-§6 应然（职责 / 业务语义 / 资源 / 持久化 / audit / 层级）+ §7 drift 登记 + §8 测试 + §10 agent 工具承诺 | 接口签名（归 interfaces）/ 生产/消费方节（归 interfaces）|

**修订原则**：
- arch ref 删除时 propagate 至 interfaces + modules 三方同步
- src path 跨界发现 → 移到 modules（modules 是 src path 唯一允许位置）
- drift metadata 在应然层 §1-§6 = 边界违反 / 应迁 §7

立项：2026-05-04 治理 / 8 reverse phases propagation 后 3 doc 全核（含 StatusService 新增 derive）。

---

## M#3 业务资源 vs 物理路径独占（2026-05-04）

**M#3「资源唯一归属」指业务资源单源 own / 不是物理路径独占**：

- 表 1「资源」列述模块 own 的**业务资源**（功能性概念 / 如「目录队列」「契约目录树」「dialog 持久化」）
- 物理路径约定（如 `tasks/`）可包含**多模块共享子目录** / scratch 资源不在表 1 列

**典型案例**：
- `tasks/sync/{exec,write,spawn}/` scratch space — CommandTool + FileTool + sync subagent caller 各自子目录写入 / Snapshot 触发清理 / 装配方 own lifecycle / 不归任一业务模块（与 `tasks/queues/results/` 归 AsyncTaskSystem own 不同 / phase 510-512 layout cluster 后命名 align）
- 「双重归属」framing 通常错位 — 实际是「业务归一模块 + 触发归另一模块」（caller 注入 pattern）/ 不存在真双 own

**应然 framing 推翻判据**：
- Cron 「dream 系列双重归属（cron 触发 / memory 业务）」→ 真合规 = dream 全归 L4 MemorySystem own / Cron 仅按 schedule 触发 handler / caller 注入 jobs handler pattern align arch §26 表 1 deps「业务依赖由 caller 注入 jobs handler 自持」

**措辞模板**：
- scratch space：「写入装配方注入的 syncDir / 本模块不 own 该目录 lifecycle / 清理归 X 触发」
- caller 注入：「jobs handler 由 caller 注入 / 本模块仅触发 / 业务 state 归各业务模块 own」

立项：2026-05-04 l4_task_system §3 sync/ 标注 + l5_cron 双重归属 framing 推翻 closed。

---

## 应然幻象识别（2026-05-04）

**应然写 X 但实然 0 实施 = 应然幻象 / 应删**：

**典型形态**：
- **method/class 幻象**：interfaces 写 `cliMain(argv)` 单函数 / 实然 commander program 模式 → 删
- **抽象层幻象**：interfaces 写 `CliSubcommandHandler` type / 实然 named export 分散 → 删
- **子命令幻象**：modules 写「watchdog statusCommand」/ 实然 watchdog 0 own status 子命令（综合 status 在 CLI）→ 删
- **错误类幻象**：interfaces 写 `DialogStoreError` / 实然 0 实施（fs error 原样抛）→ 删
- **rich type 幻象**：interfaces 写 SubAgentTimeoutError class / 实然走 AbortController + audit events → 删

**判据**：「应然 rule 必有现实功能依据反向」（Path #1 实测 grep 实然）

**修订**：
- interfaces 删 X 应然幻象 export
- modules §A.spec-X 登记 framing 推翻 closed
- 真合规 framing 浮出 / 0 代码改 / design only

立项：2026-05-04 多模块累计 framing 推翻案（CLI cliMain / Watchdog statusCommand / DialogStore Error class / SubAgent timeout class 等 / 全 phase414c L3-L6 audit closed）。

---

## arch renumber propagation 模板（2026-05-04）

**新模块插入 arch §X 后 / 后续 §X 全 renumber 的系统性 propagation**：

**Step 1**：识别影响范围
- 新增 §X → 后续模块 §X+1, §X+2, ... 全 renumber
- 例：StatusService §28 新增 → Daemon §28→§29 / CLI §29→§30 / Watchdog §30→§31 / Assembly §31→§32

**Step 2**：grep 各 module §1.做 docblock arch ref + §M#5 (per arch §X 表 1) refs

**Step 3**：batch edit 各 module 同步 arch ref 号

**Step 4**：核 arch 表 1+2+3 是否需要新行（被新模块 ownership 转移影响的旧模块行也需修订 / 如 status 工具从 CLI 迁 StatusService → CLI 行删 status / StatusService 行加 status）

立项：2026-05-04 StatusService §28 新增后 / Daemon+CLI+Watchdog+Assembly 4 module §1.做 docblock + §M#5 refs propagation 完成。

---

## 业务工具归 owner module cluster（2026-05-04 phase 446 收尾 / 5 实证累成立）

**范围**：agent 工具的物理位置归属 / 不是「散落通用 builtins/」/ 是「归到该工具业务语义所属的 owner module」。

**判据**（识别工具应归哪个模块）：

- 看工具的**业务语义**：done/contract 操作 → ContractSystem / memory_search → MemorySystem / send → Messaging / skill → SkillSystem / status → StatusService
- 通用 builtins/ 是反模式（无业务归属 / 历史遗留 / 散落各处）
- 工具 schema + execute + audit events + port interface 一并归 owner module

**5 实证 cluster（2026-05-04 phase 446 收尾成立）**：

| Phase | 工具 | 迁出 | 迁入 |
|---|---|---|---|
| 360 | done | 通用 builtins | ContractSystem (L4) |
| 416 | memory_search | 通用 builtins | MemorySystem (L4) |
| 440 | send | foundation/tools/builtins/ | Messaging (L2) |
| 442 | skill | foundation/tools/builtins/ | SkillSystem (L2) |
| 446 | status | foundation/tools/builtins/ | **StatusService (L5 NEW)** |

**真合规 derive**：M#1 独立可变职责 + M#2 业务语义归属 + M#3 资源唯一归属 三原则联合 / 业务工具语义归 owner module / 不归通用 builtins/。

**模板**（per `feedback_physical_factory_assembly_triple` 三复合）：

- Step A：物理立 / mkdir owner-module 子 dir + git mv 工具 file（保 history）+ NEW barrel 包含工具 + audit-events + port types
- Step B：caller cascade / builtins/index.ts 删 import + re-export + register / Assembly 显式 register（同 phase 440/442 模板）
- Step C：design 同步 / l<N>_<module>.md §A 收 closed + §7.D milestone

**升档候选**：r+1 Meta 34 评估升格独立 feedback「业务工具归 owner module」（B 类 / 当前嵌在 `feedback_physical_factory_assembly_triple` 内）。

立项：phase 446 StatusService L5 新模块物理立收尾（2026-05-04）/ phase 360+416+440+442+446 cluster 5 实证累成立。

---

## hypothetical drift framing 推翻（2026-05-03 phase B.3 / governance work-around 形态）

**范围**：design §B drift 标登记的「应然 rule X / 实然违反 / 待治理」/ 但 X 是 hypothetical / 实然 0 incident / tsc / language / framework 已 enforce。

**判据**（识别 hypothetical drift）：

- 「出错风险随依赖项增多而上升」「未来可能 X」「随 N 增大风险升」等 hypothetical phrase
- 实然 incident 计数 = 0
- 语言/工具/框架已 enforce（如 tsc closure capture / TypeScript readonly / vitest 自动校验）
- 「治理工程化」叙事（N 次累积 best practice）

**真合规模板**：

- 当前实然已合规 / 0 governance 需要
- 「显式 X」抽 metadata 反而是 duplication（X 在 closure / TypeScript / framework 中已声明）
- drift 描述应推翻为「framing 错」/ 不是「待治理」

**实证案例**：

- l6_assembly **B.3 显式 DAG 装配**：原 framing「构造顺序拓扑当前隐式表达 / 应显式 DAG 声明」/ 实测 4 项判据：
  1. tsc closure capture 已编译期 enforce dep 顺序（缺 var 立 `Cannot find name`）
  2. assemble.ts 30 factory 严格线性 / 0 multi-path / 0 cyclic / 非 DAG 场景
  3. disassemble 实然只 stop 6 项有 stop method / 0 反向 cascade 风险
  4. 「出错风险随依赖项增多而上升」hypothetical / phase154-158 接力至今 0 incident
- → closed (framing 推翻 / 0 代码)

**与既有节关系**：

- 同根 `port pattern 反向 design cluster` 7 闭环（governance work-around 累 7 + B.3 = 8）
- 同根 `spec 描述错位推翻` 第 2 类（hypothetical drift 是其新子形态 / 不是 location 错位 / 不是 export 应然幻象 / 是「应然 rule 本身 hypothetical」）

立项：phase B.3 显式 DAG framing 推翻（2026-05-03）/ governance_workaround_smell 第 8 实证 / 「应然层 hypothetical drift」首发实证。

---

## 状态查询「原子 vs 复合」归属决策模板（2026-05-03 l6_watchdog A.spec-2 案）

**范围**：跨模块状态查询命令归属（如 `clawforum status` 报 watchdog+motion+claws 综合 / vs watchdog 独立 status 子命令）。

**判据**：

- **状态查询原子**（如 `getWatchdogPid` + `isWatchdogAlive` + `getWatchdogEntryPath`）→ 归资源 own 模块（M#3 资源唯一归属 / 谁 own state 谁 own 查询原子）
- **状态查询复合命令**（如 `clawforum status` 综合多模块状态）→ 归 CLI 编排层（M#1 多模块综合状态 ≠ 单模块业务 / 跨模块编排是 CLI 业务语义）

**实证案例**：l6_watchdog A.spec-2 framing 推翻

- 原 framing：「应然 watchdog 模块 own startCommand/stopCommand/statusCommand / 实然 3 命令位置错位」
- 实测：watchdog 真 own start+stop（src/watchdog/watchdog.ts:507/541）/ statusCommand **应然幻象**（watchdog 0 own status 子命令）/ 全系统 status 在 src/cli/commands/status.ts 归 CLI
- → 真合规：原子归 watchdog（getWatchdogPid 等公共 export）/ 复合命令归 CLI（dep watchdog 公共 export 组装）

**应然 spec 修订模板**：

- interfaces/<l>.md 模块节：仅列原子 export / 不列复合命令
- modules/<l>.md §1 业务语义动词集：列原子 / 注「复合命令归 CLI」
- 命名空间归属：原子 audit 归本模块 / 复合命令 audit 归 CLI（cli_*）

立项：phase l6_watchdog A.spec-2 framing 推翻（2026-05-03）/ 同根 spec 描述错位推翻 / 状态查询归属决策跨多 design 文件 propagation 模板。

---

## Path #1 实测核浮出 hidden drift 治理模板（2026-05-04 phase 454 首发）

**范围**：不在 §A/§B 表的 hidden drift / 应然 spec 沉默 / 但实然违反 M#5 / M#3 等原则 / 通过用户深核问 + 主会话 grep 实测发现。

**触发模式**：

- 用户问「除了 X 没别的了吗」（深核触发）
- 主会话 grep 全集（实然 import / 字符串值匹配 / cross-layer 反向 dep 等）
- 浮出隐藏 drift（不在原 §A 表 / 不需先做 design phase 前置）
- 直接 code phase 落地（跳过 design phase / 因实然行为已锚定违规点）

**实证（phase 454 Runtime → Assembly cross-layer-up）**：

- 用户问「除了 spawn schema + ask_caller 没别的了吗」
- 主会话 grep `from.*assembly` src/core/runtime/ 浮出 5 处反向 import
- 直接 phase 454 落地（runtime.ts 改 RUNTIME_AUDIT_EVENTS + last-exit-summary 改字符串字面量）/ 0 design phase 前置

**真合规判据**：

- hidden drift 必有「应然原则违反」锚定（如 M#5 / M#3 / D5 等）— 不只是「看着不对」
- 实然行为可直接修正（不依赖应然 spec 重整）
- code phase scope 小（≤ 80 行 / 单 commit）/ 不需多步推导

**与既有节关系**：

- 同根「framing 推翻」三子类（port STALE + location 错位 + spec 应然幻象）/ 本节是新形态：**应然 spec 沉默 + 实然违规**（不是 spec 错 / 是 spec 没覆盖）
- 同根 `feedback_governance_workaround_smell §1 cross-layer-up 必反向消除`

**反模式**：

- ❌ 浮出 hidden drift 后强行先写 design phase sharpen（应然 spec 已无需修订 / 仅实然 align 即可）
- ❌ hidden drift 不登记 §A 完成事后审计（治理 phase 必同步加 §A row + closed 标记 / 否则下次同问再被深核浮出）

立项：phase 454 Runtime → Assembly cross-layer-up 反向 import 治理（2026-05-04 / 首次实证）/ 推 ≥ 2 实证后升格独立 feedback 模板。

---

## cross-layer-up 治理双类区分模板（2026-05-04 phase 454）

**范围**：cross-layer-up 反向 import 类违规（L5 → L6 / L4 → L5 等）的治理路径分双类。

**双类区分**：

| 类型 | 性质 | 真合规处置 |
|---|---|---|
| **类型 1：编译期 dep 借用** | 跨层 import const / 借用上层命名空间 / 编译期反向依赖 | 改 own 模块 audit events（M#3 资源唯一归属）/ 删 import |
| **类型 2：跨进程字符串契约** | 跨进程 audit.tsv 等磁盘 artifact 字符串值匹配 / 运行期字符串契约 | 改字符串字面量匹配（不 import const）/ 同 `practices.md §测试字符串值断言是 cross-check 设计`（phase 393）|

**判据**：

- caller 是否**编译期** dep 上层模块的 const / type / class → 类型 1（改 own）
- caller 是否**运行期**消费上层模块写入的磁盘 artifact 字符串值 → 类型 2（改字面量）

**实证（phase 454）**：

- runtime.ts L204+L276 写 ASSEMBLE_FAILED → **类型 1**（改 RUNTIME_AUDIT_EVENTS.INBOX_INIT_FAILED + SESSION_REPAIR_FAILED）
- last-exit-summary.ts L88-92 case DAEMON_* → **类型 2**（改 case 'daemon_stop' / 'daemon_crash' / 'daemon_unclean_exit' 字面量匹配 audit.tsv 跨进程契约）

> 关联：phase 706 audit key naming 决策树（L2761）/ 类型 1 编译期 dep + 类型 2 跨进程契约 在 phase 706 audit key 命名层面具体落地

**反模式**：

- ❌ 类型 1 + 类型 2 一刀切处置（如全改字面量 / 类型 1 失去 const ref 编译期保护 / 拼写错时 tsc 不报）
- ❌ 类型 2 抽 cross-cutting `daemon-event-types.ts` 共享 const（不立新模块层级 / 字符串契约接受重复 / 同 `feedback_dry_reflex_vs_m2_format`）

**与既有节关系**：

- 同根 `practices.md §测试字符串值断言是 cross-check 设计`（phase 393）— 类型 2 的具体应用
- 同根 `feedback_dry_reflex_vs_m2_format`（phase 361 反例）— 字符串契约不抽 utility

立项：phase 454 Runtime → Assembly cross-layer-up 治理（2026-05-04 / 首次完整应用双类区分）。

---

## design+code 联动 3 阶段 cluster（2026-05-04 phase 444+450+453 首次完整）

**范围**：跨 design phase + code phase α + code phase β 的完整 3 阶段联动 cluster。

**3 阶段形态**：

| 阶段 | 类型 | 工作 |
|---|---|---|
| 1 | **design phase** | 应然层 sharpen / 4 design-gap 登记 / G1-G4 待用户拍板 |
| 2 | **code α** | 底层模块（被 dep 模块）重构 / ctor 签名改 / schema 改 / 17+ caller cascade |
| 3 | **code β** | 上层 caller（dep 方）改调 / 装配 ephemeral instance / 经底层接口消费 / 9+ caller cascade |

**实证（phase 444 + 450 + 453 / DialogStore L2 + SubAgent L3）**：

| 阶段 | Phase | SHA | 时间 |
|---|---|---|---|
| 1 design | phase 444 | `a9eaac98` | 2026-05-03 |
| 2 code α | phase 450 | `38f86606` | 2026-05-04 |
| 3 code β | phase 453 | `0bab36ca` | 2026-05-04 |

**与之前 2 阶段联动的差异**：

| 模式 | 联动 |
|---|---|
| 2 阶段（phase 373→377 / phase 395→396）| design + code 同 phase α |
| **3 阶段（phase 444+450+453）**| **design + code α + code β 严格分离** |

**真合规判据（何时拆 3 阶段）**：

- 底层模块 ctor / schema 重构破坏既有 caller / 必先 code α
- 上层 caller 装配 ephemeral instance / 依赖底层新形态 / 必后 code β
- 单一 phase 拆开会破坏「单 commit 原子性」（per `feedback_step_granularity_sub_overview`）

**反模式**：

- ❌ design 后跳 code α 直接改 code β（caller 装配时底层 ctor 不支持 / tsc fail）
- ❌ code α + β 合并单 phase（破单 commit 粒度 / 17 + 9 caller cascade ≥ 80 行违阈值）

**升格条件**：

- 累 ≥ 3 实证 → 升格独立 feedback「design+code 3 阶段联动模板」（同 `feedback_design_fork_to_code_fork` 当前 2 阶段为主 / 3 阶段是新子形态）

立项：phase 444 + 450 + 453 DialogStore + SubAgent 联动 cluster（2026-05-04 / 首次完整 3 阶段实证）。

---

## port pattern 推翻 cluster 8/8 全收官（2026-05-04 phase 458）

**范围**：clawforum 历史立的 *Port abstraction 整套反向消除 / cluster 全收官里程碑。

**8/8 cluster**：

| Phase | port | 来源 | 反向 |
|---|---|---|---|
| 422 | WatchdogPort H9 | phase 348 | -59 行 |
| 424 | TaskLifecyclePort | phase 412 | -12 行 |
| 426 | RetroScheduler | phase 364 | scheduleRetro 函数 |
| 427 | ContractVerifierScheduler | phase 340+364 | -112 行（删整 verifier-scheduler.ts）|
| 429 | Runtime 11 余 ports | phase 335 | -104 行（删整 runtime-ports.ts）|
| 430 | PermissionChecker | phase 377+373+368 | 删整 permissions.ts |
| 432 | TaskScheduler L3 port | phase 163 | declarative schema 替代 closure |
| **458** | **ContractStatusPort（收官）**| phase 446 | **-59 行（删 2 文件）**|

**收官硬证据**：`grep -rnE "^export interface \w+Port\b" src/` = **0 命中**。

**8/8 累净 source delete ~430+ 行** / 1373+ tests PASS / 0 行为改 / 真合规设计回归（删 port 抽象 + 直 dep concrete）。

**关键洞察（phase 458 新加）**：

- **「DIP 模式」可能是 over-engineering**：phase 446 立 ContractStatusPort 时按 DIP 设计（L5 own port / L4 provide impl）/ 但 1 impl + 0 ROI = governance work-around 而非真合规
- **N=1 impl 是 STALE 信号**：未来不会有第 2 个 impl 的 port abstraction 应直接删（同 phase 422-432 cluster 模式）
- **Path #1 实测核必扫所有 *Port interface**：phase 422-432 cluster 收尾后 / phase 446 立 1 个新 port / 用户问触发深核才发现 / 应建立周期性 grep `^export interface \w+Port\b src/` 自审

**升格判据**：cluster 8/8 收官后未来不应再立 port abstraction / 设计期看到 port pattern 想法立刻审视：
- 真有 ≥ 2 impl 需求？（多 provider / 多 backend / etc）
- 是否实然 1 impl + 0 ROI？
- 真合规 = 直 dep concrete / 不立 port

立项：phase 458 ContractStatusPort STALE 推翻（2026-05-04）/ cluster 8/8 全收官（phase 422-432 7 + phase 446 立 + phase 458 推翻）/ 「治理 work-around 是 design smell」cluster 8 实证完成。

---

## design+code 联动两形态分类（2026-05-04 phase 454+458 vs phase 444+450+453）

**范围**：design phase 与 code phase 的联动 cluster 形态分类 / 决定 phase 拆分粒度与时序。

**两形态**：

| 形态 | 实证 | 性质 | 触发模式 |
|---|---|---|---|
| **3 阶段（design + code α + code β）**| phase 444+450+453（DialogStore + SubAgent）| 大 scope 重构 / 应然先 sharpen / 底层重构 + 上层 caller 改调严格分离 | 应然 spec 不完整 / 需先 design phase sharpen + 4 design-gap 登记 |
| **0 design phase 前置（hidden drift 直落）**| phase 454（Runtime → Assembly）+ phase 458（ContractStatusPort STALE）| 中-小 scope / Path #1 实测核浮出 / 应然立场已 align 真合规 / 直接 code 落地 | 用户深核问触发 + 主会话 grep / 实然违 M#5 + 应然推翻设计已 align |

**判据**（何时哪形态）：

- 应然 spec **不完整 / 待 sharpen** → 3 阶段（design phase 先 / 然后 code α + β）
- 应然 spec **已 align 真合规推翻** → 0 design phase 前置（直接 code）
- code scope **大 / 跨多模块**（≥ 17 caller cascade）→ 倾向 3 阶段（拆 α + β）
- code scope **小**（≤ 80 行 / 单 commit）→ 0 design phase 前置可行
- **hidden drift（不在 §A 表）**→ 0 design phase 前置 + 同步加 §A row closed

**反模式**：

- ❌ hidden drift 强行先写 design phase sharpen（应然 spec 已无需修订 / 仅实然 align 即可 / 浪费 phase）
- ❌ 应然 spec 不完整时直接 code（caller 装配模式无 design 锚 / 未来回溯困难）
- ❌ 大 scope 单 phase 合并 code α+β（破单 commit 原子性 / 违 `feedback_step_granularity_sub_overview`）

**实证统计**：

- 3 阶段：phase 373→377（PermissionChecker 早期）+ phase 395→396（H6 异步化）+ phase 444+450+453（DialogStore + SubAgent / 首次完整跨 9 days）
- 0 design phase 前置：phase 454（Runtime → Assembly / cross-layer-up）+ phase 458（ContractStatusPort STALE / port pattern 推翻）= 2 实证

立项：phase 454 + 458 双实证（2026-05-04）/ 推 r+ Meta 扩 `feedback_design_fork_to_code_fork` 加形态分类 / 真合规判据细化。



---

## design-gap derive 5 判据（2026-05-04 DialogStore G5-G7 8 轮 derive 后归纳）

**范围**：design-gap 的真合规设计 derive 时 / 用以判断方案的 5 条判据。

**判据**：

| # | 判据 | 应用举例（DialogStore G5）|
|---|---|---|
| **1** | **「不变属性 vs 动态字段」schema 区分** | systemPrompt = instance lifetime 不变属性（ctor 锁定）/ messages = 动态累积字段 / schema 区分对待（ctor 参 vs save 参）|
| **2** | **「业务变化触发 = 业务责任」** | system prompt 变化的检测和触发归 caller（Runtime + ContextInjector）/ DialogStore 不内部 magic（不 auto-archive on system change）|
| **3** | **「1 资源 = 1 实例 = 1 文件」per-regime 边界** | 1 SessionData = 1 (systemPrompt + messages) 配对 / 1 dialog file = 1 system prompt regime / 不混 |
| **4** | **「最简 schema 优先」** | 单字段 systemPrompt 优于 history 数组 / 优于多文件 jsonl / 优于 SubAgentTask snapshot 业务穿透 / 单字段够用即不无中生有 |
| **5** | **「已有机制优先」** | SubAgent 现有 DialogStore dep 注入机制 / 加第 2 个 dep 比新发明 SubAgentTask snapshot 干净 / 0 新机制就能扩 |

**反模式（避免）**：

- ❌ **fidelity loss 包装**：方案有 fidelity 损失却包装成「反而更好」（如「current ContextInjector 反而更有用」）/ 必须显式标 fidelity loss / 不能掩盖
- ❌ **责任推卸到 caller 装 cleanness**：把业务推给 caller 不算 cleanness / 真合规 = 该 own 的 own
- ❌ **跳过最简方案直奔复杂**：不先试单字段 / 单 method / 单文件 / 直接推 history 数组 / archive snapshot / SubAgentTask snapshot / 4 种花样
- ❌ **false premise 当推荐理由**：每个推荐的「理由」必须核实然机制是否成立（如「IO 放大」「性能」「复杂度」论据不能 hand-wave）

**派生（DialogStore G5-G7 真合规设计）**：

```ts
class DialogStore {
  constructor(
    fs, dialogDir, audit, filename,
    systemPrompt: string,        // ctor 锁定 / instance lifetime 不变 / 1 instance = 1 system prompt regime
    clawId?, archiveDir?,
  );
  readonly systemPrompt: string;  // 暴露给 caller 检查
  
  load(): Promise<LoadResult>;
  save(messages: Message[]): Promise<void>;        // 0 扩参 / system 已 ctor 绑
  archive(): Promise<void>;                         // current → archive/
  restorePrefix(marker): Promise<RestoreResult>;   // 返完整前缀 {messages, systemPrompt, meta}
}

// caller 业务（Runtime / ContextInjector）：system 变 → archive() current → new DialogStore(..., newSystemPrompt) + 业务决定继承 messages 否
```

立项：DialogStore G5-G7 用户 8 轮 derive 锁定（2026-05-04）/ 5 判据 + 4 反模式归纳 / 推 r+ design-gap derive 通用方法论。

---

## Path #1 实测核浮出 hidden drift 治理模板（4 形态分类成熟 / phase 454+458+461+464）

**范围**：不在 §A 表的 hidden drift / 应然立场已 align 真合规 / 实然未落地 / 通过用户深核问 + 主会话 grep 全集浮出。

**触发模式**：

- 用户问「除了 X 没别的了吗」
- 主会话 grep 全集（cross-layer-up + *Port + shared utility + dead code 等）
- 浮出隐藏 drift（不在原 §A 表 / 0 design phase 前置）
- 直接 code phase 落地

**4 形态分类**（phase 454+458+461+464 实证累达硬化阈值）：

| 形态 | 实证 | 真合规处置 |
|---|---|---|
| **cross-layer-up 反向 import** | phase 454 Runtime → Assembly | 双类区分（编译期 own audit / 运行期字符串契约）|
| **STALE port abstraction**（1 impl + 0 ROI）| phase 458 ContractStatusPort（cluster 8/8 收官）| 删 port + caller 直 dep concrete |
| **shared utility DRY reflex** | phase 461 frontmatter | DELETE utility + caller inline 各自 |
| **dead code orphan dir** | phase 464 cli/ink | DELETE 整 dir / 0 caller cascade |

**Path #1 全核 0 残留硬证据**（phase 464 后）：

```bash
grep -rnE "^export interface \w+Port\b" src/        # 0
grep -rnE "from.*['\"]\.\.?/.*runtime|...assembly|...cli|...daemon|...watchdog" src/foundation/ src/core/contract/ src/core/task/ src/core/memory/ src/core/evolution-system/  # 0
ls src/foundation/frontmatter src/cli/ink           # 2 NOT FOUND
```

**真合规判据**：

- 实然违 M#5 / M#3 / M#7 / M#10 / M#11 等原则
- 应然立场已 align 真合规推翻设计（不需先 design phase）
- code scope 中-小（≤ 80 行 / 单 commit）
- 同步 §A row closed + practices.md / feedback 节加实证落地注

**反模式**：

- ❌ hidden drift 强行先写 design phase sharpen（应然 spec 已无需修订）
- ❌ hidden drift 不登记 §A 完成事后审计

立项：phase 454+458+461+464 治理 cluster（2026-05-04）/ 4 形态分类成熟极致 / 推 r+ Meta 升格独立 feedback「Path #1 实测核浮出 hidden drift 治理模板」**必硬化**。

---

## design phase 仅 derive 拆 phase strategy（应然完整 sharpen 后 / 2026-05-05 phase 479）

**适用条件**：模块应然层 §10.X 系列已多 phase 历史 sharpen 完整（如 r53+ phase403 + phase 444+456 等多次累积）/ 单 phase 治理面对多子条（≥ 3）但 0 应然 unsharpen / **design phase 工作 ≠ derive 应然 / = derive 实施拆分 strategy**。

**模板**：

1. **Step 0 实测核**：caller universe + 实然 gap 5 维度（工具实体 / 底层基础设施 / 触发机制 / 装配协议 / profile 等）
2. **Step A 决策矩阵呈板**：G1-Gn 决策点（含 sub-decisions）+ 主会话 default + 原则推力（每决策列对应原则）
3. **r+1 phase 拆分 strategy**：N 子条 → M code phase（M ≤ N / 共享 caller cascade 子条同 phase / 依赖图清晰）+ 实施顺序建议
4. **Step B 应然 sharpen**：§A 标 closed-design + 引 r+1 phase 编号（不二次撰应然 / 仅落 closing）+ §7.D milestone

**关键判据**（本 phase 479 实证）：
- §10.1-§10.7 7 节应然全 sharpen → design phase 0 应然 derive
- 5 子条 → 4 r+1 code phase（A.5+A.6 同 phase 482 共享时序合并 derive / A.2+A.4 同 phase 480 同根）
- 实施顺序 481→480→482→483 由依赖图 derive（M#11 设计与依赖对不上停下）

**反模式**：

- ❌ design phase 重新撰写应然（破坏单源 / drift 风险）
- ❌ 不拆 r+1 phase / 1 phase 治多子条（违反 phase 单 commit 原子性）
- ❌ 决策矩阵 default 无原则推力 / 主会话拍脑袋

**首次完整应用**：phase 479（Cluster A exec 通道 / 5 子条 / 4 code phase 拆 / 8 sub-decisions / 7 锁定 + 1 推迟）。

---

## 设计决策必须从原则推导（2026-05-05 phase 479 完整实证）

**模板**：每个决策点列出 N 原则推力 + 论证 / 而非「主会话拍板」或「试用看效果」。

**phase 479 实证**（5 决策点 / 每个决策的原则推力）：

| 决策 | 原则推力 | 锁定/推迟 |
|---|---|---|
| G1 L1 exec 双入口合并 (a) | M#1+M#7+M#8+M#9+D7+Philosophy（5 原则）| 锁定 |
| G2 verifier profile EXEC | M#2+M#8+D7+审计（4 原则倾向 / 但本质业务决策）| **推迟**（原则只能推到「角色定义清晰」/ 不能 derive 改实然 vs 改应然）|
| G3 stdout/stderr 时序合并 (a) | D5（信息不丢失 / 强）+ M#1（双流→单流归 L1）+ D7（OS truth）| 锁定 |
| G4 单一阈值 (a) | G3 derive + M#7+M#8 | 锁定 |
| G5.b 兜底落盘归属 (i) | **M#5 强排除 (ii) Assembly 反向注入** | 锁定 |
| G5.c Snapshot 清 (i) | M#1+M#2 commit 副产品归 Snapshot 自身 | 锁定 |

**关键洞察**：

1. **D5「运行中信息不丢失」是 cluster A 决策强力锚点**（G3 时序合并完全由 D5 derive / 其他选项都丢失行序信息）
2. **M#5「依赖单向」直接排除选项**（G5.b 选项 (ii) Assembly 注入 handler = command-tool dep Assembly 反向 / M#5 强排除）
3. **业务决策 vs 设计决策分层**：原则能 derive 设计决策（M#1-M#11 + D1-D11）/ 不能 derive 业务决策（如 verifier 实然该不该有 exec / 是业务定义）/ 区分清晰防过度治理
4. **多原则同向推力强化锁定**：G1 (a) 5 原则全 align / G3 (a) 3 原则全 align / 锁定信心高

**反模式**：

- ❌ 主会话拍脑袋 default 无原则推力
- ❌ 业务决策（如角色定义 / scope 选择）伪装设计决策（用原则强行 derive 出超出原则范围的结论）
- ❌ 多选项原则推力相当时仍锁定（应推迟实测）

**累实证**：phase 422+424+426+427+429+430+432+458 port pattern 8 cluster（M#5）+ phase 461 DRY reflex 反例（M#1+M#7）+ phase 479 cluster A 8 sub-decisions / **本 phase 首次完整 6 决策 × 多原则矩阵呈板**。

---

## modules/*.md §7.C Path Principles 标准模板（r65 audit 33 实证后硬化）

**规则**：每个 module 契约 §7.C「应然原则对照」必含 4 个 sub-section / Path Principles 必为完整 7 条 verbatim enumeration（不缩 / 不替 / 不漏）：

```markdown
#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：[模块特定派生应用]
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：[模块特定派生应用] / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（[反向测试可在此]）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：[模块特定派生应用]（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）/ [模块特定派生应用]
```

**权威单源**：`reference_path_principles.md` Meta 31 r55 末整理硬化。

### r65 audit drift 8 形态分类学（33 实证 / 32 modules / 100% 命中）

| 形态 | drift 类型 | 实证模块 | 计数 |
|---|---|---|---|
| **A 标准 6→7 缺 #7** | header 标 6 / 列 6 entries / 缺 Path #7「总难度路径」 | 全 L1 5 + L2a 2 + L2b 4 + L2c 2 | 13 |
| **B 自造 Path #7** | 用模块特定细则替代 canonical | l2_process_manager | 1 |
| **C narrative 2-3 行** | 仅 prose bullets / 缺 enumeration | l2_file_tool / l2_command_tool / l3 全 3 | 5 |
| **D selective + Path #8 mis-numbered** | header 标 6 或无 / 列 3-4 entries / 自造「Path #8」（canonical 仅 7 条 / 第 8 不存在）| l4_task / l4_contract / l4_evolution / l5_runtime / l5_cron / l6_daemon / l6_watchdog | 7 |
| **E section 完全缺失** | §7.C 仅 M+D+Philosophy 3 节 / 0 Path Principles | l4_memory_system | 1 |
| **F minimal selective 2 entries** | 无 header / 仅 2 entries | l5_status_service | 1 |
| **G narrative + 反向测试** | 3 entries + 1 反向测试 / 无 header | l3_step / l3_agent / l5_gateway / l6_assembly | 4 |
| **H「核心条」header** | header 标「核心条」/ 仅 2 entries + 反向测试 | l6_cli | 1 |
| **总计** | — | — | **33** |

### 反模式

- ❌ selective form：仅列「与模块业务相关」的 Path 项 / 漏其他 Path 项
- ❌ 自造 Path #8 / Path #N：canonical 仅 7 条 / 模块特定派生应用归 Path #N 注 / 不创新编号
- ❌ narrative bullets 替代 enumeration：失去 verbatim 完整性
- ❌ Path Principles section 漏写：8 节模板必含
- ❌ 「核心条」/「selective」自定义 header：必标准「（7 条）」

### CI 守护建议

- grep `^- \*\*Path #6` 后立即应有 `^- \*\*Path #7` / 否则告警
- grep `Path #[89]` 或 `Path #[1-9][0-9]` = 0 命中
- grep `#### Path Principles（7 条）` = 32 命中（每 module 1 次）

---

## 单 doc 内部一致性 audit checklist 按文档类型扩展（r65 32+8+1 实证完成）

modules/*.md 12 维度（每 module 必走）：

1. §1 职责 derive 自 arch §N + M#1
2. §2 业务语义 derive 自 M#2 + 角色定位
3. §3 资源 derive 自 M#3 + arch 表 1 资源列
4. §4 持久化 derive 自 M#4 + 磁盘布局 + 重建语义
5. §5 审计事件清单 模块自治 const + caller 引用
6. §6 层级声明 align arch §N
7. §7.A 必修违规（drift / closed by phase 链 + SHA）
8. §7.B 偏差登记（design-gap row）
9. §7.C 应然原则对照 4 sub-section（M#1-M#11 + D1-D11 + Philosophy 4 + Path Principles 7 条 verbatim）
10. §7.D 历史纪律（phase 链时间序）
11. §7.E 关键决策映射（KD STALE post phase closure 必同步）
12. §8 测试覆盖

interfaces/*.md 7 维度：

1. ctor / method / class signature 与 arch 表 1+2 align
2. 消费方与 arch 表 1 caller 列 align
3. derive 链显式（M#3 + M#5 + Design Principle）
4. 不归本模块（M#1 derive）
5. 不可消除耦合理由
6. 应然幻象 zero（grep src 实然 0 命中即应然幻象 / 删）
7. 字段命名 align canonical（post phase rename）

architecture.md 自审 4 维度（r65 实证）：

1. layer table + §86 sub-section + 表 1「层」列三方命名 align（L2a/L2b/L2c）
2. 装配归属维度表举例 vs 表 1 实际值一致
3. 表 3 工具列与各 module 表 3 row align
4. Philosophy P1-P4 全显式（不漏 P1 Agent 即目录）

**累计实证**：r65 audit cycle 32 modules + 8 interfaces files + arch.md 自审 / 总 41 doc 全核 / 5 大 cluster 浮出（Path Principles 8 形态 + KD STALE post phase + D 编号 + spec drift + cross-doc derive align）。


## NEW 基础设施 phase 模板（schema 扩 + 装配协议 + 共享 dir / 2026-05-05 phase 485 收官首发）

**形态**：单 phase 立**全新基础设施** / 后续多 caller 改用 / 区别于 rename / port 推翻 / dead spec 类元数据治理。

**phase 485 实证（Cluster A r+1 收官）**：

| 维度 | 实施 |
|---|---|
| schema 扩 | ExecContext +`syncDir: string` 字段（cross-tool cascade）|
| 装配协议 | Assembly + motion bootstrap 装配 syncDir = `clawDir/tasks/sync` + ensureDir |
| 共享 dir | tasks/sync 装配-level 共享（command-tool exec_overflow + FileTool write_backup 共用）|
| commit hook | Snapshot ctor +syncDir + commit success 后 generic clean / 不区分 source / cleanup 失败 best-effort + audit |
| 防循环 | SNAPSHOT_IGNORE_PATTERNS 加 tasks/sync/ 防 git 跟踪触发 commit 循环 |

**设计判据**（3 原则全 align）：
- **M#3 资源唯一归属**：装配级共享 dir 不归任何业务模块 own
- **M#1 副产品归本模块**：command-tool 自检落盘（exec 副产品）+ Snapshot 自身清（commit 副产品）
- **M#5 防 Assembly 反向注入 handler**：强排除「Assembly 注入 cleanup handler」选项（command-tool dep Assembly 反向）

**反模式**：

- ❌ Assembly 注入 cleanup handler（M#5 反向）
- ❌ 工具方各自 own per-dir 备份（如 `.versions/` / 散落违共享 spec）
- ❌ 不加 SNAPSHOT_IGNORE_PATTERNS（commit 循环）
- ❌ commit 失败不清 / 失败也清（数据丢失）

**首次完整应用**：phase 485（Cluster A r+1 收官 / 共享 syncDir + Snapshot generic clean / FileTool 改用基础设施已就位）。

---

## 「设立基础设施 phase → 后续多 caller 改用」模板（2026-05-05 phase 432+446+485 = 3 实证）

**形态**：单 phase 立 NEW 基础设施 / 后续多 caller phase 改用 / 共享 schema / 共享 dir / 共享接口。

**累实证**：

| Phase | 立基础设施 | 后续 caller phase |
|---|---|---|
| 432 | ToolTask schema + writePendingToolTaskFile + fs-driven async tool 路径 | phase 438 dispatch handler 文件化 + caller 用 ToolTask 模板 |
| 446 | StatusService L5 NEW 模块 + Assembly 显式 register | 其他业务工具迁 owner module 模板（cluster 5/5）|
| **485** | **ExecContext +syncDir + Snapshot commit hook + 装配协议** | **Cluster B file_tool §A.6 改用 syncDir**（推 r+1 / FileTool .versions/ → ctx.syncDir 仅需 caller-side 改）|

**关键判据**：
- 基础设施 phase 自身 self-contained（含 schema + 装配 + commit hook + 防循环）
- 后续 caller phase 仅做 caller-side migration（不改基础设施）
- design 文件 cross-ref 显式登记基础设施 phase（如 §A.6 cross-ref phase 485）

**反模式**：

- ❌ 多 caller 各立各的（违共享原则）
- ❌ 基础设施 phase 留半成品（caller 必须协同改）
- ❌ 后续 caller phase 反过来要改基础设施（基础设施未稳）

**升格信号**：3 实证累达模板成熟阈值 / 推 r+ Meta 升格独立 feedback。

---

## design+code 联动 5 阶段最大形态（2026-05-05 phase 479+481+482+483+485 完整闭环）

**形态**：1 design phase + N code phase 拆 / N ≥ 4 / 应然完整 sharpen 后 design phase 仅 derive 拆 phase strategy / 不撰应然。

**phase 479-485 完整实证**：

| 阶段 | Phase | 主题 | 性质 |
|---|---|---|---|
| design | **479** | Cluster A G1-G5 决策矩阵 + 4 r+1 phase 拆分 strategy | 0 应然 derive / 0 src 改 |
| code 1 | **481** | G2 verifier dead spec 删 | 1 行 src |
| code 2 | **482** | G1 L1 exec 双入口合并 | 7 文件 ~25 行 |
| code 3 | **483** | G3+G4 L1 spawn 重写 + 单一阈值 | 10 文件 ~150-200 行 |
| code 4 (收官) | **485** | G5 兜底落盘 + Snapshot 清 + NEW 基础设施 | 10-12 文件 ~170-200 行 |

**累实证 5 阶段全形态**：

- 2 阶段（design + code α）：phase 373→377 / 395→396 / 468 / 473
- 3 阶段（design + code α + code β）：phase 444→450→453
- 4 阶段（spawn cluster）：phase 444→450→453→466
- **5 阶段（Cluster A）**：**phase 479→481+482+483+485（首发 / 2026-05-05）**

**适用条件**：
- 应然层 §10.X 系列已多 phase 历史 sharpen 完整
- cluster 多子条（≥ 4）/ 但 0 应然 unsharpen
- 子条间有依赖图（同 caller / 同基础设施 derive 同 phase）

**反模式**：
- ❌ design phase 重撰应然
- ❌ 1 phase 治多子条违单 commit 原子性
- ❌ 决策矩阵无原则推力（拍脑袋 default）

## interfaces vs src 实然 schema cross-check 第 4 维度（r66 cross-doc audit interfaces sweep 首次系统性落地）

cross-doc derive audit SOP 历史 3 维度（modules ↔ arch / modules ↔ interfaces / interfaces ↔ arch+表 1/2/3）已成熟 / r66 sweep 首次加 **第 4 维度** = `interfaces/*.md` ↔ `src/` 实然 export inventory 对账。

**为什么需要第 4 维度**：

前 3 维度都是「应然 doc 间互核」/ 不触实然 / 漏失「应然 doc 与实然 src export 长期 drift」类型 drift。最典型暴露形态：
- **schema breaking change post-phase 同步 lag**：phase 483 ExecResult `{stdout,stderr,exitCode}` → `{output,exitCode}` 单字段 / interfaces/l1.md 应然 STALE 7+ 月
- **应然幻象 cluster 集中爆发**：interfaces declare 完整抽象层（interface + factory + types）但 src 0 export / 演化期某 phase 简化 inline 后 interfaces 应然 lag（StatusService phase 446 物理立 → phase 458 简化 inline / 8 应然幻象单节）
- **应然描述精度 lag**：interfaces 写「删整 file」/ 实然 phase 删 port abstraction 但保留 file + helpers（retro-scheduler.ts post-phase 426）

**SOP 4 step（追加第 4 维度）**：

```
Step A: 读 src/<module>/index.ts + 主 file 的 export 清单
Step B: 列 interfaces/<layer>.md <module> 节 declare 清单（interface/type/class/function/const）
Step C: 双向 diff
  - interfaces declare 但 src 0 export → 应然幻象 candidate（确认应然 rule 必有现实功能依据）
  - src export 但 interfaces 0 declare → 应然 underspec 或 internal helper（按 framing 判断）
  - 双方都有但 schema 不一致 → schema breaking change post-phase 同步 lag
Step D: 修订形态二分（详下「应然 stale 修订形态二分」节）
```

**实证：r66 sweep 32 模块视角 / 15 substantive drift / 8 应然幻象（StatusService 单节）+ 2 schema breaking lag + 1 描述精度 lag + 4 其他**。

**触发条件**：每 cross-doc audit cycle 必跑第 4 维度 / 不跑会漏长期演化 lag drift / 周期性制度化（推 r+1 周期性 sweep）。

## 应然 stale 修订形态二分（r66 cross-doc audit interfaces sweep 后归纳）

post-phase 闭环后修订 doc 应然描述时 / drift 形态 + audit trail 需求决定修订形态：

### 形态 A：删除线 + ✅ closed by phaseXXX（保 audit trail）

适用场景：
- **modules/*.md §A 必修违规 row**：drift 闭环后 / 保留原描述删除线 + 加「✅ closed phaseXXX (`SHA`)」注 + 闭环上下文
- **modules/*.md §C 应然原则对照**：原则违反点闭环后 / `~~应然违反点 → A.X / 实然 leak~~ ✅ closed by phaseYYY` 形态
- **claim 单句**：单一 claim 推翻 / 行内 strikethrough

**特征**：保留历史声明 + 显式 closure 标记 / 后人可追溯 phase 闭环路径 / audit-trail-preserving。

**实证**：r65 modules sweep 主类型 / l1_process_exec.md §7.C M#1+M#5+D7 stale claim 删除线（phase482 shell mode 收口后）/ 32 modules 内 80%+ stale claim 用此形态。

### 形态 B：节内删幻象 + 加注释（应然 vs 实然 align 优先）

适用场景：
- **interfaces/*.md 应然幻象集中爆发**：单节 8+ 应然幻象（如 StatusService）/ 删除线会 visual noise + 形态 A 不适合大规模重写
- **应然 spec 幻象**（实然不存在的抽象层）：完全不是 phase 推翻治理 / 是从未实施的雏形 plan / strikethrough 形态错位
- **整节重写**：phase 演化期 framing 已根本性变（如 StatusService phase 446 物理立 → phase 458 inline 简化）

**特征**：删幻象 + 加节级注释「应然 silent on X / Y / Z N 应然幻象（phase XXX 演化 lag / 应然 rule 必有现实功能依据反向）」/ align-priority。

**实证**：r66 interfaces sweep / l5.md StatusService 节大幅 sharpen 删 8 应然幻象 + 加节级注释「应然 silent on 8 应然幻象（phase 446→458 演化 / 应然 rule 必有现实功能依据反向）」。

### 选择判据

| 场景 | 形态 A | 形态 B |
|---|---|---|
| 单条 claim stale | ✓ | ✗ |
| §A row 闭环 | ✓ | ✗ |
| §C 原则违反点闭环 | ✓ | ✗ |
| 单节 8+ 幻象集中 | ✗ | ✓ |
| 应然 spec 幻象（从未实施雏形） | ✗ | ✓ |
| phase 演化期 framing 根本变 | ✗ | ✓ |

**反模式**：
- ❌ 形态 A 用于应然幻象（保留 strikethrough 暗示「曾经实施过」/ 实然从未存在 / 误导）
- ❌ 形态 B 用于 phase 闭环 drift（丢 audit trail / 后人无法追溯 phase 闭环路径）

## 应然 spec 幻象集中爆发模式（r66 cross-doc audit interfaces sweep 暴露 / phase 446→458 演化 lag 7+ 月案例）

**模式定义**：单节 interfaces declare 完整抽象层（interface + factory + types + collect method 等）/ 但 src export 0 对应实施 / 全是 phase 物理立时雏形 plan + 后续 phase 简化 inline 后 interfaces 应然未跟进 sharpen / interfaces lag N 月。

**实证案例 — StatusService phase 446→458 演化期 7+ 月 lag**：
- phase 446 物理立 StatusService 模块 / interfaces declare `StatusService { collect(): Promise<StatusSnapshot> }` interface + `StatusSnapshot` + `ActiveContractSummary` + `ClawspaceOverview` + `SourceWarning` + `StatusServiceDeps` + `createStatusService` factory 7 类型 + 1 method
- phase 458 简化：删 ContractStatusPort abstraction + statusTool.execute 内部 inline 聚合三源（ContractSystem.loadActive + tasks ls + clawspace ls + MEMORY.md size）
- 实然 src/core/status-service/index.ts 仅 export `statusTool` + `STATUS_TOOL_NAME` + `STATUS_AUDIT_EVENTS` 3 项
- interfaces/l5.md StatusService 节 8 应然幻象（StatusService interface + collect + StatusSnapshot + ActiveContractSummary + ClawspaceOverview + SourceWarning + StatusServiceDeps + createStatusService）持续 7+ 月 / r66 cross-doc audit 首次系统性核才暴露

**根因**：
- phase 446 物理立时 interfaces 雏形 plan 完整抽象层（phase 物理立模板复合 N+1）
- phase 458 简化 inline 是 ROI 决策（统一聚合不需独立 collect() abstract layer）/ 但 interfaces 应然描述未跟进 sharpen
- 演化期窗口（phase 物理立 → phase 简化 inline）interfaces 应然 lag = 死角（前 3 维度 cross-doc audit 不触实然 / 漏失）

**治理**：
- 必跑第 4 维度 cross-check（interfaces ↔ src 实然 export inventory）/ 制度化每 cycle sweep
- phase 简化 inline 收尾 audit trail 必含 「interfaces 应然 sharpen」TODO / 推 r+1 周期 close
- 应然 rule「必有现实功能依据反向」独立 feedback 升格已成立（r57+ 修订）/ 此模式累 N+1 实证

**升档条件**：单节 8+ 幻象阈值触发 → r+ Meta 升格独立 feedback「应然 spec 幻象 cluster 集中爆发治理」候选 / r66 sweep 首次触达。

## r53+ §10 双 cluster 收官里程碑（2026-05-05 phase 481-492 单日 8 phase）

**双 cluster** = exec 通道（Cluster A）+ file 工具（Cluster B）。

**应然累积**（多 phase / 多 r / 多 thread）：
- r53+ phase403 立 §10.1-§10.7 7 节应然
- phase 444+456 sharpen DialogStore + spawn
- phase 474 sharpen edit + multi_edit + G1-G7 design-gap

**code 落地**：

| Cluster | design phase | code phase |
|---|---|---|
| A | 479（5 决策 / 7 锁定 + 1 推迟）| 481+482+483+485（4 phase 5 阶段最大形态）|
| B | 487（4 决策 / **8 锁定 0 推迟**）| 488+490+492（3 phase 4 阶段）|

**关键里程碑**：
- 5 月 5 日单日 6 小时 8 phase 落地
- ~70 文件 / ~1500-2000 行 net 改动
- 0 行为差（除 G3 时序合并 + G6 fully-read gate + G8 行为差接受）
- 1373+ tests PASS 全程

**模板新形态实证**：

1. **double cluster design+code 联动 5 阶段最大形态完整闭环模板第 2 实证** ← 推 r+ Meta 必硬化
2. **shared helper 抽出真共享 spec 判据**（backupToSync 4 source / 同 phase 461 DRY reflex 反例的反向）
3. **G8 实测核 reframe over-engineering 设计**（phase 488 浮出 / phase 487 G8 (a) ExecContext +allowedRoots 是 over-engineering / 实然 PermissionChecker 已立 / reframe 删异构 const）

---

## NEW 工具实施 G1-G5 锁定 18 原则推力 align verify（2026-05-05 phase 492）

**模板**：NEW 工具实施前 / design phase 列 G1-Gn 决策矩阵 / 每决策列对应原则推力 / 锁定后 code phase 严格按 G 实施 / 0 反悔。

**phase 487 G1-G5 phase 492 verify 落地**：

| G | 决策 | 原则推力 | phase 492 落地 |
|---|---|---|---|
| G1 (a) | profile = subagent + miner only | Philosophy P2+P3 + M#8 + D「分智能体」(4)| profiles.ts 仅 2 profile +EDIT/MULTI_EDIT |
| G2 (a) | frontmatter source = edit_backup | M#8 + D5 + 模板复用 (3) | sync-backup.ts 4 source 参 |
| G3 (c) | 全文回滚 + 失败 index + hint | D「恰好需要」+ P2 + D「决策主体」(3) | multi_edit.ts in-memory 顺序 + abort |
| G4 (a) | 0/多 match fail loud | D2 + D5 + D7 + M#10 (4) | edit/multi_edit countMatches + reject |
| G5 (b) | subagent 自治（不在工具实施层）| P3 + D 决策主体 + D 提供信息 + M#5 (4) | 工具不自动 escalation |

→ **5 决策 18 原则推力同向 align / 实施期 0 反悔 / 0 原则违反**。

**反模式**：

- ❌ 无原则推力的 G default（拍脑袋）
- ❌ 多原则推力相当时仍锁定（应推迟实测核）
- ❌ 实施期偏离 G 锁定（无 reframe 论证）

**与 phase 479 G1-G5 联动**：phase 479（Cluster A）+ phase 487（Cluster B）= 双 cluster G 决策模板 / 累 13 sub-decisions / 12 锁定 + 1 推迟（G2 verifier）。

---

## shared helper 抽出真共享 spec 判据（2026-05-05 phase 492 / 反 phase 461 DRY reflex 反例的反向）

**模板判据**（决定是否抽 shared utility）：

| 维度 | 抽 shared | inline |
|---|---|---|
| 真共享 spec？ | 各 caller 同 fs 写形态 / 同 frontmatter schema | 各 caller format 差异 |
| 独立可变职责？ | shared 形态变化时各 caller 同步变 | 各 caller 自治 format |
| DRY 真痛点？ | 多 caller 高频复用 + 形态稳定 | 巧合相似 / 形态不稳 |
| M#1 align？ | 抽出符合「独立可变职责」 | 抽出 = artificial coupling |

**phase 492 实证**：`backupToSync(ctx, filePath, source)` 4 source 共用：
- exec_overflow（phase 485）
- file_backup（phase 490）
- edit_backup（phase 492）
- multi_edit_backup（phase 492）

→ 真共享：4 source 同 fs 写形态 / 同 frontmatter schema / 仅 source 字段不同 / 抽 shared align M#1+M#7+M#8。

**反例**：phase 461 parseFrontmatter 抽 shared 是错治理（4 caller format 差异 / 巧合相似 / 抽出 artificial coupling / 反 DRY reflex）。

**判据互补**：
- phase 461 立判据「不该抽」反例
- phase 492 立判据「该抽」正例
- 累 1 反例 + 1 正例 = 完整判据 / 推 r+ Meta 升格独立 feedback「真共享 spec 判据模板」

---

## 模块内重构形态分类（phase 480-500 / Meta 35 硬化 + 2 r+ 实证累）

clawforum 模块内 sub-file 拆分累 **N=8 实证** / 4 形态完整 + A 形态 4 子分类完整 / **A.1 + A.3 子分类各 N=2 完整**。详 `feedback_module_internal_refactor_taxonomy` + `feedback_module_split_roi_audit_first`。

### 4 形态 + A 子分类 4 完整 / N=8 实证

| 形态 | Phase | 模块 | 性质 | 体量 | 净瘦 |
|---|---|---|---|---|---|
| **A.1 backend 服务** | 480 | contract/manager.ts | class field 5 / sub-concern 天然分离 | 1358→482 / 7 sub-module | 64% |
| **A.1 backend 服务 N=2** | **497** | **process-manager/manager.ts** | **class field 4 / 直 ctx 注入函数** | **574→76 / 8 sub-file** | **87%** |
| **A.2 CLI dispatch** | 486 | claw.ts | class field 0 / 8 command 真独立 | 932→24 / 9 sub-file | 97% |
| **A.3 functional** | 491 | step-executor.ts | 0 状态 / 全 functional / 最安全 | 630→100 / 6 sub-file | 84% |
| **A.3 functional N=2** | **500** | **foundation/config/index.ts** | **0 状态 / flat 4 域分** | **328→47 / 4 sub-file** | **86%** |
| **A.4 module-level state daemon** | 493 | watchdog.ts | process daemon / 模块级 mutable / ESM live binding | 581→210 / 6 sub-file | 64% |
| **B 保守式** | 484 | chat-viewport.ts | UI 状态机 / 闭包 25+ | 1296→995 / 5 sub-file | 23% |
| **C 极保守整理性** | 489 | runtime.ts | instance bag / pipeline 共享 | 924→835 / 2 sub-file | 9.6% |

### 起 phase 前 ROI 核纪律

3 判据任 1 命中 → 形态 C 极保守而非强套 A/B：
1. **method 共享判**：≥ 3 method 共享同一 pipeline / private helper
2. **class state 体量判**：class field ≥ 10 / 模块级 mutable state 多
3. **用户感知风险判**：影响核心业务 / 用户体感不可测（turn loop / UI 时序 / etc）

### 子模板（含在 taxonomy feedback）

- **子族 cohesive 保 1 file**（N=5 实证 / phase 480 acceptance + phase 486 claw-trace + phase 491 stream + tool-execution + phase 493 cron）
- **barrel re-export 保 caller 0 改**（N=5 实证 / phase 484 + 486 + 491 + 493 + 500 / phase 500 26 caller 0 改最多）
- **sub-module 拆分跨调用必经 ctx callback**（A.1 子模板 / phase 480 首发）
- **A.1 ctx 形态由 tests spy pattern 决定**（phase 480 callback wrap / phase 497 直 ctx 注入 / N=2）
- **ESM live binding for module-level state daemon**（A.4 子模板 / phase 493 首发）
- **A.3 适用范围扩**（phase 491 pipeline cohesive flow + phase 500 flat domain split）

### 累计成果（N=8）

6623 行老代码 → 2769 行（- 3854 行 / **净 58% 瘦身**）+ 47 sub-module / sub-file / 1403+ tests PASS / 0 行为差。

**净瘦比分布**：A.2（97%）> A.1+A.3（64-87%）> A.4（64%）> B（23%）> C（9.6%）/ 5 维判据准确预测。

## caller DIP enforce 治理（phase 414b-499 cluster N=4）

**触发**：caller type 用 Impl class（如 `LLMOrchestratorImpl` / `ToolRegistryImpl` / `AuditWriter`）= DIP violation / 无 M#1-M#5 强 violation / 但 M#7+M#8+M#9 align 可治理。

详见 memory `feedback_caller_dip_enforce.md`（治理模板 + scope 收紧推 r+1 + 体量阈值判据）。

**N=6 实证**：phase 414b ContractSystem + phase 498 LLMOrchestrator + phase 498 ToolRegistry + phase 499 AuditLog + phase 504 ExecContext + phase 504 IToolExecutor（合计 ~40 caller cascade / 0 行为差 / 0 tests 改 / 适用范围 large-cascade 23 caller → micro-hygiene 1 caller 全频段）。

**模板要点**：
- factory 函数返 type 改 Impl → Interface
- caller `: Impl` → `: Interface` cascade
- Impl class 仍 export from barrel（备 tests white-box）
- tests 0 改（`let x: ImplName` + `new ImplName()` 仍合规 / class 仍 export）

**scope 收紧推 r+1**：体量 ≥ 30 caller 推 r+1 phase 启动（phase 498→499 闭环 = N=2 实证）。

**28 条原则核审纪律**（phase 提案配套）：详见 memory `feedback_principle_audit_phase_proposal.md` / 用户用 Philosophy 4 + Design 11 + Module Logic 11 核审 / 触发 M#10+M#11「停下来讨论模块重构」/ 决策判据 violation 数分级。

---

## 业务决策性 design-gap → 原则 derive 自决（2026-05-07 phase 520+521 cluster / 2 实证累）

**触发场景**：interfaces/*.md §Design-gap 段标「业务决策性 / 用户拍板候选」+ 主会话标「猜偏好倾向」/ 但实然原则 cross-check 可导出唯一决策。

**模板 4 步**：

1. **主会话用 Philosophy + Design Principles + Module Logic Principles cross-check 核每候选**：
   - 列每候选 4 项原则评分（满足 / 反对 / 中立）
   - 反 over-engineering（同 phase 458 STALE 推翻判据 / 1 impl + 0 ROI 反对）
   - 推翻原标 (a)/(b)/(c) 中**不 align 多原则**的候选
2. **修订倾向**：从「猜偏好」改「原则 derive 单选」/ 含决策 + 主原则 + 反对论据
3. **用户拍板 binary**：(a) 接受原则 derive / (b) override（如有非原则考量 / 用户业务直觉）
4. **配套 r+1 code phase 落地**：design closure 后 / r+1 code phase 实施 src align（dead intent cluster 顺手清 + new feature 落地）

**实证（2 累）**：

| Cluster | Design closure | Src 落地 |
|---|---|---|
| L2c SkillSystem G1+G2 | ε（spec 修正 + framing 推翻 + dead intent 群体浮出）| phase 520（dead intent cluster 顺手清 / 5 类复合形态：field+class+union+pass+audit-phantom）|
| L5 Runtime G1-G4 | 原则 derive (a)(a)(a)(a) 全 (a) / G2 反 over-engineering | phase 521（regime 切换协调实施 / RuntimeOptions+regimeSwitchStrategy + RuntimeDependencies+dialogStoreFactory + lastSystemPrompt field + _performRegimeSwitch + extractLastTurn + audit regime_switch event）|

**反模式**：
- ❌ 主会话用「猜偏好」标主会话倾向 / 不用原则 cross-check（猜偏好可能与原则相反 / 如 G2 主会话原标 (c) 混合 / 原则 derive 推翻为 (a) 枚举）
- ❌ 用户拍板 (a)(b)(c) 多选交互式 / 应让原则 derive 唯一答 / 用户仅 binary 拍板
- ❌ design closure 后不配套 r+1 code phase 落地（应然 sharp / 实然不变 = 应然幻象 cluster 累）

**正确模式**：
- ✓ 主会话用原则 cross-check 推翻猜偏好 / 自降 framing 推翻 (b)/(c) 候选
- ✓ G2 反 over-engineering 模板（callback 1 impl + 0 ROI = STALE 候选 / 反对 / 同 phase 458）
- ✓ design closure 后立即 r+1 code phase 配套实施

**升格信号**：2 实证累达升格阈值 / 推 r+ Meta 必硬化独立 feedback 配套实施模板。

立项：2026-05-07 / phase 520+521 cluster（L2c.G1+G2 + L5.G1-G4 设计议题 closure + src 落地）。

---

## design+code 联动 4 阶段模板（2026-05-07 phase 457+466+ε+521 首发）

**vs 现有联动模板**：
- 2 阶段（design + code 同 phase）：phase 373→377 / phase 395→396
- 3 阶段（design + code α + code β）：phase 444+450+453（首次完整 / r62 起立）
- **4 阶段（design 重审 + L2 前置 + design closure 重审 + code β 落地）**：phase 457 + 466 + ε + 521（首发 / 本 cluster）
- 5 阶段：phase 479+481+482+483+485（NEW 基础设施 / r53+ Cluster A+B 单日完成 / 已立 5 阶段最大形态）

**4 阶段独特性**：

| 阶段 | 工作 | Phase | 时间 |
|---|---|---|---|
| 1. design 重审 sharpen | 应然立场首次明确（如「1 instance = 1 system prompt regime」）| phase 457 | 2026-05-03 |
| 2. code α / L2 前置 | 底层支撑（DialogStore ctor +systemPrompt + restorePrefix）| phase 466 | 2026-05-04 |
| 3. **design closure 重审** | 4 design-gap 用 Philosophy + Design + Module Logic 原则 derive closed（不靠猜偏好）| ε | 2026-05-07 |
| 4. code β 落地 | 上层 caller 配套实施（Runtime regime 切换协调）| phase 521 | 2026-05-07 |

**新阶段**：阶段 3「design closure 重审」是 3 阶段模板没有的 / 是「业务决策性 design-gap → 原则 derive 自决」配套环节。

**触发场景**：design 立 phase 后含「业务决策性 design-gap」段 / 用户当时未补 / 经几个月跨 phase / 需 code 落地前补 closure。

立项：2026-05-07 / phase 457→466→ε→521 cluster（应然 phase 457「1 instance = 1 system prompt regime」立场首次 src 实证 / 跨 4 天 4 phase）。

升格条件：≥ 2 实证累 / 推累至 r+1 cluster 实证后升格独立 feedback。

---

## ε decision 形态（spec 修正 + framing 推翻 + dead intent 复合）

**触发场景**：interfaces/*.md §Design-gap 段「业务决策性 design-gap」**实然 Path #1 实测核浮出**应然 spec 与实然 0 align（不是用户业务决策 / 是 spec stale）。

**实证 phase 520（L2c.G1+G2 closure）**：

| 候选 | 主会话原标 | 实然真状态 | ε 修订 |
|---|---|---|---|
| L2c.G1 上下文摘要归属 | (a)/(b)/(c) | `SkillSystem.formatForContext()` 实然存在 / 3 caller 真用 / interfaces 0 暴露 stale | spec 修正：interfaces 加 method 暴露 / arch 不动 |
| L2c.G2 reload 触发 rescan | (a)/(b)/(c) | retro skill 实然走 per-execution lazy load 模式 / EvolutionSystem.skillRegistry field 0 真调用 / 'reload_failed' code 0 用 / 2 audit events 0 真写 | framing 推翻 + dead intent cluster 顺手清（5 类复合：field+class+union+pass+audit-phantom）|

**模板 3 步**：

1. Path #1 实测核：grep 全集 verify 应然描述 vs 实然落地（4 维度：method exists / type ref / instance use / call sites）
2. ε 修订（spec 修正 / framing 推翻 / dead intent cluster 浮出 / 复合形态）
3. r+1 code phase 顺手清（同 phase 426 ContractManager.retroScheduler dead field 模板 + phase 504 micro-hygiene 复合）

**反模式**：
- ❌ 假设「业务决策性」= 用户必须拍板 / 跳过 Path #1 实测
- ❌ 选 (a)/(b)/(c) 标候选答 / 不挖实然真状态
- ❌ design closure 后留 dead intent 不清

**正确模式**：
- ✓ 「业务决策性 design-gap」前置先 Path #1 实测核 / 浮出应然 phantom 后 ε 修订
- ✓ dead intent cluster（field + class + union + pass + audit-phantom 5 类复合）形态识别
- ✓ r+1 code phase 顺手清（不留应然幻象 / 同 phase 426 dead field + phase 458 STALE 推翻模板）

立项：2026-05-07 / phase 520（L2c.G1+G2 closure ε + EvolutionSystem dead intent cluster 顺手清）。

---

## 「silent X」类问题 sweep 模板（chat-viewport phase 523 实证）

**触发场景**：UI / observability 维度 sweep / 同根「silent X」类 hidden bugs / 共同根因 = D1b 状态可观察 + D2 不丢弃 缺失。

**3 类形态**（phase 523 chat-viewport 一次 sweep 浮出）：

| 形态 | 描述 | 修复模式 |
|---|---|---|
| **silent crash** | 内部 fs/network 失败 → 异常 bubble → uncaughtException → 用户感知突然崩 | try/catch + 红色 inline error UX（**D2 不丢弃 + D1b 状态可观察**）|
| **silent drift** | switch/case 0 default / 未识别新类型 silent skip / 未来加新 type 不知道 | default case + audit event + console.warn dev-only（**observability + 防 future drift**）|
| **silent UI** | 错误反馈与 hint 同色（dim 等弱色）/ 用户错过 | align error 颜色约定（既有 turn_error `\x1b[31m` 红）/ 强反馈 |

**sweep checklist**（UI 模块系统 sweep）：

1. **写 IO 路径**：每个 fs.write / network.send / sync 调用是否有 try/catch + UX feedback?
2. **switch/case dispatcher**：是否有 default case / 未识别 input 是否 audit + log?
3. **用户错误反馈颜色**：error / warning / hint 颜色是否 align 全局约定（不与 dim hint 同色）?
4. **timeout / async 路径**：长时间无响应是否给 spinner / 状态提示?

**同根判据**：以上多个 silent X 共享根因 = **observability + UX feedback 缺失** / 应同一 phase 多 step 治理（不分散到多 phase / 性价比低）。

**立项**：2026-05-07 / phase 523（chat-viewport UX 加固 cluster A+B+C / 单 phase 3 step）。

升格条件：≥ 3 个 silent X 类 sweep cluster 实证 / 推升格独立 feedback。

---

## 同根 micro-hygiene cluster 单 phase 多 step 模式（phase 504+520+523 / 3 实证）

**触发场景**：同模块多个独立但同根 micro-hygiene fix / 各 ≤ 5 行 / 拆多 phase 性价比低（单 commit 原子优于多 commit）。

**模板**：
- 单 phase 总览（micro-hygiene 形态 / scope ≤ 50 行）
- N 个 step 独立文件 / 每 step 7 节硬结构 + 反向 3 项（per `feedback_step_plan_format_7section`）
- 单 commit 原子（per `feedback_pr_one_commit_rule`）
- 主会话 Step C 一次同步 + memory 1 次登记

**3 实证**：

| Phase | 同根 cluster | scope | step |
|---|---|---|---|
| 504 | DIP enforce hygiene | ~6 行 | ExecContextImpl→ExecContext + ToolExecutorImpl→IToolExecutor |
| 520 | dead intent cluster | ~13 行 net delete | field+class+union+pass+audit-phantom 5 类复合 |
| **523** | **chat-viewport silent X** | **~17 行** | **A error handling + B silent drift + C 颜色** |

**vs 拆多 phase**：

| 维度 | 单 phase 多 step | 拆多 phase |
|---|---|---|
| 用户实施 commit 数 | 1 | N |
| 主会话 Step C cycle | 1 | N |
| 计划文件数 | 1 总览 + N step | N × 4-5 file |
| 同根性 | 显式表达 | 隐含 |
| 原子性 | ✓ 单 commit | ✗ 多 commit revert 复杂 |

**反模式**：
- ❌ 同根 micro-hygiene 强拆多 phase（同 phase 521 拆 4 阶段是真异质 / 与本模板无冲突）
- ❌ 单 phase scope > 50 行（应升档为正常 phase / 有 NEW feature 时拆）

**升档条件**：scope > 50 行 / 引入新 module / 跨模块 cascade 复杂 → 拆多 phase。

**立项**：2026-05-07 / phase 523（chat-viewport silent X cluster / 第 3 实证累达升格阈值）。

---

## 同时钟域时间断言（phase 638 / fs watcher 驱动 e2e 测试 flaky 治理）

**触发**：`tests/e2e/chat-viewport-regression.test.ts` 基线 6「Spinner 计时」flaky / `Math.abs(elapsedExec - expectedExec) <= TOLERANCE_MS=100` 实测 293 / 根因 = 跨时钟域比较。

**反例（跨时钟域 / 100ms 魔法数字容差）**：

```ts
const tStart = Date.now();                       // 测试线程 wall clock A
await appendStreamEvent(fx, { type: 'tool_call' });   // fs write
await waitForEvents(fx, 4);                       // 等 watcher deliver
await new Promise(r => setTimeout(r, 100));
const tEnd = Date.now();                         // 测试线程 wall clock B
await appendStreamEvent(fx, { type: 'tool_result' });
await waitForEvents(fx, 5);

const elapsed = readSpinnerElapsedFromAudit();   // viewport callback 内 clock
const expected = tEnd - tStart;
expect(Math.abs(elapsed - expected)).toBeLessThanOrEqual(100);  // ❌
```

| 量 | 域 | 含 latency |
|---|---|---|
| `expected = tEnd - tStart` | 测试线程 wall clock（appendStreamEvent **之前**打点） | watcher_latency_4 + 100ms sleep + appendFile_overhead_5 |
| `elapsed = stopAt - startAt` | viewport callback 内 spinner 时钟（watcher delivered 之后启停） | watcher_latency_5 - watcher_latency_4 漂移 |

→ 100ms 容差吸收的是 macOS FSEvents 不对称 latency（coalescing 50-200ms）/ chokidar 批合并 / GC pause / 调度抖动 — 这些都不是 spinner 物理误差 / 是 OS 层不可控噪声 / 是魔法数字。

**真合规（同时钟域 / sub-ms 结构上恒等）**：

```ts
// fixture 内 reader callback 顶部打点
const deliveryTimestamps: Array<{ type: string; ts: number }> = [];
const reader = createStreamReader(
  fs, STREAM_FILE,
  (ev) => {
    deliveryTimestamps.push({ type: ev.type, ts: Date.now() });  // ← 同 callback 顶部同步
    receivedEvents.push(ev);
    handleEventShim(ev, mainUI, observability);                   // ← spinner.startedAt = Date.now()
  },
  ...,
);

const tcStart = fx.deliveryTimestamps.find(d => d.type === 'tool_call')!.ts;
const tcEnd = fx.deliveryTimestamps.find(d => d.type === 'tool_result')!.ts;
const expected = tcEnd - tcStart;
const elapsed = readSpinnerElapsedFromAudit();
expect(Math.abs(elapsed - expected)).toBeLessThanOrEqual(1);  // ✓ Date.now ms 离散精度物理事实
```

**结构上恒等保证**：

- `deliveryTimestamps[i].ts = Date.now()` 在 callback 起头同步执行
- spinner 内 `startedAt = Date.now()` / `elapsed = Date.now() - startedAt` 在同 callback 内同步调
- 两个 `Date.now()` 之间隔 = 同 event loop tick 内 1 push + 1 同步函数调用 = sub-ms（< 0.1ms 通常）
- → `elapsed === (deliveryTimestamps[end].ts - deliveryTimestamps[start].ts)` 在 ms 精度上**结构上恒等**（不是经验上接近 / 是单线程 JS event loop 同步顺序保证）

**容差物理事实 vs 魔法数字判据**：

| 容差量 | 来源 | 性质 |
|---|---|---|
| 0 ms | 同 Date.now() 调用 | 物理 / 完美 |
| ≤ 1 ms | Date.now() ms 离散精度（跨 ms 边界 ±1）| 物理 / 不依赖 OS / GC / watcher |
| 2-5 ms | 同步函数调用栈深度 + GC minor pause | 边界 / 单实证可接受 |
| > 10 ms | 异步 / 跨 callback / 跨 event loop tick | **必跨时钟域 / 必魔法数字 / 必重写为同时钟域** |
| ≥ 100 ms | OS-level 抖动（fs watcher / 调度 / 跨进程）| **绝对魔法数字 / 吸收的是不可控 latency / 测试目的污染** |

**判据**：容差 > 单线程同步顺序保证的 sub-ms 噪声 → 必是跨时钟域 → 必是魔法数字 → 必重写为同时钟域（不是放宽容差）。

**反模式**：

- ❌ 用测试线程 wall clock 打点 `tStart = Date.now(); ...await fs/watcher cycle...; tEnd = Date.now();` / 与 viewport callback 内 actual 比
- ❌ 用 100ms 容差「吸收 fs watcher 抖动」 / 实然吸收的是不对称 latency / 不是 expected/actual 物理误差
- ❌ flaky 归因「时间敏感 / CPU 调度」 / 不诊断时钟域 / 直接增大容差
- ❌ 「容差越大越鲁棒」/ 实然容差大 = 测试目的弱（per `feedback_test_purpose` 测试碰巧通过 vs 测试对缺陷敏感）
- ❌ 跨时钟域 + tiny 容差 → 偶发绿（latency 凑巧对称）/ 偶发 red（latency 不对称）/ 是 flaky 经典

**正确模式**：

- ✓ 测试 fixture 内 callback 顶部 push 打点（与 viewport 内部时间测量同 event loop tick）
- ✓ expected = 同源 push 时间 delta / actual = 同 callback 内函数时间 delta
- ✓ 容差仅吸收 Date.now ms 离散精度（≤ 1ms / 物理）/ 不吸收实现 latency
- ✓ flaky 诊断必先核时钟域 / 比较 expected/actual 测量点是否同 event loop tick / 同 callback / 同 process
- ✓ 单元测试用 fake timers / e2e fs watcher 驱动用同 callback 打点 / 不混用

**触发判据**（重写而非放宽容差）：

测试 flaky 时若：

1. expected 在测试主线程打点（`Date.now()` 在 `await ... fs / watcher ...` 之前/之后）
2. actual 在被测系统内部 callback 打点（spinner / counter / handler 内 `Date.now()`）
3. 两者之间存在 **fs watcher / chokidar / FSEvents / inotify / 跨 event loop tick** 的 latency 路径

→ 100% 跨时钟域 / 容差不应吸收 / 必重写：

- 在 fixture 内 reader / handler callback 顶部 push 打点 deliveryTimestamps
- expected 改用 deliveryTimestamps delta（同 actual 时钟域）
- 容差降至 ≤ 1ms（Date.now 物理精度）

**同型场景累候选**：

- 任何 fs watcher / chokidar 驱动 e2e 测试的时间断言
- cron / scheduler 触发频率断言（cron tick clock vs 测试 wall clock）
- 跨进程 audit.tsv timestamp 对账（同 phase 454 cross-layer-up Runtime 解读 daemon audit 同字符串契约模式 / 字符串契约可同 / 但时间断言不能跨进程比）

**实证**：

- phase 638 / `tests/e2e/chat-viewport-regression.test.ts` 基线 6 + 基线 1 同根 2 处改 / 删 `TOLERANCE_MS = 100` 魔法数字 / 改 deliveryTimestamps 同时钟域 / 0~1ms 容差 / 反向 3/3 PASS / main `f6bb0827`

**升格信号**：单实证立项 / 推 ≥ 2 实证升格独立 feedback / 当前 `feedback_same_clock_domain_test_assertion`（B 类 / 单实证待累）+ 同根 `feedback_test_purpose` / `feedback_test_fixture_fidelity` / 维度补充。

---

## watcher SLO 跨平台分档（phase 644 / fs notification 测试 SLO 设计）

**触发**：`tests/foundation/stream-reader.test.ts:154-168` SLO 测试 `expect(elapsed).toBeLessThan(50)` 在 macOS flaky / 50ms < FSEvents coalescing 50-200ms 物理下界。

### 与 phase 638 同时钟域纪律 cluster 区分（关键）

phase 638 与 phase 644 同属「测试时序断言治理」cluster / 但 anti-pattern 本质不同：

| 维度 | phase 638（同时钟域纪律） | phase 644（watcher SLO 分档）|
|---|---|---|
| anti-pattern 本质 | 跨时钟域错配 + 容差吸收 watcher 噪声 | SLO 设计本身不现实 / < 物理下界 |
| 测试 expected 测量域 | 测试线程 wall clock（错配 / 应同步消除）| 测试线程 wall clock（**正确** / SLO check 本就要跨域比）|
| 50/100ms 数字性质 | 容差吸收噪声（魔法数字） | **SLO budget**（与物理下界 align）|
| 修法 | 同时钟域 deliveryTimestamps 消除跨域 | 跨平台 SLO 分档 / 反映物理下界 |
| 跨域是否合理 | 不合理（错配）| 合理（SLO check 本就要跨域）|

→ 诊断时序断言 flaky 必先核：是 (a) 错配 cross-clock-domain（→ phase 638 同时钟域）还是 (b) SLO 不现实（→ phase 644 跨平台分档）。

### 反例（单一 SLO 跨平台 / 50ms）

```ts
const sentAt = Date.now();
writer.write({ ts: sentAt, type: 'latency_probe' });
await waitFor(() => events.length === 1);
const receivedAt = (events[0] as any)._receivedAt;
const elapsed = receivedAt - sentAt;
expect(elapsed).toBeLessThan(50);  // ❌ macOS FSEvents 50-200ms 物理下界 / 必 flaky
```

50ms 在 macOS 必 flaky / 在 Linux+Windows 通过。**单一数字跨平台 SLO 必 flaky 在最慢平台**。

### 真合规（跨平台分档）

```ts
// macOS FSEvents coalescing 50-200ms 物理下界 / Linux inotify + Windows RDC < 20ms
const SLO_MS = process.platform === 'darwin' ? 250 : 50;
expect(elapsed).toBeLessThan(SLO_MS);
```

每档与 OS watcher backend latency align / 不是任意魔法数字：

- 250 = 200（FSEvents 上界）+ 50（CPU/GC 余量）
- 50 = 5（inotify 典型）+ 45（CPU/GC + chokidar 处理）

### 物理下界数据

| 平台 | watcher backend | 物理 latency 典型 | 推荐 SLO | 余量 |
|---|---|---|---|---|
| macOS | FSEvents | 50-200ms（kernel coalescing）| 250ms | +50 |
| Linux | inotify | < 5ms（事件直 readv）| 50ms | +45 |
| Windows | ReadDirectoryChangesW | < 20ms | 50ms | +30 |
| 任意 / chokidar polling fallback | setInterval | 100ms+ | 250ms+ | OS-level 抖动 |

**数据来源**：macOS FSEvents Apple Doc / Linux inotify(7) Man Page / chokidar README + Issues 历史报告。

### 4 选项决策矩阵

| 选项 | 形态 | 优劣 |
|---|---|---|
| **a** | 跨平台 SLO 分档：macOS 250ms / Linux+Windows 50ms | ✓ 反映物理下界 / ✗ test 含 platform branch / 三档但与物理 align |
| **b** | 统计 SLO：10x 跑 / 取 p95 < 200ms | ✓ 吸收单次抖动 / ✓ 反映用户体验 / ✗ 测试时长 ×10 |
| **c** | 跨平台统一宽 SLO：< 250ms | ✓ 简单 / ✗ Linux 浪费精度 / ✗ 失 perf regression 信号 |
| **d** | reframe 为 ordering / delivery confirmation：删 SLO / 仅 `await waitFor()` 证明 delivery | ✓ 0 魔法数字 / ✓ 0 flaky / ✗ 不再测 latency / SLO 测试目的丢 |

**推荐**：**a**（最 balance / 测试目的保 + flaky 消 + 物理 align）。

### 反模式

- ❌ 单一数字跨平台 SLO（必 flaky 在最慢平台）
- ❌ 把 watcher latency 当成「时间敏感 / CPU 调度」抖动 / 不诊断 OS-level 物理下界
- ❌ flaky 时直接放宽 SLO（如 50 → 100）/ 不分平台 / 不基于实测分布
- ❌ SLO 测试名字明示 latency / 但 reframe 为 ordering（语义不一致）
- ❌ macOS-only 跑 + Linux SLO 50ms 未实测验证 / 假设跨平台

### 正确模式

- ✓ 测试名明示「platform-arched SLO」或 SLO 数字（reader 读懂跨平台差异）
- ✓ SLO 数字 = 物理下界 + 余量（CPU/GC + chokidar 处理）
- ✓ 跨平台 CI 覆盖（macOS + Linux 至少各 1 / Windows 可选）
- ✓ flaky 诊断必先核 OS watcher backend / 物理下界 / 不归因「时间敏感」
- ✓ SLO 数字调整必基于实测分布（不是猜测 / 不是 +50 +50 加上去）

### 触发判据（SLO 修法 vs 同时钟域修法）

测试 flaky 时按二元决策树：

1. **expected 与 actual 是否本应同步？**
   - 是 → phase 638 同时钟域错配 / 修法 = 同时钟域 deliveryTimestamps
   - 否（cross-clock 是 test point）→ 进 2

2. **SLO 数字是否反映物理下界？**
   - 否（< 物理下界 / 跨平台单一）→ phase 644 跨平台分档
   - 是 → 累抖动数据 / 评估 SLO 调整或 reframe ordering

### 同型场景累候选

- 任何 fs watcher / chokidar 驱动 e2e 测试的 SLO assertion
- inotify / FSEvents / RDC 直接驱动测试
- 跨平台 CI 测试中 timing budget 设计

### 实证

- **phase 644**（2026-05-10）：`tests/foundation/stream-reader.test.ts:154-168` SLO 跨平台分档（用户决策选项 a-d / 默认推 a）/ Step B 主会话立即实施 design + memory / Step A 用户实施 code

### 升格信号

- 单实证立项 / 推 ≥ 2 实证升格独立 active feedback
- 与 phase 638 同 cluster「测试时序断言治理」/ 累 2 子形态（错配 + SLO 不现实）
- 推 r+ ≥ 3 子形态再立元 cluster feedback「时序断言修法决策树」（含同时钟域 / SLO 分档 / mock 冗余 / reframe ordering 等）

---

## 冗余 timing assertion 删除优先（phase 644 / timing magic number 决策树）

**触发**：phase 644 5 sub-fix cluster / 用户深核「一定要有魔法数字吗」/ 主会话 reframe option e（DELETE）/ 形成「测试时序断言治理 cluster」3 子形态决策树。

### 决策树（timing magic number 浮出时按二元决策）

```
1. 信号是否被同 it 块的结构 assertion 覆盖？
   ├── 是 → DELETE timing assertion（0 魔法数字）
   └── 否 → 进 2

2. broken case 是否被 vitest testTimeout / waitFor 上界覆盖？
   ├── 是 → DELETE timing assertion（broken 经 timeout 暴露）
   └── 否 → 进 3

3. 真需 SLO 跟踪？
   ├── 是 → 立专 perf suite（不混 unit test）+ 跨平台 SLO 分档（详上节）
   └── 否 → reframe ordering / 删整 it 块
```

**优先级**：DELETE > SLO 分档 > 容差放宽（容差放宽是反模式）。

### 与既立两 feedback 关系

| feedback | 子形态 | 优先级 |
|---|---|---|
| `feedback_same_clock_domain_test_assertion`（phase 638）| cross-clock 错配 / 容差吸收 watcher 噪声 | 诊断「跨域错配」时 |
| `feedback_watcher_slo_test_platform_arched`（phase 644 退路）| SLO 设计 < 物理下界 | 真需 SLO 跟踪时退路 |
| **`feedback_redundant_timing_assertion_delete`**（phase 644 主）| 冗余 timing / 信号已覆盖 | **timing magic number 浮出时优先级最高** |

→ 形成 cluster N=3 子形态 / 推 r+ Meta 立元 cluster feedback「时序断言修法决策树」。

### phase 644 5 sub-fix cluster（DELETE 实证）

| sub-fix | 文件 | 信号覆盖来源 | 删除内容 |
|---|---|---|---|
| A.1 | stream-reader.test.ts:154-168 | line 59 `should receive new events after start` | 删整 it 块 |
| A.2 | process-exec.test.ts:175-178 | `expect((err).killed).toBe(true)` + vitest 15s | 删 timing 4 行 |
| A.3 | llm.test.ts:562-569 | mocked / `toHaveBeenCalledTimes(4)` | 删 timing 4 行 |
| A.4 | llm-service.test.ts:778-787 | retryDelayMs=10000 × 3 > vitest 15s | 删 timing 3 行 |
| A.5 | llm-service.test.ts:808-817 | 同 A.4 | 删 timing 3 行 |

### 反模式

- ❌ timing magic number 浮出时直接放宽（50 → 100 → 1000）/ 不核信号冗余
- ❌ 「保留 timing assertion 增加覆盖」/ 实然冗余 + magic + flaky 风险
- ❌ 把 SLO 测试塞 unit test suite / 单次 binary pass/fail 不构成 SLO 监测
- ❌ flaky 时 reframe 为 SLO 跨平台分档（前节 option a）而不先核「能否 DELETE」
- ❌ 删 timing 同时删 structural assertion（信号丢）

### 正确模式

- ✓ 浮 magic number 即跑决策树
- ✓ 优先 DELETE / 退路 SLO 分档
- ✓ DELETE 时保留 structural assertion / 不删核心信号
- ✓ broken case 经 vitest testTimeout / waitFor 暴露 / 接受 failure mode 改变
- ✓ 真需 SLO 跟踪 → 立专 perf suite（vitest --reporter=json + CI perf job + 历史 dashboard）

### 「真需 SLO 跟踪」判据（决策树第 3 步）

立专 perf suite 的判据（满足全 4 项才立）：

1. SLO 数字基于物理下界 + 余量（不是拍板）
2. 历史趋势数据可积累（CI 跑 + dashboard）
3. regression 触发 alert 而非 binary fail
4. 跨平台分档（macOS / Linux / Windows 各档）

→ unit test suite 满足 0/4 / 必须立专 perf suite / 否则 DELETE。

### 触发判据

每次写 timing assertion / 见到含 magic number 的 timing assertion 时优先跑决策树 / **DELETE 优先 / SLO 分档退路 / 容差放宽是反模式**。

---

## config defaults single-source-of-truth（phase 647 / 魔法数字治理 cluster 第 4 子形态）

**触发**：phase 644 收尾后用户「继续查魔法数字问题 / 还挺多」/ 主会话 fan-out 3 sub-agent 全扫 / 浮 100+ 候选 / 优先级最高 = config defaults cross-file 重复 / Path #1 spot-check 浮 1 真 value drift bug（init.ts:313 `llm_idle_timeout_ms: 120000` ≠ schemas.ts:55 default(60000) ≠ constants.ts:52 60000）。

### 反例（phase 647 实证 / 真 value drift）

```ts
// src/constants.ts:52
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60000;

// src/foundation/config/schemas.ts:55
llm_idle_timeout_ms: z.number().min(0).max(600000).default(60000)  // 重复 inline

// src/cli/commands/init.ts:313
llm_idle_timeout_ms: 120000  // ⚠ DRIFT! 与 constants/schema 不一致

// src/core/runtime/runtime.ts:115
toolTimeoutMs: 60000  // 重复 inline (different field but same value)
```

3 个相关位置 / 3 种值（60000 + 60000 + 120000）/ **真 drift bug**（编译期不暴露 / Path #1 实测才浮）。

### 真合规模板（单向 import 流）

```
src/constants.ts  ← single source of truth
       │
       ├─→ src/foundation/config/schemas.ts (zod defaults)
       ├─→ src/cli/commands/init.ts (emit user config)
       ├─→ src/cli/commands/config.ts (re-config)
       └─→ src/core/runtime/runtime.ts (ctor default)
```

一处改 const → 全部同步 / 0 drift 风险。

### 双默认场景（init vs runtime）

某些配置有「init 时写入用户 config」与「runtime 解析时若 config 缺失」**两个不同语义的默认值** / 这是合法需求 / 但需**显式区分命名**（不是 inline 不同数字隐式 drift）：

```ts
/** Schema fallback when user config 不写（runtime parse default） */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60000;

/** Initial value written to user config by `init` command (more lenient for new users) */
export const INIT_LLM_IDLE_TIMEOUT_MS = 120000;
```

### 决策树（cross-file inline 默认值浮出时）

```
1. 同一字段在 ≥ 2 个 file 出现 inline 数字字面量？
   ├── 是 → 进 2
   └── 否 → 单点 inline 可接受（但仍可 extract 提升 readability）

2. 多处值是否一致？
   ├── 一致 → extract to const / single source / 防未来 drift
   └── 不一致 → drift bug！进 3

3. 不一致是 (a) bug 还是 (b) 不同语义？
   ├── (a) bug → align 至 source of truth + extract const
   └── (b) 不同语义 → 显式命名区分（如 DEFAULT_X vs INIT_X）+ 各 extract const
```

### 与 phase 638/644 cluster 区分（关键）

phase 638/644/647 同属「魔法数字治理 cluster」N=4 子形态：

| Phase | 子形态 | feedback | domain |
|---|---|---|---|
| 638 | cross-clock 错配 + 容差吸收 watcher 噪声 | `feedback_same_clock_domain_test_assertion` | 测试时序断言 |
| 644 sub-A | SLO 设计 < 物理下界 | `feedback_watcher_slo_test_platform_arched`（退路）| 测试 SLO budget |
| 644 sub-B | 冗余 timing / 信号已覆盖 | `feedback_redundant_timing_assertion_delete`（主）| 测试时序断言 |
| **647**（本）| **prod 配置默认 cross-file 重复** | `feedback_config_defaults_single_source` | **prod code 配置** |

→ 诊断魔法数字浮出时按 domain 分类：是测试时序（→ 638/644 决策树）还是 prod 配置（→ 647 单源化决策树）/ 不同 domain 不同治理路径。

### 反模式

- ❌ schema default inline 重复 constants.ts 已存在的值
- ❌ 不同 file 同字段写不同值（隐式 drift / 编译期不暴露）
- ❌ 「数字小于 5 字符 / 没必要 extract const」（drift 风险与字符数无关）
- ❌ 双默认场景用同一 inline 数字（应显式命名区分）
- ❌ extract const 后忘记 import / inline 数字保留（半 done）
- ❌ 把 schemas.ts zod range bounds（`.min(1000) .max(600000)`）当 magic（这是验证范围 / 不是 default）

### 正确模式

- ✓ 配置默认值有专 const 文件（clawforum 已有 src/constants.ts）
- ✓ schemas.ts zod default 经 const 引用
- ✓ 所有 caller import 同 const（init / config / runtime / 等）
- ✓ 双默认场景显式命名（DEFAULT_X vs INIT_X）
- ✓ 单源化时 grep 验收：`grep -nE "(?<![a-zA-Z_])60000" src/` 只命中 constants.ts 自身定义
- ✓ 加新配置优先 add to constants.ts / 不 inline

### 升格信号

- phase 647 单实证立项 / 推 ≥ 2 实证升格 active
- 「魔法数字治理 cluster」N=4 子形态 / 推 r+ Meta 立元 cluster feedback「魔法数字治理决策树」（含测试时序 + prod 配置 + 文档 justification 等子形态）

### 触发条件

每次新增配置默认值或修改既有默认值时落本规范。**新加 const 优先 constants.ts / 不 inline / cross-file caller 全 import / 双默认场景显式命名区分**。

### file-local sub-form（phase 651 实证 / 单 file 多 site inline magic）

phase 647 处理「cross-file 重复」/ phase 651 处理「single-file inline magic」/ 同 cluster 不同子形态。

**case study**（phase 651 sweep 3 file 10 sites）：

- `chat-viewport.ts` 4 inline interval/timeout（5000/2000/1000/3000ms）→ 4 file-local const（与既有 TASK_*_MS 模板一致）
- `daemon-loop.ts` 3 inline poll/threshold（200ms/20/5）→ 3 file-local const
- `random-dream.ts` 2 (3) inline subagent params（3600*1000/200/3_600_000）→ opts 字段 + default const（mirror deep-dream maxCompressionTokens 模式）

**决策树扩展**（cross-file vs file-local 分支）：

```
1. magic number 用在 ≥ 2 个 file 同字段？
   ├── 一致 → constants.ts 单源化（phase 647 模板）
   └── 不一致 → drift bug + 单源化（phase 647 实证）

2. magic number 用在单 file 多 site？
   ├── 是 → file-local const 提顶部（phase 651 模板）

3. magic number 用在单 file 单 site？
   ├── 与 peer module 同概念 → mirror peer's opts pattern（如 random-dream mirror deep-dream）
   └── 独立 → file-local const（仍提 readability）
```

**file-local 命名一致性**：

- 同 file 既有 const 模板 → 复用风格（如 chat-viewport.ts:559-560 TASK_*_MS）
- 后缀 _MS / _COUNT / _BYTES / etc 反映单位
- 集中 file 顶部 / import block 后 / interface/function 前

**反模式扩展**：

- ❌ inline 字面量在单 file 多 site 重复（应 file-local const）
- ❌ 跨 peer module 同概念用不同 default 值（应 mirror peer opts pattern）
- ❌ file-local const 散在函数内部（应集中文件顶部）

**正确模式扩展**：

- ✓ file 顶部集中 const block / 与既有 const 同位置
- ✓ peer module 同概念 mirror opts pattern（不重复 inline）
- ✓ caller 0 override 时仍加 opts 字段（backward-compat / 0 行为差 / 为未来 user config 驱动准备）

### named-but-arbitrary justification（phase 654 实证 / 给名字一个意义）

phase 647 / 651 处理「给数字一个名字」（structural extract）/ phase 654 处理「给名字一个意义」（comment justification）。

**3 状态分类**：

| 状态 | 示例 | 治理 |
|---|---|---|
| inline 无名 | `, 5000)` | extract to const（phase 647/651 模板）|
| named 有概念 comment / 缺 value justification | `const FALLBACK_CONSECUTIVE_FAIL_LIMIT = 5;`（概念 comment 已有 / 但「为什么是 5」缺）| 加 value justification comment |
| named 完全无 comment | `const DEFAULT_FALLBACK_POLL_MS = 500;` | 加完整 comment（概念 + value 依据）|

**Value 物理依据 comment 模板**：

```
Value: <N><unit> = <来源>（<解释>）
```

**来源类型**（按可信度排序）：

| 来源 | 性质 | 例 |
|---|---|---|
| OS spec | 物理下界 / 不可绕 | macOS FSEvents 50-200ms coalescing |
| external lib default | 上游推荐 | chokidar README 推荐 100ms |
| mirror peer module | consistency | reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT |
| empirical / measured | 实测平衡 | 5 / 500ms / 平衡 X vs Y |
| arbitrary / TODO | 暂用 / 待 measure | 标 TODO（应避免最终保留）|

**反模式扩展**：

- ❌ const 仅概念 comment 缺 value justification（半 done / 读者仍不知「为什么是这个数」）
- ❌ 标 「reasonable default」/「sensible value」不算 justification（无具体来源）
- ❌ Value 标 arbitrary 长期保留（应推进至 mirror / empirical 至少）

**正确模式扩展**：

- ✓ 每 const value 必有来源标记
- ✓ 同 cluster const 互相 mirror（如 reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT 与 watcher.ts FALLBACK_CONSECUTIVE_FAIL_LIMIT mirror）
- ✓ 标 "empirical" 优于隐藏 arbitrary（诚实表达）

**phase 654 实证**：

`src/foundation/file-watcher/watcher.ts` 5 sub-fix：
- A.1 extract `stabilityThreshold: 100` → `CHOKIDAR_STABILITY_THRESHOLD_MS` + chokidar README 推荐 comment
- A.2 extract `pollInterval: 50` → `CHOKIDAR_POLL_INTERVAL_MS` + chokidar 默认 comment
- A.3 既有 `FALLBACK_CONSECUTIVE_FAIL_LIMIT = 5` 加 value justification（mirror reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT）
- A.4 既有 `DEFAULT_FALLBACK_POLL_MS = 500` 加完整 comment（macOS FSEvents fallback / 平衡 latency vs CPU）
- A.5 chokidar `awaitWriteFinish` 改用 const ref

**「魔法数字治理 cluster」决策树第 3 层**：

不仅给数字名字（647 cross-file 单源化 / 651 file-local extract）/ 还要给名字意义（654 value comment justification）。三层完整：

```
1. inline → name (extract to const)
2. name → location (file-local vs cross-file)
3. name → meaning (value justification comment)
```

Const 「半 done」状态（仅 1 + 2 / 缺 3）是普遍 anti-pattern / phase 654 是首次系统治理这一层。

**phase 655 batch 续应用**（3 file 7 const 同 phase 同 commit）：

- orchestrator.ts MAX_BACKOFF_MS（empirical + industry standard / AWS SDK / GCP 20-60s cap 区间）
- process-manager/constants.ts 3 const（PROCESS_SPAWN_CONFIRM_MS / DAEMON_SHUTDOWN_GRACE_MS / SPAWN_POLL_INTERVAL_MS / empirical / systemd convention）
- process-exec/types.ts 3 const（PROCESS_EXEC_TIMEOUT_MIN_MS / MAX_MS / DEFAULT_TIMEOUT_MS / empirical floor / ceiling / balance）

**「batch vs 单 file justification」决策矩阵**：

| 状态 | 治理 | 模板 |
|---|---|---|
| 单 file 1-3 const + 含其他 hygiene（如 inline extract）| 单 file 多 sub-fix | phase 654（5 sub-fix / 含 2 extract + 3 comment）|
| 多 file 但 const 间无依赖 / 同 cluster theme | batch 同 phase 同 commit | **phase 655（3 file 7 const / pure comment）**|
| 多 file + const 互相 cross-ref / 需协调命名 | 单 phase 多 sub-fix / 用 cross-ref comment | （无现实证 / 推 r+ 实证）|

**batch 优势**：同 commit / commit msg 集中 cluster theme / 0 拖延 / design 沉淀一次到位。

**反模式扩展**：

- ❌ const justification 一拖再拖（每 phase 修 1 个 / 不批量 / 长期半 done 状态）
- ❌ batch 跨多 cluster（应保 cohesion / 同 theme 才 batch）

**「半 done」状态识别 grep**：

```bash
# 找 file 顶部仅 const 声明 / 0 上方 comment
grep -B 1 "^export const [A-Z_]*_MS\|^const [A-Z_]*_MS" src/foundation/**/*.ts | \
  awk 'BEGIN{RS="--"} !/\*\/$|\/\*/'
# 命中 = 缺 comment 的 const（候选 justification）
```

---

## test hygiene multi-file batch（phase 658 实证 / silent failure + fixture pollution + hidden swallow + skipIf justification）

phase 658 主会话 fan-out 3 sub-agent 全扫 tests/ 157 file / 浮 4 异质 anti-pattern：

| 子形态 | 实证 file | anti-pattern 类型 |
|---|---|---|
| dup test name | `builtins.test.ts:835/962` | silent failure（vitest 同 describe 同 name 跑 2 次 / 报告 ambiguous）|
| fixture pollution | `cli-factories.test.ts` | NO afterEach / tempDir + env mutation 在 assertion fail 时 leak |
| hidden swallow | `chat-viewport-subscribe.test.ts:18` | waitFor predicate `try {} catch {}` 吞真 bug → 模糊 timeout 错误 |
| skipIf 缺 inline comment | `fallback-escalation.test.ts:21,55` | darwin-only design intent 仅 describe header 说 / inline 缺 explicit |

### 「多维异质 batch」决策矩阵

| 状态 | 治理 | 模板 |
|---|---|---|
| 单一 anti-pattern 跨多 file | 单 cluster batch（同型）| phase 644 5 sub-fix `expect(elapsed)` |
| 多 anti-pattern 跨多 file 同 cohesion | **多维异质 batch** | **phase 658 4 sub-fix test hygiene** |
| 多 anti-pattern 不同 cohesion | 拆多 phase | （cohesion theme 跨 cluster 必拆）|
| 多 anti-pattern fix 互相依赖 | 拆多 phase（依赖排序）| （罕见）|

### cohesion 判据

- 是否同 quality theme（test hygiene / 魔法数字 / etc）？
- phase 658 cohesion = test hygiene 主题 / 4 异质 anti-pattern 都是 test 质量问题 / batch 合理
- 跨 cluster（如 test hygiene + 魔法数字）必拆

### 4 anti-pattern 子形态识别 grep

```bash
# silent failure / fake coverage
grep -rnE "\.skip\(|xit\(|xdescribe\(|it\.todo\(" tests/ --include="*.ts"
# 同 describe 同 it name dup（手工 verify）
# 0-assertion test（expect.assertions(0) / 0 expect 在 body）

# fixture pollution
grep -L "afterEach" tests/cli/*.test.ts tests/foundation/*.test.ts | \
  xargs grep -lE "mkdtempSync|process\.env\..*\s*="
# 列出无 afterEach 但有 fs/env mutation 的 file

# hidden swallow（catch 块吞 expect 或 condition）
grep -rnE "} catch \{\}" tests/ --include="*.ts" | \
  grep -v "teardown\|afterEach\|cleanup"

# skipIf 缺 inline comment
grep -rnE "\.skipIf\(" tests/ --include="*.ts"
# 手工 verify each 上方 1-3 行 是否含 design rationale comment
```

### 反模式

- ❌ 跨 cluster batch（如 test hygiene + 魔法数字混 phase / cohesion 不清）
- ❌ 单 anti-pattern 跨多 phase 拖延（应 batch）
- ❌ 多 anti-pattern 但 fix 互相依赖（应拆 phase）
- ❌ 「test hygiene 是单一问题」（实然多维 / 各 anti-pattern 不同维度）
- ❌ 把 dup test 当成「无害 / vitest 仍跑」（报告 ambiguous + 维护混淆）

### 正确模式

- ✓ cohesion 同主题 / batch 同 phase 同 commit
- ✓ 各 sub-fix 文件独立 / 0 cross-file cascade
- ✓ commit msg 集中 cluster theme（phase 658 = "test hygiene cluster Tier 1"）
- ✓ 多维异质 batch 是合法 batch（vs 同 anti-pattern 单 cluster）
- ✓ design 沉淀异质 batch 模板（不拆细多 feedback）

### 升格信号

- phase 658 单实证 / 推 ≥ 2 实证升格 active
- 与「魔法数字治理 cluster」（phase 644-655）平行 / 不同 quality theme

### 触发条件

每次 fan-out 扫 tests/ 浮多个 anti-pattern 时跑决策树。**优先 cohesion 判 batch / 同 theme batch / 跨 theme 拆**。

### phase 662 续应用（Tier 2 / 3 sub-fix / 同 cohesion theme = test hygiene / N=2 实证升格阈值达）

| sub-fix | 文件 | anti-pattern | 修法 |
|---|---|---|---|
| A.1 | chat-viewport-regression.test.ts:526-542 | non-null assumption bypass（`find()!.ts` 假设非空 / 改 emitter event name → 模糊 runtime error）| `expect(value).toBeDefined()` 守卫 + `!.field` 后访问 |
| A.2 | spawn-defaults.test.ts:150-175 | env restore not fail-safe（body-level cleanup / assertion fail 时 leak）| try-finally 包 cleanup（单 test 用 / 单 file 仅 1 test 用 env / 不需 file-level afterEach）|
| A.3 | dispatch.test.ts + agent-executor.test.ts 4 sites | type erasure（`{} as any` drift 时 0 编译警告）| `{} as unknown as TypeName` 双 cast + inline comment「not exercised in this test scope」|

### Tier 1 + Tier 2 = 7 anti-pattern 子形态完整分类

| Tier | # | 子形态 | 实证 phase | 修法 |
|---|---|---|---|---|
| 1 | 1 | silent failure / fake coverage | 658 A.1 dup name | 删 / merge / 加 assertion |
| 1 | 2 | fixture pollution | 658 A.2 cli-factories | afterEach 集中 cleanup / capture-restore |
| 1 | 3 | hidden swallow | 658 A.3 waitFor predicate | 捕获 last-error / 暴露在错误信息 |
| 1 | 4 | skipIf 缺 justification | 658 A.4 fallback-escalation | inline comment 解释 design rationale |
| 2 | 5 | non-null assumption bypass | 662 A.1 chat-viewport find!. | toBeDefined 守卫 |
| 2 | 6 | env restore not fail-safe | 662 A.2 spawn-defaults | try-finally / 或 afterEach（多 test）|
| 2 | 7 | type erasure | 662 A.3 dispatch+agent-executor | `{} as unknown as T` + inline comment |

### 「{} as unknown as T + inline comment」首发模板（phase 662 A.3）

vs `{} as any`：

| 特性 | `{} as any` | `{} as unknown as T` + comment |
|---|---|---|
| type 注解 | 全擦除 | 显式（双 cast）|
| drift 编译警告 | 0 警告 | 部分场景报错（依 T 大改）|
| 灵活性 | 完全自由 | 仍允许 mock partial |
| self-doc | 0 解释 | inline comment 标 test scope |
| 维护性 | 差（drift 隐藏）| 好（drift 部分暴露）|

推 ≥ 2 实证升格独立 feedback 候选。

### 「7 anti-pattern 子形态」识别 grep（扩 phase 658 4 子形态）

```bash
# Tier 2 新增 grep（Tier 1 已在 phase 658 节）

# non-null assumption bypass
grep -rnE "find\([^)]+\)!\.|arr\[[0-9]+\]!\.|\)!\.[a-z]" tests/ --include="*.ts" | head

# env restore not fail-safe（body-level cleanup vs afterEach）
grep -rnE "process\.env\..*\s*=" tests/ --include="*.ts" | xargs -I {} grep -L "afterEach\|finally" {}

# type erasure
grep -rnE "\{\} as any" tests/ --include="*.ts" | head
```

### 升格信号

- N=2 实证累达升格阈值（phase 658 + 662）/ 推 r+ Meta active 化
- 7 anti-pattern 子形态完整分类 / 后续 anti-pattern 类型扩 ≥ 2 时升格独立元 cluster feedback「test 治理决策树」

### phase 665 plan（α typed cast）— **SUPERSEDED by phase 666 γ TestRuntime subclass**

> **状态**：phase 665 主会话 plan α typed cast helper（`as unknown as RuntimeTestInternals`）→ **用户实施期改选 γ TestRuntime subclass**（drift safety strictly stronger）→ phase 666 实际落地。phase 665 plan 文件保留为历史记录。下方 phase 666 节是实际实施模板。
>
> **覆盖 reframe 论证**：α typed cast 仍 bypass TS（src field rename → cast 强行允许 / 静默通过）/ γ subclass protected 访问编译期 verified（src field rename → tsc 立 fail）/ drift safety 判据 strictly stronger.
>
> **「主会话 plan vs 用户实施期 reframe」N+1 实证**：α 推荐 → γ 实施 / 推 r85+ ≥ 2 升格独立 feedback「主会话 α/β/γ 候选起草纪律：标 用户实施期可改选 / drift safety 是否优先」.

### phase 665 plan 历史（α typed cast / 见 phase 666 节实际模板）

**8 anti-pattern 子形态扩**（Tier 1 + Tier 2 #2-4 + Tier 2 #1）：

| Tier | # | 子形态 | 实证 phase | 修法 |
|---|---|---|---|---|
| 2 | 8 | private bypass via `as any` cluster | 665 65 sites 跨 4 file | NEW shared `<Class>TestInternals` interface + `as unknown as RuntimeTestInternals` typed cast |

#### 「Runtime test contract typed-cast hygiene」（phase 665 实证 / mechanical / α dominant）

**问题**：tests/ 内 `(runtime as any).<private>` 模式（65 sites / 4 file）bypass TS visibility / mechanical hygiene 候选。9 unique fields/methods（llm + sessionManager + toolRegistry + outboxWriter + auditWriter + lastIdentityHash + buildSystemPrompt + _handleTurnInterrupt + _hasHighPriorityInbox）.

**模板**：NEW shared `tests/helpers/<class>-test-internals.ts` interface + cascade 替换为 `(<obj> as unknown as <Class>TestInternals).<X>`。

**4 子形态分类**（业务决策性 / α dominant 兑现 mechanical hygiene / β/γ/δ 推 design phase）：

| 子形态 | 描述 | 评估 | 实施 |
|---|---|---|---|
| **α typed cast helper** | NEW shared interface + cascade 替换 `as any` → `as unknown as RTI` | mechanical / 0 src / 0 行为差 / M#9 align | **phase 665 推荐** |
| β src ctor mock-friendly DI | Runtime ctor 接受 partial deps + 重构 65 sites 用 ctor 注入 | scope 大 / 涉 src 改 / Runtime 接口扩 | 推 r85+ design phase |
| γ TestRuntime extends + protected | TestRuntime extends Runtime 暴露 protected internals / 需字段 protected 改 | scope 中 / src 改 | 推 r85+ design phase |
| δ vi.spyOn instance methods | 65 sites 改 `vi.spyOn(runtime, 'llm', 'set')` | 不适用所有 case（只 instance method）/ scope 中 | 部分场景 |

**注**：α 是 transitional hygiene / 真问题（test 用 private state mutation 而非 ctor DI）推 r85+ design phase 评估 β/γ/δ。

**实证**：phase 665 65 sites 跨 4 tests/core/runtime*.test.ts file（commit `<COMMIT-PENDING>`）.

#### 升格信号扩

- **N=3 实证升格阈值过线**（phase 658 Tier 1 + 662 Tier 2 #2-4 + 665 Tier 2 #1）/ 推 Meta 45 升格独立 feedback「test 治理 cluster N=3」
- 8 anti-pattern 子形态完整分类 / 后续 anti-pattern 类型扩 ≥ 1 时升格元 cluster feedback「test 治理决策树」

#### grep 识别（扩 phase 658 + 662）

```bash
# private bypass via `as any` cluster
grep -rcE "\((<obj> as any)\)\.[a-zA-Z_]+" tests/ --include="*.ts" | grep -v ":0" | head
# Runtime / Daemon / SubAgent 等多个 class 同型
```

### phase 666 续应用（Tier 2 final / structural fix / TestRuntime subclass 模板 / N=3 实证升格远超）

phase 666 治理第 8 anti-pattern：**test contract drift via reflection**（`(runtime as any).<protected/private>` 跨 32 sites / src rename 静默 pass）。

**修法模板**（TestRuntime subclass）：

```ts
// 1 行 src 改（最小）:
- private lastIdentityHash?: string;
+ protected lastIdentityHash?: string;

// NEW tests/helpers/test-runtime.ts:
export class TestRuntime extends Runtime {
  testSetLLM(llm: LLMOrchestrator): void { this.llm = llm; }
  testGetSessionManager(): DialogStore { return this.sessionManager; }
  testGetLastIdentityHash(): string | undefined { return this.lastIdentityHash; }
  testGetToolRegistry(): ToolRegistry { return this.toolRegistry; }
  async testBuildSystemPrompt(): Promise<string> { return this.buildSystemPrompt(); }
}

// 测试改：
- const runtime = new Runtime(...);
+ const runtime = new TestRuntime(...);
- (runtime as any).llm = mockLLM;
+ runtime.testSetLLM(mockLLM);  // type-safe
```

### TestRuntime subclass 优势 vs reflection

| 维度 | `(obj as any).X` reflection | subclass `this.X` |
|---|---|---|
| drift detection | 0 警告（src rename 静默 pass）| TypeScript 立 fail |
| 集中度 | 散 N sites | 单 helper file |
| intent 清晰 | cryptic | named method（`testSetLLM`）|
| prod 接口污染 | 0 | 0（TestRuntime 在 tests/helpers/）|
| 测试断言路径 | 不变 | 不变 |
| ctor signature | 不变 | 继承 / 不变 |

### type bypass 治理 2 路径互补

phase 662 + phase 666 形成 type bypass 治理 2 路径：

| 模板 | 场景 | 维度 | 优势 |
|---|---|---|---|
| `{} as unknown as T + comment`（phase 662）| mock empty object（partial mock）| type erasure 改 type 注解 | 保 mock partial 灵活性 / 显式标 intent |
| **TestRuntime subclass + helper**（phase 666）| **access protected state** | **reflection 改 subclass + helper method** | **drift safe（TypeScript 验证 `this.X`）**|

互补 / 不重叠 / 不同场景不同模板。

### vi.spyOn 单 spy 场景例外

```ts
vi.spyOn(runtime as any, 'buildSystemPrompt').mockResolvedValue(...);
// 接受 1 site 反射（vitest 需 method on instance / TestRuntime wrapper spy 错对象 / 单 site exception OK）
```

加 inline comment 解释「vitest spy on protected method / wrapper 不 cover」。

### 升格信号

- N=3 实证累达升格阈值远超（phase 658 + 662 + 666）/ `feedback_test_hygiene_multi_file_cluster` 推 r+ Meta active 必硬化
- 8 anti-pattern 子形态完整分类（4 Tier 1 + 3 Tier 2 + 1 structural Tier 2 final）
- `feedback_test_subclass_pattern` 单实证立项 / 推 ≥ 2 实证升格独立 active
- 推 r+ ≥ 5 不同 quality theme test feedback 后立元 cluster feedback「test 治理决策树」

---

## phase 669 — src 生产可靠性 cohesion theme batch（3 anti-pattern 子形态 / Tier 1）

3 维 sub-agent fan-out：silent error swallow + async correctness + resource cleanup。274 src file / 65 raw / 13 真候选 / Tier 1 3 sub-fix（数据丢 / unhandledRejection / 性能 linear 退化）/ Tier 2 6 推 phase 670+ defensive harden。

**3 anti-pattern 子形态**：

1. **silent error swallow**：`.catch(() => {})` 真 silent vs 守 cleanup 分辨 → 真 silent 必加 audit / 守 cleanup 加 comment 接受。
   - 反例：`task-recovery.ts:123` `await fs.writeAtomic(retryPath, String(retryCount)).catch(() => {})` retryCount 写失败静默 → MAX_RECOVERY_RETRIES dead-letter promotion 永不触发 / 任务 loop forever。
   - 修法：`.catch(e => auditWriter.write(EVENT, task.id, 'context=retry_counter_persist_failed', err))`。
   - 同模板 mirror phase 541+561+564+578+595+597+604+614 `silent_x_audit_kit` 7 子节累 N=15+。

2. **async correctness**：`void asyncFn()` 在 startup hot path → unhandledRejection 风险。sequential await 在 readonly 路径 → 性能 linear 退化（应 mirror sync sibling parallel 模板）。
   - 反例：`system.ts:207` `void this._initialScanPending()` startup `unhandledRejection` / `tool-execution.ts:73-79` readonly-async sequential（vs sync sibling L110 用 `executor.executeParallel`）。
   - 修法：`.catch(audit)` / mirror sync sibling parallelize 模板。
   - phase 669 NEW 立 `feedback_async_correctness_cluster.md` / 单实证 N=1 待累 ≥ 2 升格。

3. **resource cleanup**：codebase 已 demonstrate 强 cleanup discipline（每 setInterval 配 clearInterval / 每 openSync 配 closeSync in finally / 每 chokidar watcher 配 close）/ Tier 2 仅 defensive harden（runtime AbortController 未 abort 在 finally / fallbackTimer 无 unref / clawsDirWatcher 无 try-finally）。

**cohesion theme batch 决策**：
- 同一 prod 可靠性主题 / 跨 3 anti-pattern 子形态 / 同 phase batch（vs 跨 cluster 拆 3 phase）
- Tier 1 / Tier 2 划分：真 bug 类（数据丢 / unhandledRejection / 性能 linear 退化）vs defensive harden（finalizer best-effort）
- 推下 phase 670+ Tier 2 6 sub-fix（finalizer Promise.all → allSettled / runtime AbortController abort / clawsDirWatcher try-finally / fallbackTimer unref / daemon-loop catch + void done audit / tool-execution.ts:200 console-only 加 audit）

**与既有 cluster 关系**：
- 与 phase 658+662+666「test_hygiene_multi_file_cluster」对偶（test 治理 cohesion theme batch vs src 治理 cohesion theme batch / 同模板）
- silent error swallow 子形态续 phase 541-614 `silent_x_audit_kit` 累 N=15+
- async correctness 是新维度（不 catch 内 / 而是 promise flow 自身）
- resource cleanup 整体 N=0 真 leak / 推 codebase 强 cleanup discipline 立证（无需新 feedback）

### phase 672 续应用（Tier 2 / 5 sub-fix defensive harden / src 生产可靠性 cluster 收尾）

phase 669 Tier 1 后续 Tier 2 batch / 5 sub-fix 跨 6 file。

**5 sub-fix**：
1. `Promise.all` → `Promise.allSettled`（finalizer 2 sites / `stop.ts:54` + `chat-viewport-claw-manager.ts:207` / best-effort 完成全 close + log 失败 names）
2. `daemon-loop.ts:188` catch + void done 双层 swallow → audit + `.catch`（INBOX_WATCHER_FAILED context=init）
3. `tool-execution.ts:200` console-only 加 audit（tool_execution_failed event / 与既有 tool_input_parse_failed 同 namespace）
4. `chat-viewport.ts:780` try-finally 包 cleanup（防 exitPromise reject 时 fd leak）
5. `file-watcher/watcher.ts:223` `fallbackTimer.unref?.()`（与 chat-viewport 4 siblings 一致）

**Tier 2 决策**：defensive harden / 真 leak/silent 0 / 但若 happy path 偏差时损失观察性 / harden 加固边缘 case。

**runtime.ts AbortController abort 在 finally drop reason**：
- 4 sites（runtime.ts:557/622/670/720）/ 行为耦合 tools（已 retained signal listener 会被触发 turn_completed → 不可控副作用）
- 推 design phase 单独评估 abort reason 协议（如 `abort({ type: 'turn_completed' })` 是否所有 tool 听众都 graceful handle）
- 不 batch / 推 r+ 独立 design phase 决定

**与 phase 669 Tier 1 关系**：
- Tier 1 = 真 bug 类（数据丢 / unhandledRejection / 性能 linear）/ 必修
- Tier 2 = defensive harden（finalizer best-effort / observability gap fill / fd leak prevention）/ 加固
- Tier 1+2 完成后 src/ 生产可靠性 cluster 收尾 / 推后续 cluster 候选（design doc drift / dead code / API surface）

---

## phase 675 — test mock/spy hygiene cluster Tier 1（global/prototype/static spy 跨 worker leak + fakeTimer 跨 describe leak / 5 sub-fix）

3 维 sub-agent fan-out tests/ / 152 file 扫 / 浮 oracle quality + timing brittleness + isolation 三大维。Tier 1 取 5 sub-fix cohesion = mock/spy + fakeTimer cross-file/cross-describe hygiene。

**5 sub-fix**：
1. `audit.test.ts:12` console.error spy at describe-collection-time → 移入 beforeEach + afterEach restore
2. `spawn-defaults.test.ts:48` `vi.clearAllMocks` → `vi.restoreAllMocks`（prototype spy 还原）
3. `runtime-initialize-failures.test.ts:88,159` DialogStore.repair static spy → file-level afterEach restoreAllMocks
4. `init-envvar.test.ts:26` + `password-restore-reverse.test.ts:23` process.exit spy → describe lifecycle + afterEach restore
5. `daemon-loop.test.ts:382` iteration audit describe → afterEach useRealTimers + restoreAllMocks

**关键判据**：`vi.clearAllMocks` ≠ `vi.restoreAllMocks`：
- clear = 清 call history / 保 mock implementation
- restore = 移除 mock / 还原原方法
- prototype/static/global spy 必 restore / 不能 clear

**Tier 2 推后续 phase**：
- oracle quality（tautology dialog.test.ts / count>0 contract_manager_llm 9 sites / name-lies builtins.test.ts:1084）
- wallclock → fakeTimer 大批迁移（abort-helper 7 + chat-viewport-regression 14 + contract_manager 13 + llm-service 3 + cron 2 = 39 sites 跨 5+ file）
- brittle exact error message → it.each + match（abort-helper 5 sites）

**与 phase 658+662+666 test 治理 cluster 关系**：
- 前 8 anti-pattern 子形态（silent failure / fixture pollution / hidden swallow / skipIf / non-null bypass / env restore / type erasure / test contract drift via reflection）
- phase 675 加第 9 子形态（spy/mock cross-file leak via clear ≠ restore + describe-collection-time spy + fakeTimer no afterEach）
- N=4 实证累（phase 658 + 662 + 666 + 675）/ test_hygiene_multi_file_cluster 持续硬化

---

## phase 677 — test oracle quality cluster（count>0 → exact + name-lies → real assertion / 2 sub-fix）

phase 675 fan-out Tier 2 oracle quality 推后续 / 2 真 bug 类候选治理。

**2 sub-fix**：
1. `contract_manager_llm.test.ts` 7 sites `rejections.length > 0` → `toHaveLength(1)` / loop bug undetectable 修
2. `builtins.test.ts:1083` "should have timeout parameter processed" 仅 check `typeof success` → 改 sleep 1 + 100ms timeoutMs + assert timeout error / 真 enforce

**关键判据**：
- count assertion `> 0` 当期望恰好 N → `toHaveLength(N)` 严格
- test name 声明 X / assertion 必验 X / 不能仅 check `typeof / instanceof`（TS 已 enforce 冗余）

**Tier 2 推后续 phase**：
- dialog.test.ts:281 tautology（真 fix 需 real SkillRegistry fixture / 单独 phase）
- 5+ 其他 count>0 sites（contract_manager.test.ts 3 sites + contract_manager_llm:728 + runtime.test.ts:1083 + dialog.test.ts:76 / 同模板 sweep）

**与 phase 658+662+666+675 test 治理 cluster 关系**：
- 9 anti-pattern 子形态前 / phase 677 加第 10 子形态（test oracle quality）
- N=5 实证累（phase 658+662+666+675+677）/ test_hygiene_multi_file_cluster 持续硬化

---

## phase 680 — count assertion exactness sweep（phase 677 续 / 5 sub-fix / 4 file / N=2 升格 active）

phase 677 oracle quality cluster Tier 1 续 / 跨 4 file 5 sub-fix sweep / cohesion = count assertion exactness。

**5 sub-fix**：
1. `dialog.test.ts:76` archive entries → `toHaveLength(1)`
2. `runtime.test.ts:1083` messages length → `toHaveLength(N)` 或 role-array assertion
3. `runtime.test.ts:1653` sessionLoadedIndex `>= 0` → `not.toBe(-1)`（self-doc）
4. `gateway.test.ts:295-297` ×3 indexOf/findIndex → `not.toBe(-1)`（防 -1 false-pass guard）
5. `motion.test.ts:125` agentsIndex → `not.toBe(-1)`

**关键判据补**：
- count assertion → `toHaveLength(N)` 严格
- findIndex/indexOf 检测「找到」→ `not.toBe(-1)`（清晰 self-doc / 同语义 vs `>= 0` / 后续 `<` 比较时必加 guard 防 -1 false-pass）
- count 与 findIndex 是不同 pattern / 模板分用

**drop**：contract_manager 4 sites（cleanupCalls / unexpectedThrowCalls / escalationCalls）retry-count dependent / "at least 1" 合理 / 推 phase 681+ 同模板 sweep with comment-only fix。

**升格**：phase 677 + 680 N=2 → `feedback_test_oracle_quality` 升格 active。

**与 phase 658+662+666+675+677 test 治理 cluster 关系**：
- 第 10 子形态（test oracle quality）N=2 实证累
- N=6 实证累（phase 658+662+666+675+677+680）/ test_hygiene_multi_file_cluster 持续硬化

## phase 684 — Sub-B fan-out 状态持久化 cluster fix（r91 C fork / 4 sub-fix code + 7 design row）

r89 fan-out Sub-B 报告 14 candidate Path #1 实测核（起步 SHA 309727ab / 报告原 SHA cd7ea485 / cross-r drift re-verify）。

**4-state 分类**：
- 真 P1 land：1（B-P2.10 sync-backup audit injection / silent_x α 模板）
- 真 P2 hygiene land：3（B-P2.1 sort 统一 / B-P2.2 retry-count audit / B-P2.11 sister case catch）
- 业务决策推 user：3（B-P2.3 dream isolate / B-P2.4 evolution save / B-P2.6 watchdog save）
- design row only acceptable：3（B-P1.1 dir fsync / B-P2.8 spawn race / B-P2.12 audit fallback fsync）
- C3 STALE phantom REJECT：3（B-P2.5 / B-P2.9 / B-P2.13）
- closed by phase 679：1（B-P2.7）
- out-of-scope：1（B-P2.14）
- **真率 4/14 ≈ 28%**（接受边缘 / 不强行 land）

**关键判据**：
- silent X 模板 α 注入（mirror phase 669）→ ctx.auditWriter? 调用 + 区分 ENOENT vs IO error
- sort 算法跨 path 统一（numeric parse vs localeCompare drift / 行为差 0 但 design intent 一致）
- sister case asymmetry catch hygiene（mirror 已稳定 case 模板）
- 业务决策三段式 design row（α/β/γ + 28 原则核 + 主会话预期 + 待 user 拍板）/ 不替决

**与 5 kit umbrella 关系**：
- silent_x_audit_kit §2 audit 注入 α：N+1 实证（B-P2.10 sync-backup）
- silent_x_audit_kit §7 同根 cluster 接力：N+2 实证（B-P2.2 + B-P2.11 task-recovery）
- design_ratify_kit §3 业务决策推 user：N+3 实证（B-P2.3/4/6）
- dispatch_verification_kit §1 cross-r SHA drift Path #1 re-verify：N+1（cd7ea485 → 309727ab）

**「fan-out → r+1 P1 cluster fix single phase」第 6 实证**（phase 636+646+653+656+672+679+684）。

## phase 687 — chat-viewport-regression 14 处墙钟 setTimeout → 真实事件 + audit 等待（r92 C fork / e2e 时序加固）

`tests/e2e/chat-viewport-regression.test.ts` 14 处实墙钟 setTimeout（120-200ms 不等）→ 替换 / 0 行为差 / 测试时长缩 ≥ 1s。

**替换三态 + 1**：
1. **真实事件等待**（waitForEvents）：等观察方收到 stream event / 适用「event 序列推进」/ phase 687 用 3 处（L248/L250/L270）
2. **audit 落盘等待**（waitForAudit）：等 side effect 落盘 / 适用「audit row 是测试输出」/ phase 687 用 8 处（L274/L278/L282/L286 + L491/L496/L501/L506）
3. **冗余 drop**（紧邻已有 waitForEvents 的 setTimeout 删除）：phase 687 drop 2 处（L289/L486）
4. **absence 测试 setImmediate flush**：reader 已停 / 0 事件可等 / setImmediate ×2 flush microtask + macrotask 1 cycle / phase 687 用 1 处（L433）

**关键判据**：
- e2e 测试不引入 `vi.useFakeTimers()`（与 fs watcher 实时事件冲突 / fakeTimer 仅适配单元测试）
- 替换前提：测试结构已存在 helper（waitForEvents + waitForAudit）/ 不引入新 helper / 仅 1:1 替换
- elapsed_ms 断言保留：同 callback 同 Date.now() 帧 / 0=0 case 也保 `Math.abs(diff) ≤ 1` pass
- 同 file 14 处单 phase batch（cohesion > 拆 phase）

**与 phase 638 同时钟域时间断言纪律联动**：
- phase 638 解决 chat-viewport flaky / 真值 vs 期望值同 callback clock
- phase 687 解决 chat-viewport 等待时点 / 真实事件 + audit 落盘 vs 墙钟
- 两 phase 同 e2e file cluster（chat-viewport 30+ phase / silent_x_audit_kit §7 同根 cluster 接力 模板）

**反模式**：
- ❌ 用 `vi.useFakeTimers()` 在 e2e（与 fs watcher 真实事件冲突）
- ❌ 替换冗余 setTimeout（紧邻已有 waitForEvents 直接 drop / 不强行 waitForX 多此一举）
- ❌ 测 absence 用 waitForEvents（无事件可等 / 用 setImmediate flush）

**升格信号**：N=1（phase 687 首发）+ phase 638 首发 → N+1 推 r93+ 同型再遇升格独立 sub-pattern「e2e 真实事件等待 vs 墙钟」。

## phase 694 — r93 C fork / mock tautology 4 维 audit + it.each refactor

r93 C fork tests/ 4 site 4-state 分类 + it.each mechanical refactor / 0 src 改 / 0 行为差。

**4 site 4 维 audit**：
1. `gateway-ask-user.test.ts` site 1：createAskUserTool forwarding test → accept（tool body 仅调 gateway.askUser / failure path 由 Gateway.askUser unit tests 覆盖）
2. `injector-context-load-audit.test.ts` site 2-3：AGENTS.md + MEMORY.md FNF silent → STALE phantom flag（dispatch 误标为 mock tautology / 实测是 FNF 静默契约测试 / 0 改 accept）
3. `create-runtime.test.ts` site 4：trim success / empty-after-trim → accept（Node .trim() 默认覆盖 \r\n / \t / \s / α 足够 / β 扩信心 ROI 低 skip）

**it.each refactor**：
- `injector-context-load-audit.test.ts` 4 单 it → 1 it.each（mirror phase 686 abort-helper 模板 / N=2 升格阈值达）
- `err: () => new ...` lambda 隔离 / 防 4 case 共享 instance state 泄漏
- contractManager 2 单 it 保留（mock 路径不同 / α 保留）

### §test-hygiene-it-each-regex

- phase 694 row：`injector-context-load-audit` 4 case it.each refactor（mirror phase 686 / N=2 升格阈值达 / 升格独立子形态首发兑现）

### §test-hygiene-mock-tautology-4dim

- phase 694 row：4 site 4 维 audit（2 STALE phantom flag + 1 forwarding accept + 1 trim accept / 4 维模板第 N 实证 + STALE phantom 子形态首发）

**与 phase 658+662+666+675+677+680 test 治理 cluster 关系**：
- 第 11 子形态（it.each refactor）N=2 实证累（phase 686 + 694）
- 第 12 子形态（mock tautology 4 维 audit）N=1 实证（phase 689 + 694）
- test_hygiene_multi_file_cluster 持续硬化

**升格信号**：
- 「精确字符串断言 → it.each」N=2 升格阈值达（phase 686 + 694）→ 推升格独立子形态
- 「dispatch over-flag tautology → 实测 STALE phantom」首发 N=1 → 推 r94+ 累 N=2 升格
- 「mock tautology 4 维 audit」N+1 实证扩（phase 689 + 694）→ feedback_test_oracle_quality evidence 加强

## phase 695 — r93 E fork tests/ 新维度 fan-out + Tier 1 land（3 sub-agent / 113 候选 / 0 自承红旗）

3 sub-agent 并行扫 tests/ 4 维度：测试覆盖盲区（V1）+ fixture 维护负担（V2）+ 测试数据 builder 卫生（V3）+ real OS API 可疑 flaky（V4）。

**关键 stats**：
- 3 sub-agent 0 自承红旗（绝对路径 prompt + 拦截规则三件套实证 N+1）
- 113 候选 / Tier 1 land 3（V3-P1.1 makeAudit collapse + V4-P1.3 fallback waitFor + V4-P2.5 transport win32 gate）
- Tier 2 推 user 6 业务决策 + 1 测试设计判断
- saturate-tier 推 r94+ ≈ 85+ 候选（V1-P3 saturate / V4-P2.2 同模板 / V3-P2 framing extension）
- Tier 1 真率 **2.6%**（3/113）→ 探索性 fan-out 维度发散 → 收敛模式首发

**Tier 1 收敛判据**：mechanical fix（明确 site + 明确 fix / 0 设计判断 / 0 业务决策 / 0 大 scope 重构）

**Tier 2 推 user 判据**：
- 业务决策（schema 抽 builder 优先级 / 基础设施投资 / coverage priority）
- 测试设计判断（条件断言 vs 强制 fail / fakeTimer 改造 race test）
- 大 scope 重构（8 file 内联 schema 抽共享 builder = 1 phase 工作量）

**与 phase 684/687 关系**：
- phase 684（r91 C fork）真率 28% → phase 687（r92 C fork）真率 100%（单 file 14 处替换）→ phase 695 真率 2.6%（113 候选探索）
- 真率剧烈差 reflect sub-agent 任务类型（targeted bug fix vs 探索性维度 fan-out）
- design_ratify_kit §3 N+6 实证（业务决策三段式 row）

**升格信号**：N=1（phase 695 首发 sub-agent prompt 防御 + 维度发散收敛模式）/ 推 r94+ 同型再遇 N+1 升格。

### V1-P1.1-5 5 核心类 coverage gap 业务决策 row（推 user）

- **claim**：5 核心 src export 0 test mention：
  - V1-P1.1 `MemorySystem` class / `src/core/memory/system.ts:23` / 3 src callers
  - V1-P1.2 `createLLMOrchestrator` / `src/foundation/llm-orchestrator/index.ts:26` / 3 src callers
  - V1-P1.3 `parseToolInput` / `src/core/step-executor/utils.ts:20` / 3 src callers
  - V1-P1.4 `handleCliError` / `src/cli/errors.ts:22` / 3 src callers
  - V1-P1.5 `safeCallback` / `src/core/step-executor/utils.ts:10` / 4 src callers
- **选项**：α 全补 unit test / β 选 2-3 核心 / γ 全推后 saturate
- **28 原则核**：可观察 + 测试覆盖 → α/β / YAGNI → γ
- **主会话预期**：β 选 2-3 核心
- **决策状态**：**待 user 拍板**

### V1-P2/P3 + V4-P2.2 saturate-tier 推后

- V1-P2 7 个 + V1-P3 80+ build/format/parse helper 真率估 30-60% / 推 r94+ saturate sample
- V4-P2.2 process_manager 100ms async cleanup sleep / 同 V4-P1.3 模板 / 推 r94+ batch

### V4-P3.1 + V3-P2.1/2/3 design row only acceptable（不修）

- V4-P3.1 process-exec.test POSIX binary 依赖 / foundation contract 假设 POSIX / acceptable
- V3-P2.1 partial-shape extensions / V3-P2.2 makeTestRegistry thin factory / V3-P2.3 createTempDir bypass / 非 schema-drift 风险 / 各处 deliberate extension / 不动

### C3 STALE phantom REJECT closed-by-phase

- V2-P3.1 session-fixtures 单 caller / closed by phase 695 / 是治理样本 non-负担
- V3-P3.1/3.2 makeTaskSystemDeps / makeRuntimeDeps 0 bypass / closed by phase 695 / framing miss
- V4-P2.3 process_manager spawn 已 mocked / closed by phase 695
- V4-P3.2 snapshot.test 已 skipIf gated / closed by phase 695

**与 5 kit umbrella 关系**：
- silent_x_audit_kit §1 不直接适用（本 fork 0 silent X cluster）
- design_ratify_kit §3 业务决策推 user：N+6 实证（V4-P1.2 + V1-P1 + V2-P1.1 + V2-P2.1 + V4-P1.4 + V4-P2.1）
- dispatch_verification_kit §1 sub-agent 自承红旗 prompt 防御：N+1 实证（3 sub-agent 0 红旗）

## phase 700 — r94 C fork / 测试时序 sleep 残留收尾（stream-reader + process_manager）

r94 C fork tests/ 2 file 16+1 site setTimeout 残留 / 4 类分类 + sentinel probe 模板首发。

**4 类分类**：
| 类 | site | 描述 | fix |
|---|---|---|---|
| A chokidar init wait | 10 site | reader.start() 后 blind 300/150ms | sentinel probe（9 site / 1 site RULE OUT）|
| B pre-start file settle | 1 site | writer.write 后 fs flush 等待 | 删除（writer 同步 / YAGNI）|
| C absence wait（inverse）| 3 site | 断言 N ms 内不 emit | 保留 + inline comment |
| D chokidar batch boundary | 2 site | 分批 append 不合并 | 保留 + inline comment |

**关键判据**：
- chokidar real fs watcher → fakeTimer **不适用**（fake 后 chokidar callback 永不 fire / 整文件 hang）
- sentinel probe 模板：`reader.start()` → write `__sentinel__` → `waitFor` 兑现 → reset events
- process_manager L113：waitFor 替换 blind 100ms（cleanup 实际 < 10ms / 同 phase 695 V4-P1.3 模板）

**与 phase 686+687 关系**：
- phase 686 abort-helper = 纯逻辑 timer → fakeTimer ✅ 适用
- phase 687 chat-viewport-regression = 真 fs event 等待 → waitForEvents ✅ 适用
- phase 700 stream-reader = 同 phase 687 类（chokidar real fs watcher）→ fakeTimer ❌ 不适用 / sentinel probe ✅

**副发现**：dispatch §C「改 fakeTimer」over-generalize（phase 686 模板直接迁移不适 phase 700）/ 首发 N=1 / 推 r95+ 累 N=2 升格。

### §test-hygiene-fakeTimer-applicability

- phase 700 row：stream-reader.test.ts fakeTimer **NOT applicable**（chokidar real fs / RULE OUT）/ process_manager.test.ts:113 → waitFor / mirror phase 695 V4-P1.3
- phase 686 abort-helper（fakeTimer 适用 / 纯逻辑 timer）vs phase 700 stream-reader（fakeTimer 不适用 / real fs watcher）= 边界纪律

### §test-hygiene-chokidar-sentinel-probe

- phase 700 row：sentinel probe 模板首发（9 A site land / 1 site RULE OUT）/ mirror phase 687 chat-viewport-regression `waitForEvents` 模板 N+1
- 通用化：`reader.start()` → write sentinel → waitFor 兑现 → reset events

### §dispatch-instruction-over-generalize

- phase 700 row：dispatch §C「改 fakeTimer」over-generalize 首发（适 phase 686 不适 phase 700）/ 推 r95+ 累 N=2 升格候选

**升格信号**：
- 「sentinel probe 替 blind sleep」模板首发（9 site 实证）+ phase 687 waitForEvents N+1 = N=2 升格阈值达 / 推升格独立子形态入 `feedback_test_hygiene_multi_file_cluster`
- 「fakeTimer rule out / chokidar real fs」首发（test_hygiene 子形态 / 推 r95+ 累 N=2 升格）
- 「dispatch instruction 跨 file 模板 over-generalize / 实测后 reframe」首发 N=1（推 r95+ 累 N=2 升格）

**与 phase 658+662+666+675+677+680+694+695 test 治理 cluster 关系**：
- N+2 实证累（sentinel probe + fakeTimer rule out）

## phase 703 — r94 D fork 4 dominant 自决（28 原则 derive / D-1 + D-3 + D-4 + D-5）

r94 D fork 6 user gate 经 28 原则 cross-check：5 dominant + 1 真 user 拍残留（D-6 α probe vs γ 常量）+ 1 framework dominant 顺序 user own（D-2 推 r95+）。本 phase 实施 4 dominant：

| # | 原则 derive | 选项 | 实施 site |
|---|---|---|---|
| D-1 | DP「不得静默忽略」+「状态可观察」推翻 β/γ | α force loud（waitFor strict） | `tests/foundation/file-watcher.test.ts:115-130` |
| D-3 | ML「编译器检查」+「单点耦合」推翻 β/γ | α 抽 builder + 8 file | NEW `tests/helpers/contract-yaml.ts` + 8 file |
| D-4 | 同 D-3 + 已有 helper（单 caller / 扩展边际成本低） | α 扩 helper + 4 file | EXTEND `tests/helpers/session-fixtures.ts` + 4 file |
| D-5 | DP「状态可观察」推 race 真值 / fakeTimer 掩盖 | γ 保 real timer + 缓 buffer | `tests/core/subagent/agent-race-ghost.test.ts:113,124` |

**关键判据**：
- DP「不得静默忽略」推翻 silent skip（D-1 conditional / D-5 紧 margin）
- ML「编译器检查」推翻 inline schema 多点漂移（D-3/D-4 builder 单点 + `Partial<T>` typed input）
- DP「状态可观察」推 race testing 保 real timer（D-5 反 fakeTimer 误用）

**与 phase 684/695 关系**：
- phase 684 业务决策三段式 row 推 user（design_ratify_kit §3 N=20+）
- phase 695 sub-agent fan-out 浮 row + 推 user
- phase 703 用 28 原则 derive dominant 后自决（business_decision_principle_derive_then_code N+ 实证 / user 显式确认 framework 后主会话自决 land）

**「28 原则 cross-check + framework dominant + implementation choice 留 user」反 r93 D 教训持续应用**：
- r93 D 误把 dominant 推 user binary ratify 是错（多此一举）
- r94 D dominant 由原则 derive 后主会话自决 / 仅 implementation choice（α probe vs γ 常量）留 user

**升格信号**：
- D-1 (file-watcher α) 是「DP 不静默 + waitFor strict」N+1 实证（mirror phase 686/687 模板）
- D-3/D-4 是「test fixture builder + 编译器检查 schema drift」首发应用 / 推 r95+ 同型再遇 N+1 升格独立 sub-pattern
- D-5 是「race timing test 反 fakeTimer 误用」N+1 实证（mirror phase 687 e2e 不引入 fakeTimer 反模式）

**push r95+**：
- D-2 5 核心类 coverage（α framework dominant / 顺序 user own / 5 phase 拆分实施）
- D-6 hardcoded PID（α probe-helper vs γ 常量 / 真 user 拍 / 28 原则不区分两路径 / 是 ROI 判断 + 基础设施投资判断 / 不在原则覆盖内）

## phase 706 — r95 D fork src/ logging 一致性 + abort 协议 fan-out（2 sub-agent / 20 候选 / 0 自承红旗）

2 sub-agent 并行扫 src/ 维度：logging 一致性（event 命名 + payload key）+ 异步取消协议（AbortController + signal listener）。

**关键 stats**：
- 2 sub-agent 0 自承红旗（绝对路径 prompt + 拦截规则三件套实证 N+3）
- 20 候选 / Sub-A 浮 **3 真 P1 漂移** + 1 mechanical / Sub-B **0 真 P0/P1**（核心层健康）
- Tier 1 land 2 mechanical（L1-P1.1 dotcase 单点 + L2-P1.3 contract_id 跨边界 camelCase）
- 大批量 push r96+：L2-P1.1（err/error/reason 192 sites）+ L2-P1.2（path/file/dir 61+ sites）+ L2-P2.2（ms 三态）
- Sub-B 3 framing 推 r96+ N=2 升格寻

### audit key naming convention 决策树（dominant by 28 原则）

**原则 derive**：
- DP「事后凭日志记录重建运行状态」+「状态可观察」→ key naming convention 不漂 = 隐式约定显式化
- ML「不可消除耦合显式表达」+「编译器检查」→ 键名漂移 = 隐式 cross-module 约定
- ML「耦合界面最小 / 稳定」→ 内部 audit key 不耦合外部 protocol field name

**event const 字符串**：
- snake_case lower（18 file 已成熟 / 0 漂 / L1-P1.1 file_tool dotcase 单点修后归约）
- 命名 pattern：`{module}_{action}_{outcome}`

**payload key**：
- camelCase（与 TS 变量名对齐 / 与 event const 字符串 snake_case 解耦）
- 内部 audit key 不耦合外部 protocol field name（messaging outbox `options.contract_id` → audit `contractId=`）

**err / error / reason 决策树**：
- `error=` ← Error 对象 stringified（`${e instanceof Error ? e.message : String(e)}`）/ 唯一形态
- `reason=` ← business string literal 或 semantic enum（如 `reason=poll_timeout` / `reason=invalid_targetClaw`）
- 不用 `err=`（deprecated / 全转 `error=`）

**path / file / dir 决策树**：
- `path=` ← 完整路径
- `file=` ← 仅 basename
- `dir=` ← 目录路径
- 删 typed 前缀（lockPath= → path=）

**ID 字段**：
- 业务实体 ID → typed camelCase（contractId= / taskId= / subtaskId= / agentId=）
- claw 短 key（claw= 16 处 cohesive 已稳定）
- 通用 → `id=`

**时间字段**：
- 持续 / 延迟 → snake_case `*_ms`（elapsed_ms / delay_ms / recovery_delay_ms）
- 单位标签 → `ms=`（LLM latency / turn duration 上下文已含语义）
- camelCase `*Ms=` 旧形态 → r96+ decision

### 与 phase 695/703 关系

- phase 695 sub-agent fan-out 浮 row 推 user（design_ratify_kit §3 N=20+）
- phase 703 用 28 原则 derive dominant 自决（business_decision_principle_derive_then_code）
- phase 706 audit key naming 是 cross-cutting drift 决策树（mirror phase 703 D-3/D-4 typed builder + 编译器检查 同模板）

### push r96+ 显式登记

- L2-P1.1 err/error/reason 三态 batch（192 sites / 决策树 enforce / 单独 phase）
- L2-P1.2 path/file/dir 四态 batch（61+ sites / 决策树 enforce / 单独 phase）
- L2-P2.2 ms 三态 decision（决策树进一步细化 / r96+ 同型再现升格）
- Sub-B 3 framing（mergeSignals vs withCombinedAbortSignal 近邻 + combine 三形态 + once 依赖非对称 / N=1 推累 / r96+ N=2 升格寻）

**升格信号**：
- 「audit key naming convention 决策树」N=1 首发 / 推 r96+ 同型 cross-cutting drift 决策树再现 N=2 升格独立 sub-pattern
- 「sub-agent 0 自承红旗」N=3+ 实证累（r93-E + r94-D + r95-D）

### 与 5 kit umbrella 关系

- silent_x_audit_kit §1：本 fork 0 silent X cluster / 但 audit key naming 是 silent-X 治理的下游纪律
- design_ratify_kit §3：N+1 实证（决策树 dominant by 28 原则 derive / mirror phase 703 D-3/D-4）
- dispatch_verification_kit §1：sub-agent prompt 防御 N+3

---

## snapshot reuse 必单 source / 0 重复 derive（全然一致性原则 / phase 709 首发）

**立项**：2026-05-11 / phase 709（DialogStore reframe = LLM call snapshot store + ask_motion 全然一致性 reuse / design only）。

### 原则

「**reader of snapshot**」业务必使用 **producer of snapshot 实然用的值** / **0 重复 build / 0 重复 derive**。

具体形式：
- producer 模块 own 真实用值 derive 逻辑（build + derive + compose）
- producer 模块每 turn 写完整 snapshot 到 persistent store
- reader 模块仅 read snapshot / **不调** producer 的 derive 逻辑
- snapshot store 是 **source of truth 单源**（不是 producer 内存 + reader 重 derive 双源 drift）

### 判据

reader 业务何时必走 snapshot reuse（不能自己 derive）：
- ✅ reader 业务 = 「**frozen at producer 某时刻**」语义（如 ask_motion = dispatch 时刻 Motion）
- ❌ reader 业务 = 「**latest derive**」语义（如 next-turn LLM call / 不是 reader 不应 reuse / 是 producer 自己每 turn 自然 derive）

**核心判据**：
- 如果 reader 期望与 producer 某时刻**全然一致**（值同 / build 逻辑同 / derive 同）→ 必从 producer snapshot store read
- 如果 reader 自己 build / derive → producer 改 build/derive 逻辑后 / reader **必同步改**（耦合不可见 / drift 风险）

### 反模式

- ❌ reader 自己调 producer 的 build 函数（如 `buildMotionSystemPrompt(injector, fs)`）/ 看似 reuse 函数 / 实际 reader 须知 producer 装配（contextInjector + fs）/ 跨模块耦合面扩
- ❌ reader 自己调 producer 的 derive 函数（如 `toolRegistry.formatForLLM(getForProfile('full'))`）/ 看似 reuse 函数 / 实际 reader 须知 producer 的 profile 选择 + tools 范围 / 跨模块耦合面扩
- ❌ producer 内存 snapshot 经 dispatch 端 await + push 到 task payload（如 phase 699 askMotionContext）/ snapshot 经过多层 hop / source 不单一 / 写一次/读一次模式比 producer 持久化 + reader 直 read 更冗余

### 正确模式

- ✅ producer（如 Motion runtime）每 turn 完整 snapshot save 到 persistent store（如 DialogStore）
- ✅ reader（如 ask_motion）ctor 仅注入 persistent store ref（如 motionDialogStore: DialogStore）
- ✅ reader.execute 内部 `await store.load()` → 拿 snapshot → 直 use（0 build / 0 derive）
- ✅ snapshot store schema 含完整 LLM call 3 件参数（system + messages + tools）/ 一组 atomic write

### 实证

- **phase 709 (design only)**：ask_motion 全然一致性 reuse Motion DialogStore snapshot 设计立项
  - producer = Motion runtime（每 turn LLM call 后 save 完整 snapshot）
  - reader = ask_motion（subagent 内 / read Motion DialogStore / 0 自己 build systemPrompt / 0 自己 derive tools）
  - source = motion `<dialogDir>/current.json` 持久化的 SessionData（3 件 LLM call snapshot）
- **phase 713 (code 落地 / SHA `1edb41d2`)**：DialogStore reframe + ask_motion 全然一致性 reuse 实证落地
  - 29 files changed / 155 test files PASS / 1698 tests PASS / tsc 0 errors
  - DialogStore ctor 删 systemPrompt 必填参 / save 签名扩 snapshot 参 / SessionData v2 +toolsForLLM / v1→v2 兼容 read
  - SubAgentTask 删 askMotionContext +motionClawDir / dispatch.ts 简化 / ask-motion.ts ctor 4→2 dep / subagent-executor 装配 motionDialogStore inject
  - **design+code 联动 3 阶段第 2 实证完整闭环**（phase 444+450+453 第 1 + phase 709+713 第 2）
  - **全然一致性原则首发实证落地** / **historical design intent 推翻规范首发落地**（推翻 phase 466 instance lifetime 锁定）

### 升格信号

phase 709+713 双实证（design + code 完整周期）/ **升格独立 feedback「snapshot reuse 必单 source / 0 重复 derive」条件过** / 同根 cross-process design smell 元判据（phase 432+438+699 cluster）/ 形态扩：从 closure 不可序列化 → 重 build / 重 derive 是另一种「不可跨模块复制」漏。

### 与既有原则关系

- 同根 `feedback_governance_workaround_smell §callback closure 元判据`（cross-process design smell / phase 432+438+699 3 实证累 / 本原则形态扩）
- 同根 M#3 资源唯一归属（snapshot store 是 source of truth 单源 / 不允许 reader 平行 derive）
- 同根 D5 底层不预设上层（reader 不应 reach into producer 内部 build/derive 逻辑）
- 与 `feedback_dispatch_*_path1_reframe` 不同（那是 dispatch claim framing 验证 / 本原则是 reuse 模式合规）

## phase 711 — r96 D fork src/ env/config + tests/ parallel safety fan-out（2 sub-agent / 21 候选 / 0 自承红旗）

2 sub-agent 并行扫 src/ env/config 维度 + tests/ parallel safety 维度。

**关键 stats**：
- 2 sub-agent 0 自承红旗（绝对路径 prompt + 拦截规则三件套实证 N+4）
- 21 候选 / Sub-A 浮 1 真 P1（E1-P1.1 getWorkspaceRoot 内联绕过）+ Sub-B 浮 4 真 P1（spy lifecycle gap × 3 + undefined coerce × 1）+ 1 推 r97+（cross-worker env race）
- Tier 1 land 4 mechanical（getWorkspaceRoot collapse / 2 file vi.restoreAllMocks / undefined coerce fix）
- Tier 2 推 r97+：cross-worker env race（业务决策三段式）+ buildChildEnv helper（saturate-tier N=2 升格寻）+ AbortController spy try/finally（saturate-tier）

**关键判据**：
- ML M#3「资源唯一归属」→ workspace root 单点 import enforce（E1-P1.1 collapse）
- `feedback_test_spy_mock_lifecycle.md` N+2 实证（phase 675 + phase 711 file-watcher / runtime-regime-switch）/ 升格阈值过线
- DP「状态可观察」+「不静默忽略」推 spy restore + undefined coerce fail-loud
- vitest threads pool 共享 process.env 是测试基础设施约束 / 治理路径多选 / 业务决策推 user

### cross-worker env race 业务决策三段式 row（推 r97+）

#### P3-P2.1 `process.env.CLAWFORUM_ROOT` 跨 5+ cli test file mutation race

- **claim**：vitest.config.ts `pool: 'threads'` / Node `worker_threads` 共享 process.env / 5+ cli test file 并发 mutation `CLAWFORUM_ROOT` / cross-worker race
- **选项**：
  - α：vitest.config.ts 改 `pool: 'forks'`（子进程隔离 / 0 env 共享 / startup 慢）
  - β：抽 `envSnapshot` helper / 每 test scope save+restore 严格化
  - γ：强制 `--fileParallelism=false` / 串行 / 慢
  - δ：保现状 + 文档说明 cli test 单线程 dependency
- **28 原则核**：
  - DP「状态可观察」+ ML「资源唯一归属」→ 倾向 β envSnapshot helper
  - YAGNI（0 已知 CI flake）→ δ 保现状
- **主会话预期**：β envSnapshot helper（cohesion N=2 升格寻 + 0 startup 代价）
- **决策状态**：**待 user 拍板**

### push r97+ 显式登记

- **P3-P2.1** cross-worker env race（业务决策三段式 / r97+ 单独 phase）
- **P3-P1.3** AbortController spy try/finally（saturate-tier / 推 r97+ 同型 spy lifecycle batch）
- **E1-P2.1** 5 spawn env literal 抽 `buildChildEnv()` helper（refactor_helper_kit §1 N=5 阈值过线 / 推 r97+ N=2 升格寻）

### 与 phase 706/703 关系

- phase 703（r94 D fork）28 原则 derive dominant 自决 land
- phase 706（r95 D fork）audit key naming convention 决策树立
- phase 711 ML M#3「资源唯一归属」+ test spy lifecycle 双 anti-pattern 治理
- 三 phase 同模板：sub-agent fan-out → spot-check → Tier 1 mechanical 收敛 + 业务决策推 user

**升格信号**：
- 「test mock/spy lifecycle」N=2 升格阈值过线（phase 675 + phase 711）→ 入 `feedback_test_spy_mock_lifecycle.md` 子节扩
- 「workspace root 资源唯一归属 enforce」N=1 首发 / 推 r97+ 同型 cross-cutting resource singleton 再现升格
- 「sub-agent 0 自承红旗」N=4 实证累
- 「vitest threads pool env race」首发 N=1 / 推 r97+ N=2 升格寻


## §A.tools-barrel-toolregistry-cascade — closed by phase 710

- **claim**：foundation/tools `ToolRegistry` 14 cross-module caller / 9+ 走 barrel + 5 走 sub-path types.js/executor.js / contract/* 4 file cluster 整体走 sub-path
- **resolution**：4 contract/* + 1 step-executor/types.ts cascade 走 barrel / 9+ 既有 barrel caller 不动 / library re-export `src/index.ts:25` 推 r97+
- **28 原则**：α 5/5 dominant（M#7 + M#8 + M#9 + YAGNI + 抗腐）

## §A.llm-provider-presets-cli-cascade — closed by phase 710（β 可选）

- **claim**：3 cli file (start/config/init) 走 sub-path `presets.js` / barrel L26-28 已 re-export PRESETS
- **resolution**：3 import 路径改走 barrel / 0 行为差

## §升格寻 N=2 达成 — phase 710

- 「caller 风格不统一 / 同 export mixed barrel+sub-path」NEW feedback 立 `feedback_caller_style_mixed_same_export.md`
- N=1 phase 707 + N=2 phase 710 = N=2 升格阈值达 / 配套 3 既有 barrel feedback 形成完整 cluster

## phase 715 — r97 D fork design row drift + src/ error taxonomy fan-out（2 sub-agent / 25 候选 / 0 自承红旗）

2 sub-agent 并行扫 design/ row drift 全栈重审 + src/ error taxonomy 深扫两维度。

**关键 stats**：
- 2 sub-agent 0 自承红旗（N=5+ 实证累 / r93-E + r94-D + r95-D + r96-D + r97-D）
- 25 候选 / Tier 1 land 1 src mechanical（R2-P2.1 FileNotFoundError instanceof 2 site）+ 5 design row state lag fix
- 1 phantom REJECT（D1-P2.2 stream-zero-chunk row 实际已 closed by phase 637 / sub-A 误读 status column）
- 1 ambiguous 推 r98+（D2-P2.1 snapshot consecutiveFailures row 状态语义混乱 / 需 src 实然 + design intent 复核）
- Tier 2 大头 convention 决策推 r98+：peekMetas Result ADT（≥ 30 phase 真 open）+ dual hierarchy + error taxonomy convention 决策树 + saturate-tier hygiene

**关键判据**：
- DP「事后凭日志重建」+ ML M#3「资源唯一归属」+ M#7「耦合界面稳定」推 error class 单 hierarchy + typed payload
- design row state lag = 「实然已变 / 应然未跟」反向 phase 663 ToolProfile 模板（src 漏删 → row 漏 closed）
- 大头 convention 决策需 user 拍板（不是 28 原则可 derive）→ 推 r98+ 业务决策三段式

### design row state lag fix 5 处 closed by phase 715

| ID | file | row | state lag fix |
|---|---|---|---|
| D1-P1.1 | l1_file_watcher.md:195 | V4-P1.2 标题「（推 user）」尾缀 | 删尾缀（body 已 closed by 703）|
| D2-P1.1 | l2_process_manager.md:156 | manager.ts 升 §A 必修 | ✅ closed（实然 76 行 + 14 sub-file 拆分完成）|
| D2-P1.2 | l1_filesystem.md:142 | permissions.ts narrative | closed by phase 430 同步 |
| D2-P1.3 | l2_llm_orchestrator.md | json-parse-tool-args | ✅ closed（β callback 已实施 / `openai-response-parser.ts:63,92`）|
| D2-P2.2 | l2_messaging.md:160 | L2c.G5 notify.ts:19-27 ref | re-anchor inbox-writer.ts:78 |

### 1 phantom REJECT

- **D1-P2.2** l2_llm_orchestrator.md B.stream-zero-chunk-breaker-sensitivity / sub-A claim「row 仍立『业务方向决策性 / 用户 binary 拍板待』」/ Path #1 实测 status column 实际已 `✅ closed by phase 637` / sub-A 混淆 trigger 描述列（含「业务方向决策性」历史 context）与 status column / **phantom REJECT**

### 1 推 r98+ ambiguous

- **D2-P2.1** l2_snapshot.md consecutiveFailures per-instance row / heading strikethrough（视觉 closed）+ status「升 §A 必修」（文本未跟）/ src 实然仍 per-instance / **ambiguous**：(a) design intent 改为 per-instance acceptable / 但 status 未跟 (b) 真升档 / 但 src 未修 / 推 r98+ 主会话核 src + design intent 后定

### 推 r98+ 显式登记

#### 业务决策真 user 拍板（≥ 30 phase 真 open）

- **D1-P2.1 peekMetas Result ADT**（l2_messaging.md L2c.G2 / phase 567 立 dominant α / 实际未推进 30 phase / 真 user 拍板必要 / 非 28 原则 derive）

#### error taxonomy convention 决策树（mirror phase 706 audit key 模板）

- **R2-P1.1 dual hierarchy**：ClawError (12) vs 裸 Error (5) 统一 vs 保现状（α/β/γ + 28 原则核 + 主会话预期 + 待 user 拍板）
- **R2-P1.2 code 字段 3 种含义**：ErrorCode enum / literal / number / errno 是否统一
- **R1-P1.2 + R1-P2.1 Result vs throw**：fs read throw vs inbox meta Result 跨模块一致性
- **R3-P2.1 cause 3 模式**：ctor cause / Error options cause / 自定义 field
- **R3-P3.2 errorType audit**：constructor.name vs ErrorCode enum

→ 推 r98+ 单独 phase / error taxonomy convention 决策树立（mirror phase 706）

#### saturate-tier hygiene

- **R2-P3.1** 命名 suffix 3 变体（Error/Failed/Unavailable / 推 r98+ same root sweep）
- **R3-P3.1** message 格式自由文本 / 0 结构化（推 r98+ design row 决策）
- **D2-P2.1** snapshot consecutiveFailures row（推 r98+ 主会话核 src + design intent）

**升格信号**：
- 「design row state lag cluster」N=1 首发（cross-module 5 row）/ 推 r98+ 同型再现 N=2 升格独立 sub-pattern
- 「sub-agent 0 自承红旗」N=5+ 实证累
- 「peekMetas Result ADT 真 30+ phase 真 open」首发 / 业务决策真 limbo
- 「error taxonomy convention 决策树」N=0 推 r98+ 立 N=1 后 N=2 升格
- 「sub-agent 误读 status column」首发 N=1（D1-P2.2 phantom / sub-agent 混淆 trigger 描述列与 status 列 / 推 r98+ 同型再现 N=2 升格寻 prompt 防御加强 status column 显式 quote）

## Error taxonomy 治理实践（2026-05-11 / phase 720 r98 B fork 28 原则 derive 全 β dominant）

r97 D fork phase 715 浮 3 项 error handling taxonomy 业务决策 / r98 B fork phase 720 28 原则 derive 全 β dominant 保现状 + design 文档化。元判据：**「现有 split 是 design intent / 不是 inconsistency」**。

### Error 形态分流判据（business vs infrastructure）

clawforum 同时存在 2 类 error class hierarchy：

| 形态 | 实证 | scope |
|---|---|---|
| **ClawError 子类**（business domain） | `src/types/errors.ts` 单 file / 7 subclasses（PermissionError / ToolError / LLMError / FileNotFoundError / MaxStepsExceededError / ConsecutiveParseErrorsExceededError / ConsecutiveMaxTokensToolUseError）| L3+ business runtime |
| **裸 Error 子类**（infrastructure / domain）| 7 classes scattered（MarkerNotFoundError / LockConflictError / InboxListFailed / InboxMoveFailed / ProcessExecError / ProcessListUnavailable / CliError）| L1/L2 foundation + cli |

**判据**：
- L3+ business runtime error → `extends ClawError`（统一 ErrorCode enum + context + timestamp + toJSON）
- L1/L2 infrastructure / domain-specific error → `extends Error`（各 module 自治 / ad-hoc fields 允许）
- CliError 特殊：含 `code: number`（exit code 语义 / NOT ErrorCode enum）

**Why**（28 原则 derive）：
- M#1 业务唯一：business 与 infrastructure 自然 split
- M#5 依赖单向：L1/L2 不上抛 business taxonomy
- M#7 接口稳定：现 split 已稳 / 强统一 = 编译期 cascade + ad-hoc 字段兼容破坏
- M#9 编译器优先：ClawError discriminated by code: ErrorCode / 裸 Error 各 own typed structure
- YAGNI：7 NEW ErrorCode values + 7 caller cascade / 0 真业务收益

**反模式**：
- ❌ 把 infrastructure / domain-specific error 强统一到 ClawError（ad-hoc 字段如 exit code 不兼容 ErrorCode enum）
- ❌ 把 business runtime error 用裸 Error（丢失 ErrorCode discriminator + context 标准结构）

### `code` 字段三义分流（business / cli / OS）

`code` 字段在 codebase 中有 3 个 distinct 语义（不在同 caller 中冲突）：

| 含义 | 类型 | 实例 | owner |
|---|---|---|---|
| **ErrorCode** | `'PERMISSION_DENIED' \| 'FS_NOT_FOUND' \| ...` 14 enum | ClawError subclass | L3+ business |
| **Exit code** | `number = 1` | CliError | CLI 层 process termination |
| **OS errno** | `'ENOENT' \| 'EADDRINUSE' \| 'EEXIST' \| ...` | NodeJS.ErrnoException | OS layer |

**判据**：3 owner 不重叠 / consumer 也各异 / 不强统一。边界 catch（如 fs.ts catch ENOENT 抛 FileNotFoundError(code='FS_NOT_FOUND')）= explicit 翻译 / 不算冲突。

**Why**：
- M#1 业务唯一：3 含义各 own domain
- M#7 接口稳定：强统一会跨边界破坏（ErrorCode union 加 number/errno → 类型 cascade）
- M#8 耦合最小：不强行 cross-domain 标准化

**反模式**：
- ❌ ErrorCode enum 加 number / errno values
- ❌ 在 ErrorCode consumer 直接读 errno code 不翻译
- ❌ 在 CliError 上加 ErrorCode 字段（exit code 与 business categorization 是 2 个 concern）

**boundary 模板**（fs.ts pattern）：
```ts
try { /* fs.access */ }
catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(...);
  throw e;  // bubble unexpected
}
```
→ catch errno → wrap ErrorCode / consumer 仅看 ErrorCode。

### Error 形态选择：Result.err vs throw

判据 formalize from `src/foundation/snapshot/snapshot.ts:7-10` docblock：

| 场景 | 形态 | 实证典范 |
|---|---|---|
| **Expected + degraded path**（业务设计中预期失败 + 有 degrade 逻辑）| `Result.err<E>` | snapshot.ts: git commit 失败但 degraded audit + 不 block |
| **Unexpected / bug-class / 调用方应中断**（不可继续业务）| `throw new Error/ClawError/...` | fs.ts: FileNotFoundError / PermissionError / 174+ sites |

**Why**：
- DP「不得静默忽略」: 两形态都防 silent
- DP「状态可观察」: Result.err 显式 degraded 分支 / throw 显式 fail-fast
- M#5 依赖单向: 上层 catch unexpected throw / Result.err 强迫显式 .ok 检查

**判据**：
- 业务设计中**预期**该 path 可能失败 + 有明确 degraded 处理（如 snapshot degraded → audit + 不 block）→ `Result.err`
- 失败是 bug-class / **不可恢复** / 上层应 fail-fast 或 unwrap caller → `throw`
- 不确定时优先 `throw`（M#5 顺势 / Result.err 是显式 design opt-in）

**反模式**：
- ❌ 把 unexpected failure 包成 Result.err（silent / 调用方可能漏 .ok 检查）
- ❌ 把 expected degraded path 用 throw（强迫上层 try/catch 但语义不是 fail-fast）
- ❌ 同 module 内 mix 两形态而无 docblock explicit（caller 不知如何 handle）

**实证数据点**（phase 720 实测）：
- `throw new` 174 sites = unexpected / bug-class 主导
- `Result.err` 14 sites = expected degraded path（snapshot 主 / 其他模块视情）
- 现 split 已稳 / 不强统一 / per snapshot.ts:7-10 模板

### 元判据

3 子节有同一元判据：**「现有 split 是 design intent / 不是 inconsistency」**。

r98 dispatch §B claim 「12+5 ClawError vs 裸 Error / 4 含义 code / 无 Result vs throw 判据」是 anticipated α 改造视角 / Path #1 实测 derive 结论 β 保现状 / split 是合理的业务 / infrastructure / domain 自然分布。phantom claim 推翻：
- ClawError 7 vs 裸 Error 7（dispatch 12+5 数差异）
- code 3 含义 not 4（string literal 0 命中）
- Result vs throw 判据已 derive 自 snapshot.ts:7-10（dispatch claim 「无判据」STALE）

## phase 719 — r98 D fork src/ 性能 hot path + tests/ 覆盖深度 fan-out（2 sub-agent / 30 cluster / 0 自承红旗）

2 sub-agent 并行扫 src/ 性能 hot path（hot loop / sync I/O / N+1）+ tests/ 覆盖深度（分支 / 弱断言 / 误差容忍）两维度。

**关键 stats**：
- 2 sub-agent 0 自承红旗（N=6+ 实证累 / r93-E + r94-D + r95-D + r96-D + r97-D + r98-D）
- 30 cluster 候选 / Tier 1 land 1 cluster（C2-P2.1 dispatch.test.ts 4-5 site strengthen / 0 src 改）
- Sub-A 14 perf candidate 0 升 P0（0 latency metric evidence / 体现 sub-agent discipline）
- Sub-B 50+ site cluster 推 r99+ 弱断言 silent X 治理
- 「并发 phase claim 冲突 → atomic re-claim」N+1（phase 718 让 C fork / phase 719 重 claim）

**关键判据**：
- DP「不得静默忽略」+「状态可观察」推 strengthen `toHaveBeenCalled()` → `toHaveBeenCalledWith(...)` / 防 contract payload silent drift
- 「sub-agent 不升 P0 除非 latency metric 证据」discipline 保 perf hygiene 不被误升真 P0
- 「破坏性档位 4 档」per r98 A spec / 本 fork = **无破坏档**（test only + design only）

### Sub-A perf hot path top 3 ROI（推 r99+ 单独 perf phase / 0 latency baseline 现不修）

| ID | site | 优化方向 | 影响范围 |
|---|---|---|---|
| H1-P3.1 | `cron/jobs/llm-stats.ts:104-107` | per-row closure 提升 / cols 预扫 Map | cron scan / 10k+ row audit |
| H2-P3.1 | `stream/reader.ts:142-143` | `existsSync` + `statSync` 合并 single statSync + ENOENT catch | hot path / 每 event 减 1 syscall |
| H3-P1.2 | `contract/discovery.ts:31-38` | `await fs.exists()` + `await fs.read()` N+1 → try-read 单 syscall | listActive 每 dir N+1 → N |

**前置**：r99+ phase 须先建 latency benchmark / 测改前 baseline + 改后对比 / 0 baseline 不修。

**design row stable**：
- H2-P2.1 `stream/writer.ts:60` appendSync — crash safety design intent / 不改
- H3-P2.1 task-recovery `await exists` short-circuit — 现 form OK

### Sub-B 弱断言 cluster 推 r99+

**silent X 弱断言 cluster**（推 r99+ N=2 升格独立 sub-pattern）：
- C2-P2.1 dispatch.test.ts 4-5 site（**本 fork Tier 1 land**）
- C2-P2.2/2.3/2.4 subagent-executor + contract-review-request + runtime-regime-switch（推 r99+ N=5 site）

**batch cluster 推 r99+**：
- C2-P1.1 contract_manager toBeTruthy ×6 / C2-P1.2 task-system-tool match ×9 / C2-P1.3 chat-viewport match ×9
- C3-P1.2 files.length>0 ×15（phase 680 同型扩 / 残 ~15 site）
- C3-P1.1 cleanup/throw/escalation length>0 ×3（已有 retry-dependent 注释）

**接受现状 stable**：C3-P1.4 elapsed>=0 / C3-P1.5 throwTs>0 / C3-P1.6 dialog.json$ partial（无害）

### 与 phase 695/703/706/711/715 关系

- phase 695 sub-agent fan-out 浮 row 推 user
- phase 703 28 原则 derive dominant 自决 land
- phase 706 audit key naming convention 决策树立
- phase 711 ML M#3 资源唯一归属 + spy lifecycle 双 anti-pattern
- phase 715 design row state lag cluster + error taxonomy convention 决策树草稿
- **phase 719 perf hot path + 弱断言 silent X cluster（推 r99+ 决策树）**
- 六 phase 同模板：fan-out → spot-check → Tier 1 mechanical 收敛 + 业务决策 + 决策树推 r99+

### 与 5 kit umbrella 关系

- silent_x_audit_kit §2 audit 注入 α：N+1 实证（C2-P2.1 dispatch / 弱断言是 audit 的下游静默风险）
- design_ratify_kit §3：N+1 实证（perf 优化 ROI vs latency baseline 需 user 决定）
- dispatch_verification_kit §1：sub-agent prompt 防御 N=6+ 实证累
- refactor_helper_kit §1：跨文件抽 helper（Sub-B 弱断言 cluster batch）

**升格信号**：
- 「test 弱断言 silent X 风险」N=1 首发（C2-P2.1）/ 推 r99+ N=2 升格独立 sub-pattern
- 「sub-agent 0 自承红旗」N=6+ 实证累
- 「fan-out hygiene / 0 perf 真 P0 discipline」首发 N=1 / 推 r99+ benchmark phase 建 latency baseline 后再核
- 「破坏性档位 4 档应用」首发 / 推 r99+ 同型再用 N=2 升格 spec feedback active
- 「并发 phase claim 冲突 → atomic re-claim」N+1 实证

### 推 r99+ 显式登记

- **perf phase**：先建 latency benchmark baseline / 再选 top 3 ROI 兑现
- **test 弱断言 silent X cluster phase**：mirror phase 706 audit key 决策树模板 / dominant N=5+ site
- **test 弱断言 batch phase**：3 file-level cluster + phase 680 同型扩 ~15 site
- **D2-P2.1**（r97 留）snapshot consecutiveFailures row 状态语义复核（推 r99+ 主会话核 src + design intent）
