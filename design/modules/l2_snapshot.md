# L2 Snapshot 对外接口契约

## 1. 概述

对 agent 目录执行 `git init` 与 `git add . && git commit`，把 agent 工作目录的历史状态固化为可回滚的 git commit 序列。资源是 agent 目录下的 `.git`。消费者是 Runtime（每轮 agent 执行结束 + session-repair 后触发 commit）、Daemon（启动时 init + recovery-snapshot + daemon-start）、Motion 命令（首次 init）。

Snapshot 是「事后可审计」「中断可恢复」的正面实现：每轮 LLM 交互完 commit 一次，中断后的 working tree 变更在下次 daemon 启动由 `recovery-snapshot` 固化，事后通过 git log 可完整重建任一时刻的 agent 目录状态。

## 2. 职责边界

**做**：
- `init()`：幂等创建 `.git`（已存在则直接返回），写 `.gitignore`，配置 `user.name=clawforum` / `user.email=clawforum@local`，空 commit 奠基
- `commit(message)`：`status --porcelain` 判空则跳过；否则 `add .` + `commit -m`
- commit 失败累计计数（连续 3 次触发 `snapshot_degraded` audit），成功即清零
- git 参数全单引号包裹（防 shell 注入）

**不做**：
- 任何 git 其它命令（checkout/reset/diff/log 等均不暴露；消费者无法经此接口走历史查询）
- commit 作者/时间的策略化管理（固定身份）
- `.gitignore` 内容动态维护（硬编码 `GITIGNORE_CONTENT` 常量，**见 A.7**）
- 快照回溯（模块名是 Snapshot 但无 `rollback/list/diff` 接口，**见 B 类**）

## 3. 接口

```ts
type CommitSkipReason = 'no_changes' | 'git_lock_held';

type CommitResult =
  | { ok: true; sha: string }
  | { ok: false; reason: CommitSkipReason };

class Snapshot {
  constructor(dir: string, fs: FileSystem, audit: Audit);
  init(): Promise<void>;                               // 不可预期失败抛出（磁盘/权限/git 不存在）
  addIgnorePattern(pattern: string): void;             // A.7 修复：装配层注入，不硬编码跨模块字面量
  commit(message: string): Promise<CommitResult>;      // 预期失败返 { ok: false, reason }；不可预期失败抛出
}
```

关键约定：
- `commit` 预期失败（git 已知错误码：无变更 / 锁冲突）→ `{ ok: false, reason }`，调用方必须 switch 分支
- `commit` 不可预期失败（exec 异常 / 磁盘满 / git 可执行不存在 / `.git` 损坏 / fs I/O 异常）→ 抛 `Error`（带 `cause`），由消费者顶层 catch 决策（continue / shutdown / 升级告警）
- audit 是**观察通道**（持续 emit `SNAPSHOT_COMMITTED` / `SNAPSHOT_COMMIT_FAILED` / `SNAPSHOT_DEGRADED`），不替代失败处理通道
- `consecutiveFailures` 计数仍在实例内部维护；达 `SNAPSHOT_DEGRADE_AFTER` 时 emit `SNAPSHOT_DEGRADED`（见 B 类状态分裂）

### 工厂（装配期入口）

`src/foundation/snapshot/index.ts` 导出 `createSnapshot`，是 Assembly / Runtime 装配期的推荐构造入口：

```ts
export function createSnapshot(
  dir: string,
  fs: FileSystem,
  audit: Audit,
  ignorePatterns: string[],
): Snapshot;
```

**行为承诺**：构造代理；与 `new Snapshot(dir, fs, audit, ignorePatterns)` 完全等价——
- 不缓存、不单例：每次调用返回新实例
- 不注入默认值（默认归 ctor 本身）
- 不做参数校验 / 不触发副作用

装配方应通过工厂而非 `new` 构造，以便未来依赖组合扩展时单点修改。

## 4. 失败语义

| 场景 | 当前行为 | 分类 |
|---|---|---|
| `init` 失败（git init 报错等） | `audit.write(SNAPSHOT_INIT_FAILED, reason=...)` + 尝试 `removeDir('.git')` | ok |
| `init` 清理 `.git` 失败 | `audit.write(SNAPSHOT_INIT_CLEANUP_FAILED, reason=...)`（Phase 148 已修复，原 `try{}catch{}` 字面静默） | A.1 已修复 |
| `commit` 失败连续 <3 次 | `audit.write(SNAPSHOT_COMMIT_FAILED, count=<n>, reason=...)`（Phase 148 已修复，原 `console.warn`） | A.2 已修复 |
| `commit` 失败连续 =3 次 | `audit.write(SNAPSHOT_COMMIT_FAILED, ...)` + `audit.write(SNAPSHOT_DEGRADED, ...)` | ok |
| `commit` 失败连续 >3 次 | `audit.write(SNAPSHOT_COMMIT_FAILED, count=<n>, ...)` 每次继续（Phase 148 已修复，原 `console.error` 无新 audit） | A.3 已修复 |
| `commit` 成功 | `audit.write(SNAPSHOT_COMMITTED, message=...)` 正面事件 + 重置 `consecutiveFailures=0`（Phase 148 已修复） | A.4 已修复 |
| `audit` 未注入 | 不可能——构造器必传（Phase 148 已修复）| A.5 已修复 |
| `commit` 预期失败（无变更 / git 锁冲突）| 返 `{ ok: false, reason: 'no_changes' \| 'git_lock_held' }`；audit 仍 emit `SNAPSHOT_COMMIT_FAILED`（观察通道）| A.6 修复方向 |
| `commit` 不可预期失败（exec 异常 / 磁盘满 / git 不存在 / `.git` 损坏 / fs I/O）| audit emit `SNAPSHOT_COMMIT_FAILED` 后抛 `Error`（带 `cause`）；连续 ≥ `SNAPSHOT_DEGRADE_AFTER` 次追加 `SNAPSHOT_DEGRADED` | A.6 修复方向 |
| `init` 不可预期失败（含清理 `.git` 失败）| audit emit `SNAPSHOT_INIT_FAILED` / `SNAPSHOT_INIT_CLEANUP_FAILED` 后抛 `Error`（启动期关键路径，消费者决定 abort）| A.6 修复方向 |

## 5. 不可消除的耦合

- **`.gitignore` 内容是跨模块共享约定**（**违规，见 A.7**）：`GITIGNORE_CONTENT` 字面写死 `stream.jsonl / audit.tsv / logs/ / tasks/results/ / *.tmp`——这些是 Stream / AuditLog / Tasks 等其他模块的资源名，Snapshot 作为 L2 基础设施直接引用它们的字面量，违反「资源只归属唯一模块」「耦合界面稳定」。
- **commit message 约定**：Runtime / Daemon 侧分别写入 `turn-${n} <iso>` / `recovery-snapshot` / `daemon-start <iso>` / `session-repair tools=${n}`。消息格式是消费者自订，Snapshot 不约束，但后续任何「基于 commit message 识别事件类型」的工具会依赖此约定。登记在消费者侧；Snapshot 契约仅承诺「原样写入」。
- **git CLI 平台依赖**：依赖系统 `git` 命令，非语言原生；若目标环境无 git，Snapshot 完全不可用。
- **`dir` 参数即 cwd**：Snapshot 构造期传入的 `dir` 既是 FileSystem baseDir，也是 git 命令的 cwd。两者必须一致才能正确定位 `.git`，此耦合在类内通过单一字段 `this.dir` 显式表达 ✓。

## 6. 配置常量归属

- `GITIGNORE_CONTENT` 定义在 `snapshot.ts` 顶部——**归属错位**（见 A.7）：排除清单的"字符串容器"属 Snapshot，但每个条目的决策权属于被排除模块（Stream/AuditLog/Tasks）；当前硬编码把两层责任压在一处。
- `consecutiveFailures >= 3` 的降级阈值硬编码在 `commit()` 方法体。B 类：应抽 `SNAPSHOT_DEGRADE_AFTER = 3`，并显式登记「降级策略仅在正好第 3 次触发，第 4+ 次沉默」的显式设计决策（该决策当前隐含在 if 分支里，未在模块级声明）。
- user.name/email 硬编码 `clawforum` / `clawforum@local`。B 类。
- **`commit` 签名按失败分类拆分**：预期失败（`no_changes` / `git_lock_held`）走 `{ ok: false, reason }`，不可预期失败抛 `Error(cause)`。见 § 7 A.6。原"永不抛是显式决策"已推翻——L2 基础设施没有跨业务语境的容忍决策权。
- `SNAPSHOT_DEGRADE_AFTER = 3`：硬编码常量，降级告警仅在连续失败达阈值那次 emit，随后每次失败仍写 `SNAPSHOT_COMMIT_FAILED` 不重写 `SNAPSHOT_DEGRADED`（防噪）

## 7. 与现状的差异

### A 类（必修违规）

- **A.1（Phase 148 已修复）** — `init` 清理 `.git` 失败已从 `try {} catch { /* ignore */ }` 升级为 `audit.write(SNAPSHOT_INIT_CLEANUP_FAILED, reason=...)`。
- **A.2（Phase 148 已修复）** — `commit` 连续失败 <3 次已从 `console.warn` 升级为 `audit.write(SNAPSHOT_COMMIT_FAILED, count=<n>, reason=...)`，每次失败都有事件。
- **A.3（Phase 148 已修复）** — `commit` 连续失败 >3 次每次继续 `audit.write(SNAPSHOT_COMMIT_FAILED, ...)`，不再因越过降级阈值而静默。用户观察能力不随失败升级下降。
- **A.4（Phase 148 已修复）** — `commit` 成功写 `audit.write(SNAPSHOT_COMMITTED, message=...)` 正面事件，决策链路可直接从审计流重建而不依赖 git log 推断。
- **A.5（Phase 148 已修复）** — 构造器 `audit: Audit` 必传，去除 `audit?: Audit` 可选性。**不提供 NoopAudit 兜底** —— 测试应使用 `InMemoryAudit`（实现 `Audit` 接口、事件存内存数组供断言）。审计事件是行为契约的一部分，必须可断言。**注**：Phase 150 修 A.6 时，A.5 的"事件即唯一追溯"论证基础需重校（那时 audit 从唯一兜底降级为正面事件流，必传性仍成立但动机变化）。
- **A.6 — 基础设施越权做业务决策（修复方向已定，待实施）**。
  - **违规核心**：`commit` 承诺"永不抛"对**所有** git 失败一视同仁吞掉，把"业务可容忍"的判断权从消费者手里抢走。Snapshot 作为 L2 基础设施，没有当下业务语境（这次失败发生在 turn commit 还是 recovery commit 还是 daemon-start commit），**判断不了**该次失败是否可容忍。
  - **归入原则**：违反「底层模块不预设上层模块语义」—— Snapshot 预设了上层消费者"都能接受任意 git 失败"的语义，而这个语义应由消费者自己在当下业务语境里判定。
  - **原则冲突**：编码规范「预期失败由调用方显式处理，不可预期失败暴露而非吞没」要求把两类失败拆开：
    - 预期失败（git 已知错误码，如锁冲突、无变更）→ 不抛，返回 `{ ok: false, reason }` discriminated result，调用方必须 switch 分支
    - 不可预期失败（exec 异常、磁盘满、git 可执行不存在、.git 损坏）→ 抛 Error（带 `cause`）上浮，最终到消费者顶层 catch
  - **audit 不能替代抛出**：audit 是**额外观测通道**，不是失败处理通道。失败信息仍必须沿调用链回到能做决策的消费者（Runtime 事件循环顶层 / Daemon 启动流程）。当前把 audit 当唯一追溯途径是把观测和处理搅在一起。
  - **原"显式决策"判断推翻**：本契约早期版本（§ 6 末尾、原 § 7 C 类）把"commit 永不抛"描述为合规的显式决策，现修正为**越权**。消费者侧的容忍决策应长成：
    ```ts
    try {
      const r = await snapshot.commit(msg);
      if (!r.ok) audit.write('snapshot_commit_skipped', r.reason);
    } catch (err) {
      audit.write('snapshot_commit_failed', err.message);
      /* 消费者决定继续还是 shutdown */
    }
    ```
  - **修复连锁**：A.2（`<3 次 audit 沉默`）、A.3（`>3 次沉默`）、A.4（成功无 audit）在 A.6 修复后自然重写 —— audit 从"唯一兜底"降级为"正面事件流"，所有失败都通过抛出/返回被消费者看见，audit 只负责留痕。

- **A.7 — 跨模块资源名硬编码（修复方向已定，待实施）**
  - **违规核心**：`GITIGNORE_CONTENT` 硬编码 `stream.jsonl / audit.tsv / logs/ / tasks/results/ / *.tmp`——这些条目的决策来源是**其他模块**，Snapshot 作为 L2 基础设施无命名权却直接引用字面量。
  - **违反原则**：
    - 资源只归属唯一模块（Snapshot 绕过各模块直接知道其资源名）
    - 改一处不应连带改多处（任一模块改资源名须改 Snapshot 源码）
    - 不可消除耦合应显式表达，优先编译器可检查（字面量耦合无类型保护）
  - **修复方向**：
    1. Stream / AuditLog / SubagentSystem 各自 `export const IGNORE_PATTERN = '<本模块资源名>'`（Stream / AuditLog 已登记；SubagentSystem 待其契约补）
    2. Snapshot 新增 `addIgnorePattern(pattern: string): void` 接口（§3 已入 API）
    3. 装配层（Daemon / Runtime 启动流程）聚合注入：
       ```ts
       const snapshot = new Snapshot(dir, fs, audit);
       snapshot.addIgnorePattern(Stream.IGNORE_PATTERN);
       snapshot.addIgnorePattern(AuditLog.IGNORE_PATTERN);
       snapshot.addIgnorePattern(SubagentSystem.IGNORE_PATTERN);
       await snapshot.init();
       ```
    4. Snapshot 源码删除 `GITIGNORE_CONTENT` 常量；`*.tmp`（FileSystem 原子写副产物）改由 FileSystem 导出 `IGNORE_PATTERN`
  - **为何修复在装配层而非反向依赖**：底层模块（Stream/AuditLog）不得预设上层（Snapshot）语义；聚合责任落到"本就知道所有模块"的装配层，符合"依赖单向 + 显式表达"。

### B 类（偏差登记，不必修）

- 降级阈值 `3` magic number；应抽 `SNAPSHOT_DEGRADE_AFTER`，并显式登记「仅阈值点触发一次」的 semantics。
- user.name/email 硬编码。
- 模块名是 **Snapshot**（意味着「快照」的取/回/浏览），但接口只有 `init` + `commit`，缺失 `rollback/list/diff` 等回溯能力。当前消费者不需要，但**名字承诺 > 接口承诺**形成语义外溢。选项：重命名为 `CommitLog`/`GitJournal`，或补充回溯接口。
- **状态分裂风险**：`consecutiveFailures` 是实例局部字段。同一 agent `dir` 可被多个 Snapshot 实例管理（daemon.ts L183 一个 + runtime.ts L202 另一个同 dir 的新实例），两实例各自从 0 计数、彼此不知对方失败次数 → `snapshot_degraded` 告警可能永远达不到阈值。对照「可变状态应有唯一且明确的管理者」—— 当前管理者是实例而非 `dir`。测试 `snapshot.test.ts` L186 "consecutive failures are isolated per instance" 正面验证了该行为，但此隔离在生产消费模式下是 bug。修复方向：按 `dir` 做模块级 Map 聚合计数，或把 Snapshot 改成 per-dir 单例工厂。
- modules.md drift（**留 Step 13 统一修**）：
  - L143 "AuditLog（可选，通过 IAuditSink 接口注入）"：实际代码 import 的是 `Audit` 类型（`foundation/audit/index.js`），**不存在 `IAuditSink` 接口**。与 AuditLog 契约已登记的 IAuditSink drift 同源。
  - L144 "耦合：无"：`GITIGNORE_CONTENT` 是跨模块命名约定，必须登记。
  - L145 "被谁调用：Runtime、Daemon"：**漏了 Motion 命令**（`cli/commands/motion.ts` L176 调用 `new Snapshot(motionDir, motionFs, motionAudit).init()`）。
- **Motion 的 per-agent audit 隔离先例（Phase 148 登记）**：`motion init` 装配的 Snapshot 使用独立的 `motionAudit`（写 `motionDir/audit.tsv`），与 `systemAudit`（写 `baseDir/audit.tsv`）不共享。动机：Snapshot init 是 motion 工作目录的本地事件，写入 motion 自身 audit 流便于 per-agent 事后分析；system audit 仍专注进程生命周期（spawn/stop）。此双 audit 实例模式（装配层按业务域切分 audit 归属）登记为 Phase 148 确立的先例，未来 per-claw subagent 装配可沿用。

### C 类（原则对照补充）

- `this.dir` 作为单一资源标识符，实例级唯一归属 ✓（全局级见 B 类状态分裂）。
- **`.git` 资源归属**：grep 确认 `.git` 字面量仅出现在 `snapshot.ts` 与 `daemon.ts` L182 的注释中，**无其他模块直接操作 `.git`** ✓ 资源归属干净（与 Messaging A.5、ProcessManager A.4 对比情况更好）。
- git 参数单引号包裹 + 转义 `'\\''` 防 shell 注入 ✓。
- ~~`commit` 从不抛错是「业务可容忍偶发失败」的**显式设计决策**~~ —— **此条已推翻，移至 § 7 A.6 作为必修违规**。原判断错误地以为 L2 基础设施可以代消费者做"业务可容忍"决策；实际上 Snapshot 无跨业务语境的决策权，不可预期失败必须上浮。

## 8. 测试覆盖（验证行为契约）

`tests/foundation/snapshot.test.ts` 12 `it`：
- init（3）：`.git` + `.gitignore` + 初始 commit / 幂等 / 失败后清理 `.git`
- init audit（1）：失败时写 `snapshot_init_failed`
- commit（4）：无变更 no-op / 正常 / 失败 warn / 连续 3 次升级 error
- commit 隔离（1）：多实例连续失败计数彼此独立（**此用例是 B 类状态分裂的正面固化，修复时需更新**）
- commit audit（2）：恰好第 3 次写 `snapshot_degraded` / 第 4+ 次不再写
- commit 其他（1）：特殊字符 message

**覆盖缺口**：
- A.1 修复后需补 init 清理 `.git` 失败的 audit 事件断言
- A.2/A.3 修复后需补 commit 连续 1/2/>3 次失败的 audit 事件断言
- A.4 修复后需补 commit 成功 `snapshot_committed` 断言
- A.5 修复后需将 constructor `audit` 改为必传，所有 test 实例化显式传入
- A.7 修复后需补：`addIgnorePattern` 接口行为测试 + 装配层聚合顺序无关性 + grep 断言 `snapshot.ts` 不再出现 `stream.jsonl` / `audit.tsv` / `tasks/results` 字面量
- B 类状态分裂修复后需反转 L186 测试语义（同 dir 多实例共享失败计数）
