# FileSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) FileSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §1「FileSystem 本质：文件 I/O 能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），FileSystem 的单一职责 = **OS 文件系统能力的原语暴露加跨平台抹平**：

- **OS 文件 I/O 原语暴露**：OS 文件系统提供什么能力，本模块暴露什么 — 不阉割（不替业务做选择）也不增添（不加 OS 没有的逻辑）。具体能力 list 含读写加创建删除加属性查询加路径解析加文件锁原语等，由 OS 决定。
- **跨 OS 平台抹平**：吸收 POSIX / Windows / 等文件系统异构 — 调用方写一套代码跨 OS 跑（derive 自 Design Principle「分布式部署加跨 OS 平台」）。
- **路径解析根锚定**：构造期给定 baseDir，所有相对路径在此 baseDir 下解析为绝对路径（让多业务模块各自 own 自己的 baseDir 而互不干扰 / M#3 实例化粒度边界）。

> 具体 API 形态（method 名加签名加参数）归 [interfaces/l1.md](../interfaces/l1.md) FileSystem 节。具体 method 实例（writeExclusiveSync / readBytesSync / writeAtomic 等）的存在依据是「OS 提供该原语」— 实然采纳的 method 集合差异登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / dialog / inbox / outbox / contract / 业务文件结构）— derive 自 M#2 业务语义归属（FileSystem 业务语义仅 OS 级）加 M#5 单向依赖（底层不预设上层语义）
- **不 own 文件变化通知**（订阅文件变化是独立可变职责 / 归 L1 FileWatcher）— derive 自 M#1
- **不 own agent 工具暴露**（read / write / search / ls 工具暴露给 agent 是独立可变职责 / 归 L2 FileTool）— derive 自 M#1
- **不 own 路径权限策略**（哪些路径可读可写是业务上层语义 / 归 caller 自治 / caller 自己 check 后 call FileSystem / FileSystem 0 知权限业务）— derive 自 M#5
- **不 own 启动期临时残片清理**（清理时机加策略是装配业务 / 归 L6 Assembly）— derive 自 M#1 + M#2
- **不 own audit**（cross-cutting / 归各调用方自治 / 详 §5）— derive 自 M#1
- **不 own 文件内容缓存**（缓存策略是消费者侧业务）— derive 自 M#1
- **不 own 跨进程同步**（多进程并发协调是应用层语义）— derive 自 M#5 不预设上层语义
- **不 own 业务级搜索引擎**（复杂 glob / regex / 全文搜索归 L2 工具层）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），FileSystem 的业务语义边界：

- **own**：OS 级文件 I/O 概念 — 路径加字节加文件名加 mtime 加 size 等。这些是 FileSystem 唯一懂的「业务」（OS 抽象层级，不是 clawforum 业务层级）。
- **角色定位**：FileSystem 是「**访问通道**」非「**资源宿主**」。不持业务数据，仅提供 OS 级访问机制；任何业务文件（含 dialog / messages / inbox / audit / stream / 等）的内容含义加结构由各业务模块（DialogStore / Messaging / AuditLog / Stream / 等）自治。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），FileSystem 独占的资源：

- **OS 文件系统访问能力**：clawforum 内部任何文件 I/O 必经 FileSystem 间接访问（M#5 业务模块不允许直接 import `node:fs` / `node:path`）— 是 clawforum 对 OS fs 的唯一调用入口。
- **`baseDir`**：构造期参数 / 所有相对路径的解析根 / 运行期不变。每个 FileSystem 实例 own 自己的 baseDir。
- **temp 残片命名前缀**：`IGNORE_PATTERN = '.tmp_'` 常量（type-level 资源）对外暴露 — 由 L6 Assembly cleanup 引用做残片识别（写时原子 temp+rename / 残片清理在 Assembly 层）；改名 tsc 自动捕获 drift（M#9 编译器可检 derive）。注：Snapshot 模块的 `SNAPSHOT_IGNORE_PATTERNS` 是其自治 gitignore-like 常量 / 与本 IGNORE_PATTERN 无关（应然边界清晰）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），FileSystem 自身的持久化立场：

- **模块零状态**：FileSystem 不持自有运行时状态加自有磁盘 artifact — 是「持久化路径」非「持久化对象」。
- **重建语义**：进程重启时 `baseDir` 由调用方装配期重新传入即可重建；内部无需从磁盘恢复任何 FileSystem 自有状态。
- **磁盘一致性保证**：原子写经 temp + rename 路径，rename 前崩溃 → 原文件未变更（仅留 `.tmp.*` 残片 / 残片清理归 Assembly / 见 §7.A A.p320-2）— 让 Design Principle「中断可恢复」前提成立（消费业务模块持久化的 dialog / audit / 等不被半写污染）。

## 5. 审计事件清单

**FileSystem 不产生任何 audit 事件**（应然 / cross-cutting 业务归 caller / FileSystem 不调 audit.write）。

调用方在自有命名空间审计 fs 操作（如 ProcessManager 的 `PID_*` / Snapshot 的 `SNAPSHOT_*` 等）。

## 6. 层级声明

L1 OS / fs API 抽象层 / Node.js fs 模块的薄包装。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~路径越界守护 + 权限域内化 leak~~ ✅ closed | drift / 高 | **✅ closed**（phase430 / main `340c6154` / merge `9b56985f`）| **phase377+phase373+phase368 错治理整套反向 + 真合规落地**：NodeFileSystem ctor 删 PermissionChecker 注入 + 删 enforcePermissions option + 删 ctor 内 createNullPermissionChecker fallback / FileSystem 完全 0 PermissionChecker dep / 0 业务概念 / `resolve()` base-dir traversal 守护 OS 级合规保留（normalized.startsWith('..') + symlink 守护无条件执行 / 含根目录 baseDir 边界修复）/ FileTool 4 工具 (read/write/search/ls) 自治调 createClawPermissionChecker check 后 call fs（per-clawDir 缓存）/ 5 port STALE cluster 反向第 5 例（cluster 6 闭 6 全收官 / 含 phase422 WatchdogPort + phase424 TaskLifecyclePort + phase426 RetroScheduler + phase427 ContractVerifierScheduler + phase429 Runtime 11 ports + 本 phase）/ 1366 测试 PASS / 0 行为改变（claw-space check 由 L4 caller 自治 / fs I/O 操作语义 0 改 / base-dir traversal 守护保留）|
| ~~**启动期临时残片清理 leak**~~ | ~~drift / 中~~ | **✅ closed（phase397 / main `b27379d4`）** | **β 路径实施落地**：物理迁 cleanupOrphanedTemp `src/foundation/fs/atomic.ts` → `src/assembly/cleanup.ts` / 删 NodeFileSystem.cleanupTempFiles 双形态 + atomic.ts export + fs/index.ts re-export / assemble.ts caller 直接 import cleanupOrphanedTemp（不经 systemFs 中转）/ 测试段落迁 tests/foundation/fs.test.ts → tests/assembly/cleanup.test.ts / 启动清理行为等价（IGNORE_PATTERN foundation own + audit event 名 `cleanup_temp_files_failed` 不变）/ 物理迁 + 工厂 + Assembly 三模板复合复用（同 phase360 done + phase378 CommandTool）/ Daemon 框架剔除 framing 精化（实测 prod 单 caller assemble.ts:372 / 0 Daemon caller） |
| agent 工具导出 anchor | anchor | 防 drift（合规）| 应然立场登记：FileSystem 不应 export ToolDefinition / 当前未 leak / 用作 reviewer 自检 |
| audit 内化 anchor | anchor | 防 drift（合规）| 应然立场登记：FileSystem 不调 audit.write / 当前未 leak / 用作 reviewer 自检 |
| `writeExclusiveSync` EEXIST 不可改语义 anchor | anchor | 防 drift（合规）| 应然立场登记：EEXIST 是 PID 锁实现依据 / 不可改为「覆盖」语义 / 用作 reviewer 自检 |
| **atomic.ts:164 console.warn** | drift / 低 | 已闭环（phase358） | L1 不应有 console / cleanup 失败应由 caller 决策（best-effort 静默 / caller 顶层 audit 已覆盖）|
| ~~**越界抛 PermissionError 而非 PathNotInClawSpaceError**~~ | ~~drift / 低~~ | **✅ closed（phase368 / δ 撤销 / 0 代码）** | **dispatch framing 错位**：把 base-dir traversal 与 claw-space boundary 混为一谈 / 实测两者由不同模块用不同 class 正确处理（node-fs.ts:72/106 = base-dir boundary `..` + symlink / 抛通用 PermissionError 无 claw 字 ✓ / permissions.ts:155/198 = claw-space boundary / permissions.ts header 显式 own claw read/write space design / 抛 PathNotInClawSpaceError ✓）/ PathNotInClawSpaceError 定义在 `src/types/errors.ts:83` cross-module shared types 不在 L1 fs 模块 / 实然 0 违反 M#5/M#7/M#9/D2 / 释义豁免模板第 5 次复用 |
| ~~permissions.ts L1 持 claw 概念~~ ✅ closed | drift / 高 | **✅ closed**（phase430 / main `340c6154` / merge `9b56985f`）| **phase377+phase373+phase368 错治理反向落地**：`src/foundation/fs/permissions.ts` 整文件删除（PermissionChecker interface 自治内嵌到 `src/core/permissions/claw-permissions.ts` L4 业务层）/ NodeFileSystem 完全 0 PermissionChecker dep / `claw-permissions.ts` L4 模块保留作为业务层实现 + 内嵌 PermissionChecker interface / FileTool 4 工具 caller 直 dep claw-permissions（不经 fs 中转）/ 同 §A.1 一并 closed phase430 / cluster 6 port 全收官 |
| ~~**IGNORE_PATTERN 契约承诺未导出**~~ | ~~drift / 低~~ | **✅ closed（phase313 / SHA `ebf8958`）** | 历史 drift / 跨模块 gitignore 聚合常量未对外 export / phase313 加 export / phase317 SHA 修正 |
| **FileNotFoundError 类不在 fs 模块** | drift / 中 | ✅ closed（phase415 / main `6ca0395e`）— re-export 过渡 / 物理迁推 r+1 phase | 应然 = interfaces/l1.md FileSystem 节 export class FileNotFoundError extends Error / 实然 = `src/types/errors.ts` cross-module shared types 定义 / NodeFileSystem 跨模块 import 自 `../../types/errors.js` / `src/foundation/fs/index.ts` 0 export FileNotFoundError / 应然「FileSystem 是错误类的 owner」契约不闭环 / 治理：fs/index.ts re-export from types/errors.ts（轻量过渡 closed）/ 物理迁 class to `src/foundation/fs/types.ts` + caller 改 import path 推 r+1 phase |

#### 路径越界守护 + 权限域内化 治理方向（✅ closed phase377）

- **闭环路径**：phase373 design fork（α 路径锁定）→ phase377 实施落地（main `3dd2665`）
- **关键修订**：原应然「归 FileTool L2」实施期 derive 改「归 L4 `src/core/permissions/`」（PermissionChecker interface 留 L1 OS-neutral / 实现迁 L4 业务分层 / ~~port pattern 第 8 次~~ ⚠ STALE 2026-05-03 推翻 / 应然真合规 = FileSystem 0 PermissionChecker dep / 详 §A.1 STALE + feedback_governance_workaround_smell）
- **base-dir vs claw-space 区分**：base-dir traversal 守护（`normalized.startsWith('..')` + symlink）= L1 OS 合规保留 / claw-space boundary（PathNotInClawSpaceError）= L4 PermissionChecker own / 两者由不同模块用不同 class 处理（phase368 framing 精化实证）
- **删除项**：`enforcePermissions` 选项 + ctor 内 `createPermissionChecker` 自创建（125 处 OS-only caller 改）
- **保留项**：`resolve()` base-dir 越界守护（OS 级合规）

#### 启动期临时残片清理 治理方向（✅ closed phase397）

- **闭环路径**：r55 C / β 路径锁定 + 实施 / main `b27379d4`
- **关键修订**：framing 精化 Daemon 剔除（应然「Daemon / Assembly own」/ 实然 prod 单 caller assemble.ts:372 / Assembly 唯一 own）
- **物理迁**：cleanupOrphanedTemp `src/foundation/fs/atomic.ts:150` → `src/assembly/cleanup.ts`
- **删除项**：NodeFileSystem.cleanupTempFiles instance method + atomic.ts export + fs/index.ts re-export + node-fs.ts import
- **caller 切换**：assemble.ts 直接 import + 调（不经 systemFs.cleanupTempFiles 中转）
- **测试段落迁**：tests/foundation/fs.test.ts → tests/assembly/cleanup.test.ts（git mv 保 history）
- **行为契约 0 改**：IGNORE_PATTERN foundation own / audit event 名 `cleanup_temp_files_failed` 不变

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| interface 单实现（NodeFileSystem）| 应然 silent / 实然 1 实现 | 引入 InMemoryFileSystem 等多实现需求 |
| `FileSystemOptions.allowedPaths` ghost 字段 | 应然 silent / 实然有 / 0 生产 caller / 仅测试引用 | 后续 phase 一致性自检评估删除 |
| `readBytesSync` 字节安全范围读 | 应然延伸（phase165 加）/ 非 breaking | Stream reader 字节/字符索引 mismatch 修复驱动 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：fs OS 操作 / 应然单职责（路径越界守护 + 权限域内化 ✅ closed phase377 / 启动期临时残片清理 ✅ closed phase397 / L1 sharpen v2 全 4 项收官）
- **M2 业务语义归属**：FileSystem 应 OS 抽象 only / 不 own 权限语义（✅ closed phase377）/ 不 own 启动清理（✅ closed phase397）/ 不 own agent 工具
- **M3 资源归属**：磁盘资源访问的 L1 唯一路径
- **M4 持久化**：FileSystem 本身是持久化路径 / 不持自有状态
- **M5 依赖单向**：foundation/fs → types/errors / 0 clawforum 模块依赖
- **M6 依赖结构稳定**：interface 稳定 / 仅 non-breaking 扩展（phase165 readBytesSync）
- **M7 耦合界面稳定**：interface 描述对外口 / IGNORE_PATTERN 常量是命名约定对外暴露
- **M8 耦合界面最小**：interface 字段精选 / 无「为未来保留」
- **M9 显式表达编译器可检**：命名 class 错误（PathNotInClawSpaceError 定义在 `types/errors.ts` cross-module shared / 不在 L1 fs / 越界抛 PermissionError row phase368 撤销 / 实然 0 违反 M#9）
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：phase368 触发新候选 permissions.ts L1 持 claw 概念（已停下登记 / 推 r51+ design phase 评估治理路径）

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：所有 I/O 原样暴露 Node fs 错（errno / path）
- **D1b 状态可观察**：async/sync 双轨 / list / exists / readBytesSync 提供状态查询
- **D1c 中断可恢复**：`writeAtomic` temp+rename 残片清理（应然由装配方 own）
- **D1d 事后可审计**：无关（FileSystem 本身是审计文件写入点 / 不自审计）
- **D2 不得丢弃/静默**：原样抛 Node fs 错（违反点 atomic.ts:164 console.warn）
- **D3 用户可观察**：同 D1b
- **D5 日志重建**：atomic write 保证磁盘一致性前提
- **D7 系统可信路径**：受信组件
- **D4-D6 / D8-D11**：无关（基础设施 / 不做决策 / 不发事件）

#### Philosophy（4 条）

- **P1 Agent 即目录**：FileSystem 是「Agent 即目录」原语的实现
- **P2 上下文工程**：无关
- **P3 分多个智能体加分子任务**：单一代码基
- **P4 系统为智能体服务**：基础设施 / 不参与决策

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase165 / phase187 / phase313 / phase317 各 phase 收尾报告。

关键里程碑：
- phase165：`readBytesSync` 字节安全范围读引入（Stream reader 字节/字符 mismatch 根因修复）
- phase187：L1 FileSystem 契约 backfill（既有 §A/§B 节保留 / 补 §7.C 32 条原则对照）
- phase313：IGNORE_PATTERN export 闭环（SHA `ebf8958`）
- phase317：IGNORE_PATTERN SHA 修正（假 SHA `2079eba` → 正确 `ebf8958`）
- phase358：atomic.ts console.warn 移除（L1 不应有 console 出口 / best-effort 静默 / caller 顶层 audit 覆盖）
- r44 A：契约结构升 9 节模板 / FileSystem L2 → L1 应然 align（permissions / cleanup 应然外移登记）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#2 FileSystem 权限域（agentFs + trustedFs / 白名单由 Daemon 注入）| ⚠ STALE（phase377 是 design work-around / 应然真合规 = caller L4 自治权限 + FileSystem 0 PermissionChecker dep / 推 r61+ 反向 design phase / 详 §A.1 + §A.7 STALE + feedback_governance_workaround_smell）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **async / sync 双轨基本操作**：read / write / append / delete / move / stat / exists / list / ensureDir / removeDir
- **原子写**：`writeAtomic` 崩溃残片不污染原文件 / temp+rename 流程
- **独占创建**：`writeExclusiveSync` EEXIST 行为
- **字节范围读**：`readBytesSync` 字节范围 + EOF + 越界 / 多字节 UTF-8 chunk 边界
- **list pattern**：简单 glob（`*` / `?`）支持
- **`ensureDir`**：对已存在路径无操作 / 不抛错
- **错误类**：FileNotFoundError / EEXIST 抛出条件

> `IGNORE_PATTERN` 常量改名应被 Snapshot 集成测试捕获（消费方引用常量 / 不引用字面量）。
