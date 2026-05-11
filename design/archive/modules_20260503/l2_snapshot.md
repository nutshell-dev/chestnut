# Snapshot 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11,§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2a.md](../interfaces/l2a.md) Snapshot 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §7「Snapshot 本质：目标目录的版本化快照服务 / L2 通用基础设施 / 把版本化快照能力封装成可重用基础服务 / 多模块共用 / 自己不知任何业务语义」加 M#1 / M#2 / M#3 / M#4 / Design Principle「中断可恢复」加「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Snapshot 的单一职责 = **目标目录版本化历史的统一管理入口**：

- **目录版本化能力**：init 加 commit 操作 / 把目标目录的历史状态固化为版本序列 — 这是「中断可恢复」加「事后可审计」原则要求的目录历史持久化（具体实现可用 git / 其他 VCS / 不暴露给调用方）。
- **失败语义二分**：预期失败（无变更加锁冲突等）返结构化结果 / 不可预期失败（exec 异常加磁盘满加仓库损坏）抛错 — 调用方顶层决策。
- **连续失败累计告警**：连续失败达阈值触发 audit 降级告警（D2「不丢弃 / 静默」derive — 重复失败不静默）。
- **commit 频率加触发时机由调用方决定**：本模块仅暴露 commit 能力 / 不内化触发策略。

> 具体 API 形态归 [interfaces/l2a.md](../interfaces/l2a.md) Snapshot 节。具体实现细节（git / .git 目录加 `add .` / `git commit -m` / shell 注入防御 / 等）的存在依据是「VCS 版本化原语 + 实现细节」— 实然采纳的 git 实现差异加 dir 参数双重身份等登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / dialog / 业务目录语义）— derive 自 M#2 业务语义归属（Snapshot 业务语义仅版本化级）加 M#5 单向依赖
- **不 own 业务级回滚策略**（回滚到哪个版本加何时回滚归调用方决定）— derive 自 M#2
- **不 own 提交触发频率**（轮级 commit 加 daemon-start commit 等触发归调用方决定）— derive 自 M#2
- **不 own commit message 约定**（`turn-${n}` 加 `recovery-snapshot` 等约定由调用方自订 / 本模块原样写入）— derive 自 M#2
- **不 own 跨模块 ignore 清单**（`.gitignore` 内容由 L6 Assembly 聚合注入 `ignorePatterns: readonly string[]` / 本模块不内化字面量）— derive 自 M#5 + M#9 显式表达
- **不 own 历史查询加回放接口**（`checkout / reset / diff / log` 等不暴露 / 消费者经 git 直接查 commit 序列）— derive 自 M#1 独立可变职责
- **不 own commit 作者 / 时间策略化管理**（固定身份 / 由本模块自治）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Snapshot 的业务语义边界：

- **own**：目录版本化概念 — init 加 commit 加 commit 序列加失败语义二分。这些是 Snapshot 唯一懂的「业务」（VCS 版本化级，不是 clawforum 业务级）。
- **角色定位**：Snapshot 是「**通用版本化服务**」非「**业务回滚决策器**」。多 caller 经统一 API 消费 / 各 caller 在自己的业务域决定回滚策略加触发时机。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Snapshot 独占的资源：

- **目标目录版本化历史状态**：clawforum 内部任何目录版本化必经 Snapshot 间接访问 — 是 clawforum 对「版本化历史 artifact」（实现为 `.git` 目录加 `.gitignore`）的唯一调用入口。
- **`<agentDir>/.git`**：版本化仓库 / 独占归属。
- **`<agentDir>/.gitignore`**：装配期写入的 ignore 清单 / 条目由 Assembly 聚合注入（M#9 跨模块 ignore 聚合显式经参数注入）。
- **运行期内存状态**：`consecutiveFailures` per-instance（重启即丢 / 但磁盘 commit 序列保留）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Snapshot 持久化整个版本化历史本身（commit 序列）— 是 clawforum 「事后可审计」加「中断可恢复」双原则的关键 artifact。

### 磁盘布局

```
<agentDir>/
├── .git/                      ← git 仓库（init 创建 / 独占归属）
│   ├── HEAD
│   ├── objects/
│   ├── refs/
│   └── config                 ← user.name=clawforum / user.email=clawforum@local
├── .gitignore                 ← Assembly 装配期写入聚合 ignore 条目
└── ...                        ← agent 工作目录其他文件（每轮 commit）
```

### 重建语义

- **进程重启**：`init()` 幂等 / `.git` 已存在直接返回 / working tree 变更下次 daemon 启动由 `recovery-snapshot` commit 固化
- **历史回放**：`git log` 是事后审计的权威来源 / 与 `audit.tsv` 形成双通道（详 §7.D D5）
- **commit 序列**：consecutiveFailures 是实例字段（重启即丢 / 但磁盘 commit 序列保留）

## 5. 审计事件清单

事件常量集中定义于 `SNAPSHOT_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `SNAPSHOT_INIT_FAILED` | init 失败 | `dir=`, `reason=` |
| `SNAPSHOT_INIT_CLEANUP_FAILED` | init 失败后清理 `.git` 也失败 | `dir=`, `reason=` |
| `SNAPSHOT_COMMITTED` | commit 成功 | `message=`, `sha=`, ... |
| `SNAPSHOT_COMMIT_FAILED` | commit 失败（预期 + 不可预期均触发）| `count=<consecutive>`, `reason=` |
| `SNAPSHOT_DEGRADED` | 连续失败达 `SNAPSHOT_DEGRADE_AFTER` | `count=N`, `dir=` |

> audit 是**观察通道** / 不替代失败处理通道。失败信息仍必须沿调用链回到能做决策的消费者（Runtime 事件循环顶层 / Daemon 启动流程）。

## 6. 层级声明

L2 通用基础设施层（与 AuditLog / ProcessManager 同子层 / agent 目录版本化原语 / 不预设业务模块 / 自己不知任何业务语义）。下游 Runtime（轮级 commit）+ Daemon（启动期 init+commit）+ CLI 通过 createSnapshot 工厂消费。详见 [architecture.md](../architecture.md) 加 [interfaces/l2a.md](../interfaces/l2a.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 init 清理 `.git` 失败静默 | drift | 已闭环（phase148）| 升级为 `audit.write(SNAPSHOT_INIT_CLEANUP_FAILED)` |
| A.2 commit 连续失败 <3 次 console.warn | drift | 已闭环（phase148）| 升级为 `audit.write(SNAPSHOT_COMMIT_FAILED, count=)` |
| A.3 commit 连续失败 >3 次每次 console.error 沉默 | drift | 已闭环（phase148）| 每次仍 audit / 不静默 |
| A.4 commit 成功无 audit | drift | 已闭环（phase148）| `audit.write(SNAPSHOT_COMMITTED, message=)` |
| A.5 audit 可选 | drift | 已闭环（phase148）| 构造期必传 / 不提供 NoopAudit / 测试用 InMemoryAudit |
| A.6 commit 永不抛错（基础设施越权做业务决策）| drift | 已闭环（phase150+）| 预期失败返 result / 不可预期失败 throw / 消费者顶层决策 |
| A.7 跨模块资源名硬编码（`GITIGNORE_CONTENT`）| drift | 已闭环（phase150+）| `ignorePatterns: readonly string[]` 构造期注入 / Assembly 聚合 / Snapshot 不内化字面量 |
| 契约 drift #4 CommitResult 类型 | 文档 drift | 已修订（r44 A）| 原契约登记 `{ ok: true; sha } \| { ok: false; reason }` / 实然 phase150+ 为 `Result<void, ExpectedGitFailure>`（无 sha / error 结构不同）/ 应然采纳实然形态（应然不要求 sha）|
| 契约 drift #3 addIgnorePattern API 形态 | 文档 drift | 已修订（r44 A）| 原契约登记 `addIgnorePattern(pattern: string): void` method / 实然实施为 constructor 第 4 参 / 应然采纳 constructor 注入形态 |
| 契约 drift #5 GITIGNORE_CONTENT 常量 | 文档 drift | 已修订（r44 A）| 实然 phase150+ 删 `GITIGNORE_CONTENT` / 改 `DEFAULT_IGNORES`（内部）+ 消费侧 `SNAPSHOT_IGNORE_PATTERNS` |
| ~~modules.md drift 历史登记~~ | drift | **✅ closed（phase321）** | / |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `SNAPSHOT_DEGRADE_AFTER = 3` 阈值 magic number | 应然 silent / 实然硬编码 / 仅阈值点触发一次 / 后续静默防噪 | 阈值需配置化或 dir 级聚合时 |
| `user.name` / `user.email` = `clawforum` 硬编码 | 应然 silent / 实然硬编码 | 需多环境配置或多用户 |
| 模块名「Snapshot」承诺 vs 实然只有 init+commit（缺 rollback / list / diff）| 名字承诺 > 接口承诺 | 消费者出现回溯需求 / 选项：重命名为 `CommitLog` / `GitJournal`，或补回溯接口 |
| ~~`consecutiveFailures` per-instance 状态分裂~~ | ~~实例局部字段~~ | **升 §A 必修**（design verify 真 deep 后升档 / r60+ Meta 33 候选）/ 应然单实例约束 vs 实然多实例化 真 contradiction / 修复路径推 r51+ design phase：(a) per-dir 模块级 Map 聚合（共享失败计数）/ (b) per-dir 单例工厂（防多实例化）/ Assembly 装配期保证 single instance per dir |
| Motion per-agent audit 隔离（独立 motionAudit）| phase148 装配期决策 / 双 audit 实例按业务域切分 | 未来 per-claw subagent 装配可沿用 |
| **`'snapshot_commit_failed'` 字符串值跨 3 namespace**（owner 视角 / 与 `l5_runtime` `RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED` + `l6_daemon` `DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED` 共享）| 协议约定 / caller 视角本地 alias / **不是** phase380 反向命中（同字符串同概念跨视角 / 反向实测不命中首发）⚓ accepted-stable（phase391 / β-final / α 抽共享拒 + γ 分化字符串拒 / 详 `coding plan/phase391/Phase 391 设计裁决.md`）| 升档三选一：(a) 第 4 处 namespace 共享 / (b) 字符串值 drift（grep 巡检发现）/ (c) snapshot.ts:147 `throw rawErr` 改为内部写 audit 时 EXTERNAL 仅剩 programmer-throw 语义 → 事件语义实质分化 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：单一职责 = agent 目录 git commit 历史序列化
- **M2 业务语义归属**：init / commit / 失败处理由 Snapshot 发起 / 消费者不代理 git 命令
- **M3 资源归属**：`.git` 目录归 Snapshot 独占 / grep 核字面量仅 snapshot.ts
- **M4 持久化**：**驱动原则**（每轮 commit 固化 / 是「持久化一切 agent 状态」实现者）
- **M5 依赖单向**：Snapshot → L1 FileSystem + L1 ProcessExec + L2 AuditLog（per arch §7 表 1）/ 0 反向
- **M6 依赖结构稳定**：constructor 4 参（dir / fs / audit / ignorePatterns）/ phase150+ 稳定
- **M7 耦合界面稳定**：Snapshot 3 方法 + createSnapshot 工厂 + SNAPSHOT_IGNORE_PATTERNS 常量
- **M8 耦合界面最小**：API 表面极小（init / commit / 工厂）
- **M9 显式表达编译器可检**：`dir: string` 既是 baseDir 又是 git cwd / 两者一致约束靠运行期校验（tsc 不可检 / 修复方向：`AgentDir` branded type / 未触发观察）
- **M10-M11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：所有失败经 audit event 留痕 / A.6 后额外抛 Error(cause) 给消费者
- **D1b 状态可观察**：SNAPSHOT_COMMITTED / COMMIT_FAILED / DEGRADED 覆盖主要状态转移
- **D1c 中断可恢复**：**驱动原则**（重启后 recovery-snapshot commit 固化 working tree 变更）
- **D1d 事后可审计**：**驱动原则**（git log + audit.tsv 双通道重建）
- **D2 不得丢弃/静默**：phase148 + A.6 闭环
- **D3 用户可观察**：audit event + git log 可查
- **D5 日志重建**：**驱动原则**（Snapshot + AuditLog 并列「单一事实源」实现者）
- **D7 系统可信路径**：git 参数单引号包裹 + `'\\''` 转义防 shell 注入
- **D8 事件驱动**：受信组件
- **D9 多 claw 不隔绝**：灰度（每 agent 独立 .git / 跨 agent 无 snapshot 聚合）
- **D10 motion 特殊**：Motion 装配期用独立 motionAudit（B 类登记先例）
- **D4 / D6 / D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：**驱动原则**（Snapshot 固化「agent 目录 = agent 状态」核心抽象的历史时间轴）
- **P2 上下文工程**：Snapshot 是「事后可重建 context」的最终保障
- **P3 分多个智能体加分子任务**：每 agent 独立 snapshot
- **P4 系统为智能体服务**：Snapshot 为 agent 失败/重启提供 safety net

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase148 / phase150+ / phase196 / phase321 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- phase148：A.1-A.5 闭环（清理失败 audit / commit 失败 audit / 成功 audit / audit 必传）
- phase150+：A.6 commit 失败语义重构（预期返 Result / 不可预期 throw / consumer 决策）+ A.7 ignorePatterns 装配期注入
- phase196：契约 backfill 5 条 drift 一次捕获（CommitResult / addIgnorePattern / GITIGNORE_CONTENT 等）
- phase321：modules.md 索引 IAuditSink drift 修订
- r44 A：契约重写消化 phase196 登记的契约 drift（addIgnorePattern → constructor / GITIGNORE_CONTENT → SNAPSHOT_IGNORE_PATTERNS / CommitResult 类型签名待校）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2a.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#19 Snapshot 轮级快照（一轮执行结束后触发 / 不每步触发）| ✓（平衡历史可回滚 vs 性能开销）|
| KD（应然）.gitignore 条目 Assembly 聚合注入 / Snapshot 不内化字面量 | ✓ phase150+ 闭环 |
| KD（应然）commit 失败二分（预期 result / 不可预期 throw）| ✓ phase150+ 闭环 |
| KD#4 CommitResult 文档形态 | ⚠ 文档 drift（待 §7.A 修订实然为准）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **init 路径**：`.git` + `.gitignore` 创建 / 幂等 / 失败后清理 `.git` / 清理失败 audit
- **commit 路径**：无变更跳过 / 正常成功 audit / 失败 audit count / 连续 3 次 audit DEGRADED / >3 次每次仍 audit
- **失败二分**：预期失败返 Result（`no_changes` / `git_lock_held`）/ 不可预期失败 throw + audit
- **构造**：audit 必传 / ignorePatterns 注入
- **审计事件回链**：每个 §5 事件应有触发时机+载荷断言
- **状态分裂**：B 类登记 `consecutive failures isolated per instance` 测试是**正面固化** / 修复 per-dir 状态时需反转语义

> **B 类状态分裂修复后** / 需补：同 dir 多实例**共享**失败计数（与当前测试相反）+ per-dir 模块级聚合断言。
