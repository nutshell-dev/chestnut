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

| 资源 | 类别 | 持久化 |
|---|---|---|
| OS 文件系统访问能力（M#5 业务模块不允许直接 import `node:fs` / `node:path`）| 概念性 / 唯一入口 | — |

**FileSystem 是 clawforum 对 OS fs 的唯一调用入口**（任何文件 I/O 必经 FileSystem 间接访问）。

> 注：(1) `baseDir` 构造期参数 / 所有相对路径解析根 / 运行期不变 / 每实例 own 自己 baseDir（实施细节归 §1.做）/ (2) `IGNORE_PATTERN = '.tmp_'` 常量（type-level / temp 残片命名前缀 / 由 L6 Assembly cleanup 引用 / 改名 tsc 自动捕获 / M#9 编译器可检）。

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
| **A.list-async-vs-sync listSync vs list async 路径语义不一致 + listSync 0 recursive** | drift / 中 / r74 C fork phase 610 derive | **closed by phase 610**（main `14d3d40a`）| 实然 `node-fs.ts:200 list async` `path: relativeToFsRoot` (path.relative(fsBaseDir, fullPath) / 相对 fs root) vs `:397 listSync` `path: path.join(relativePath, e.name)` (相对 input arg) / listSync 0 recursive 实现（line 384 readdirSync 后 .filter 不递归）虽 interface 类型签名含 `recursive?: boolean` 选项 / **真 drift**：caller 经 sync vs async 切换时行为不同 / 违 M#7 耦合界面稳定。**phase 610 决策（28 原则核 5/5 dominant 自决）**：α listSync `path` 改 baseDir-relative（mirror list async line 200 模式）+ 实现 recursive option mirror list async line 208-210 scan helper 的 sync 版本 / β list async 反向 align 违 baseDir 通用语义 reject / γ 接口签名拆双方法 over-engineering 违 M#8 reject |
| **A.writeExclusiveSync-fsync `writeExclusiveSync` 'wx' atomic create 但 0 fsync** | drift / 中 / r74 C fork phase 610 derive | **closed by phase 610**（main `14d3d40a`）| 实然 `node-fs.ts:303-314` `fsSync.openSync(absolute, 'wx')` 是 atomic exclusive create（dispatch claim「无 atomic guarantee」**部分 STALE**）/ 但 closeSync 前 0 fsync → kernel buffer crash 可能丢 / lock 文件未持久化 / **lockfile semantics 兑现不全** / 与 `writeAtomicSync line 295 fsyncSync` 不对称。**phase 610 决策（28 原则核 5/5 dominant 自决）**：α closeSync 前加 `fsyncSync(fd)`（与 writeAtomicSync 一致 / lock 文件持久化兑现 / 0 接口变 / 微性能成本可忽略 lock 写极少 / 持久化 critical）/ β 接受现状文档明示违 M#10 + lock semantics 不全 reject |
| **B.writeAtomicSync-race-window-stale-recheck dispatch「tmpFile 不 resolveAndCheck race window」claim STALE 推翻** | r74 C fork phase 610 derive STALE 注 | **closed by phase 610（STALE 推翻 / 0 src 改）** | r74 dispatch claim：`writeAtomicSync race window (tmpFile 不 resolveAndCheck)`。**Path #1 实测核 STALE 推翻**：(1) `node-fs.ts:286-289` `const dir = path.dirname(absolute)`（absolute 已 resolveAndCheck）+ `const tmpFile = path.join(dir, '.tmp_' + randomUUID())`（dir 已在 baseDir 内 / randomUUID 不含 `../`）→ **0 path traversal 风险 / 0 race window**；(2) writeAtomicSync 已 fsync (line 295) + atomic rename (line 296) → 已合规；(3) → 0 src 改 / scope 收窄 / 同 phase 543+555+591+604 dispatch claim Path #1 实测 STALE 推翻模板 align |
| **A.removeDir-vs-delete-error-asymmetry `delete` throw FNFE vs `removeDir` 静默 ENOENT** | design-gap / 设计意图 / r74 C fork phase 610 derive | **⚓ accepted-stable by phase 610**（待合 main / 文档 align）| 实然 `node-fs.ts:138-149 delete` ENOENT → `throw new FileNotFoundError(relativePath)`（caller 必 catch / lockfile / dialog 等业务 catch ENOENT 已编写）vs `:160-163 removeDir → atomic.ts:91 fs.rm(dirPath, { recursive: true, force: true })` `force: true` 已 silent ENOENT（idempotent 设计意图）。**phase 610 决策（28 原则核 5/5 dominant 自决）**：α ⚓ accepted-stable + 文档明示「delete 抛 ENOENT (caller 必 catch) / removeDir 静默 ENOENT (force:true / 设计意图 idempotent)」/ caller pattern 锁定 (M#10 不动既有 caller 业务) / β removeDir align delete throw ENOENT 业务决策性 caller cascade 影响面大推 r+1 / γ delete align removeDir silent 违 lockfile/dialog caller catch ENOENT 业务逻辑 reject / 同 phase 503+599+603 ⚓ accepted-stable + caller pattern 锁定模板 align |

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
| **L1.G1 (filesystem)** `IGNORE_PATTERN` const type-level 资源 arch 未列 | **业务决策性 design-gap / r64 A 起 cross-doc audit 浮出**：interfaces/l1.md line 80 暴露 `IGNORE_PATTERN: string`（temp 残片命名前缀 / type-level 资源 / 由 Assembly cleanup 引用）/ arch 表 1 FileSystem row 资源列「无」未列此 type-level const / const-level detail 通常不入应然 spec 但此 const 是跨模块契约（Assembly cleanup 依赖）| **业务决策性 / 用户拍板候选**：α arch 表 1 FileSystem row 资源列加备注「IGNORE_PATTERN type-level const（Assembly cleanup 引用）」/ β 保留现状（const-level detail 不入应然 spec / interfaces line 80 注释已足够）|
| FS6 resolveAndCheck op='read' base-dir confinement only / 不强制 file 存在 | accepted-stable / r76 C fork sweep 浮出 | ⚓ 0 副作用 / read-mode resolve 仅 base-dir 越界守护 / file 存在性由 read 调用方 fs.read ENOENT 路径 own / 业务语义合理差 / r76 C fork (phase 629) Path #1 sweep 0 真 drift / closed by phase 629 ⚓ 登记 |
| FS8 IGNORE_PATTERN dead 嫌疑 | dismissed / 真 caller exists | ❌ **dispatch claim 错锚定** / Path #1 全栈 grep 真 caller `src/assembly/cleanup.ts:10+17` verified（line 17 `if (!entry.name.startsWith(IGNORE_PATTERN)) continue` 真 dispatch logic）/ 0 dead / r76 C fork (phase 629) closed dismissed |
| FS9 writeExclusiveSync content '0'/'' edge-case quirk | accepted-stable / r76 C fork sweep 浮出 | ⚓ atomic.ts writeExclusiveSync content === '0' / '' 边界行为 quirk / 0 真 caller bug 实证 / inline 注释推 r+1+ doc cluster / r76 C fork (phase 629) Path #1 sweep 0 真 drift / closed ⚓ |
| FS11 `// ====` separator consistent style | accepted-stable / r76 C fork sweep 浮出 | ⚓ node-fs.ts 实测 10 处 separator（dispatch claim 标 6 处 / 数字 stale → reframe per `feedback_dispatch_number_stale_path1_reframe` C5 数字偏差）/ consistent style / 0 业务驱动 / r76 C fork (phase 629) closed ⚓ |
| FS12 NodeFileSystem ctor `private readonly options` 嫌疑 | accepted-stable / r76 C fork sweep 浮出 | ⚓ 0 ergonomic 痛点 / 0 caller cascade 影响 / 业务语义合理差 / r76 C fork (phase 629) Path #1 sweep 0 真 drift / closed ⚓ |
| FS13 jsdoc method 描述不全 | accepted-stable + 推 r+1+ doc cluster | ⚓ cosmetic doc 性质 / 0 业务驱动 / 推 r+1+ 模块整体 doc cluster 单独 phase / r76 C fork (phase 629) 不在本 phase scope / closed ⚓ + r+1+ |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：fs OS 操作 / 应然单职责（路径越界守护 + 权限域内化 ✅ closed phase377 / 启动期临时残片清理 ✅ closed phase397 / L1 sharpen v2 全 4 项收官）
- **M#2 业务语义归属**：FileSystem 应 OS 抽象 only / 不 own 权限语义（✅ closed phase377）/ 不 own 启动清理（✅ closed phase397）/ 不 own agent 工具
- **M#3 资源归属**：磁盘资源访问的 L1 唯一路径
- **M#4 持久化**：FileSystem 本身是持久化路径 / 不持自有状态
- **M#5 依赖单向**：foundation/fs → types/errors / 0 clawforum 模块依赖
- **M#6 依赖结构稳定**：interface 稳定 / 仅 non-breaking 扩展（phase165 readBytesSync）
- **M#7 耦合界面稳定**：interface 描述对外口 / IGNORE_PATTERN 常量是命名约定对外暴露
- **M#8 耦合界面最小**：interface 字段精选 / 无「为未来保留」
- **M#9 显式表达编译器可检**：命名 class 错误（PathNotInClawSpaceError 定义在 `types/errors.ts` cross-module shared / 不在 L1 fs / 越界抛 PermissionError row phase368 撤销 / 实然 0 违反 M#9）
- **M#10 不合理停下**：未触发
- **M#11 边界不对停下**：phase368 触发新候选 permissions.ts L1 持 claw 概念（已停下登记 / **closed by phase 430** / permissions.ts 整文件删除 / 同 §A row / phase 715 sub-A D2-P1.2 narrative state lag fix）

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

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

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
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table + 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design 集合 silent 已正确）
- 2026-04-28 / phase368 越界抛 PermissionError row 释义豁免 closed / dispatch framing 错位：把 base-dir traversal 与 claw-space boundary 混为一谈 / 实测两者由不同模块用不同 class 正确处理（node-fs.ts:72/106 = base-dir boundary `..` + symlink → 通用 PermissionError 无 claw 字 ✓ / permissions.ts:155/198 = claw-space boundary → PathNotInClawSpaceError ✓）/ PathNotInClawSpaceError 定义在 src/types/errors.ts:83 cross-module shared types / **释义豁免模板第 5 次复用**
- 2026-04-29 / phase377 路径越界守护 + 权限域内化落地（main `3dd2665`）/ phase373 design fork α 路径锁定 → phase377 实施落地 / **L1 sharpen v2 全 4 项收官** / 关键修订：原应然「归 FileTool L2」实施期 derive 改「归 L4 `src/core/permissions/`」（PermissionChecker interface 留 L1 OS-neutral / 实现迁 L4 业务分层）/ base-dir vs claw-space 区分明确（L1 OS 合规保留 / L4 PermissionChecker own）
- 2026-05-01 / phase397 启动期临时残片清理 closed（main `b27379d4`）/ **β 路径实施落地**：物理迁 cleanupOrphanedTemp `src/foundation/fs/atomic.ts` → `src/assembly/cleanup.ts` / 删 NodeFileSystem.cleanupTempFiles 双形态 + atomic.ts export + fs/index.ts re-export / assemble.ts caller 直接 import + 调（不经 systemFs 中转）/ 测试段落迁 tests/foundation/fs.test.ts → tests/assembly/cleanup.test.ts / 启动清理行为等价 / **物理迁 + 工厂 + Assembly 三模板复合复用**（同 phase360 done + phase378 CommandTool）/ Daemon 框架剔除 framing 精化（实测 prod 单 caller assemble.ts:372 / 0 Daemon caller）
- 2026-05-04 / phase415 L1 hygiene 闭环（main `6ca0395e`）/ FileWatcher @module L2→L1 修正 + FileNotFoundError re-export from types/errors.ts（轻量过渡 closed）+ 物理迁 class to `src/foundation/fs/types.ts` 推 r+1 phase / 微改 3 文件 / 5 行 / 1370/1370 PASS / 起 L1+L2 phase 415-422 序列
- 2026-05-04 / phase430 KD#2 + §A.1 + §A.7 反向 design 落地（main `340c6154` / merge `9b56985f`）/ FileSystem 完全 0 PermissionChecker dep / NodeFileSystem ctor 删 PermissionChecker 注入 + 删 enforcePermissions option + 删 ctor 内 createNullPermissionChecker fallback / `permissions.ts` 整文件删 / claw-permissions L4 内嵌 PermissionChecker interface 自治 / FileTool 4 工具 caller 直 dep claw-permissions（per-clawDir 缓存）/ phase377+phase373+phase368 错治理整套反向 / **5 port STALE cluster 反向第 6 例（cluster 6 闭 6 全收官 / 含 phase422 WatchdogPort + phase424 TaskLifecyclePort + phase426 RetroScheduler + phase427 ContractVerifierScheduler + phase429 Runtime 11 ports + 本 phase）**/ 1366 测试 PASS / 0 行为改变（claw-space check 由 L4 caller 自治 / fs I/O 操作语义 0 改 / base-dir traversal 守护保留）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l1_filesystem.md vs arch §1 + 表 1/2 + interfaces/l1.md FileSystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-c + D2/D3/D5/D7 + D1d/D4-D6/D8-D11 无关 + Philosophy P1+P3+P4 + Path #1-#7）/ 3 主能力 align arch 表 2 / 0 dep + caller「几乎所有模块」align arch 表 1 / 资源「无」align arch 表 1 / 补 phase368+377+397+415+430 closure timeline entry / L1.G1 (filesystem) IGNORE_PATTERN const type-level 资源 arch 未列 design-gap 已登记 §B（业务决策性 α/β 候选）/ design only / 0 src 改
- 2026-05-10 / **phase 611 fs path safety cluster（B fork r74）**（main `6381f11d`）/ r74 fan-out fs 模块首次深耕 / 3 site safety hardening + 0 NEW const：(P0.1) `node-fs.ts:54` resolveAndCheck 加 `if (path.isAbsolute(relativePath)) throw PermissionError` / 修 read+missing+absolute path fall-through silent gap（path.normalize 不 strip 绝对路径前缀 / `path.normalize('/etc/passwd')` 仍 `/etc/passwd` / `startsWith('..')` false / 防御依赖 realpath check 在 read+missing 路径有 fall-through）/ (P0.2) `claw-send.ts:32` `baseDir: '/'` → `baseDir: clawDir` + inboxPending 改 relative / fs confinement 兑现 / (P1.5) `node-fs.ts:234-241` exists `try { ... } catch { return false }` catch all → 区分 PermissionError 抛 + 其他 false / D2 不静默 + D11 安全 signal 保留 / **0 NEW audit const**（守卫直 throw / 既有 PermissionError 复用）/ 3 NEW tests cover absolute path traversal + exists permission signal + claw-send confinement / Path #1 dispatch 5/5 真 / **「既有 const/callback 复用 / 0 NEW interface field」纪律 N=5 实证累**（phase 578 + 590 + 596 + 607 + 611 / Meta 41 加成 / 升格独立 feedback 阈值持续硬化）/ **「review claim 实测四态分类」N+1 实证累**（5/5 全 VERIFIED tight）/ **首次 fs P0 闭环里程碑**（path safety 安全 hardening / 推 r75+ 全栈 `new NodeFileSystem` sweep + path-query method PermissionError 同型审 isDirectory + listSync 等）/ §A.path-traversal-guard + §A.exists-permission-signal 双 closed by phase 611
- 2026-05-10 / **phase 629 foundation/fs C fork P3 hygiene scope reframe**（C fork r76 / design only / 0 src）/ dispatch 标 6 P3 hygiene candidate（FS6+FS8+FS9+FS11+FS12+FS13）+ 2 out-of-scope（FS14+FS15 由并发 phase 626 own）/ Path #1 sweep 8/8：5 ⚓ accepted-stable + 1 dismissed（FS8 真 caller `cleanup.ts:10+17` verified）+ 2 out-of-scope / **0 真 drift / 0% 真修率**（极 bimodal / 与 phase 621 同型）/ §B 加 6 NEW row 登记 / **「dispatch claim sweep → 0 真 drift / 业务语义合理差 reframe」N=2 实证升格阈值过线**（phase 621 + 629 / 推 Meta 42 升格独立 feedback）/ **「review claim 实测四态分类 + reframe」N+1 实证**（C5 数字偏差 / FS11 dispatch 6 → 实测 10 separator / dispatch ratio bimodal 数据点扩 per `feedback_dispatch_number_stale_path1_reframe`）/ **foundation/fs deep review 链 5 phase 全闭里程碑**（611 P0 path safety + 617 silent X narrow + 618 ENOENT cluster + 626 phase 标号清 + 629 P3 ⚓ 登记 / 模块整体闭环）/ **「design closure phase 单 Step A 形态」N=8+ 实证累** / **node-fs.ts 474 行不拆**（< 500 阈值 / 0 拆 ROI / 推 r77+ 视野上移再评估）/ design + memory only / 0 commit src

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#2 FileSystem 权限域（agentFs + trustedFs / 白名单由 Daemon 注入）| ✅ **closed by phase 430（main `340c6154` / merge `9b56985f`）**：反向 design 落地 / FileSystem 完全 0 PermissionChecker dep / `permissions.ts` 整文件删除 / claw-permissions L4 内嵌 PermissionChecker interface 自治 / FileTool 4 工具 caller 直 dep claw-permissions / 5 port STALE cluster 反向第 6 例（cluster 6 闭 6 全收官）/ phase377+phase373+phase368 错治理整套反向 / 详 §A.1 + §A.7 + `feedback_governance_workaround_smell` |

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

## phase 684 — Sub-B fan-out fs durability acceptable design row

### B-P1.1 atomic.ts writeAtomic 不 fsync 父目录

- **claim**：write tmp + fsync data + rename / 不 fsync 父目录 / POSIX 严格语义下 rename 后 + dir fsync 前 crash 可能丢文件
- **状态**：C2 部分 acceptable
- **结论**：design intent acceptable / mirror 行业最佳实践（atomic-write npm 包同模式）/ ext4/APFS 默认 mount 数据可见性 OK / 0 用户可见数据丢失证据
- **不修原因**：ROI 低 / writeAtomic + writeAtomicSync 双 path 一致 / paranoia-only fix
- **触发再评估**：如未来报告任何 crash 后 file 不存在用户可见 bug → 单 phase 加 dir fsync helper

### B-P2.12 audit writer fallback dump 不 fsync

- **claim**：audit writer 主 path 失败后 dumpFallback 用 `nodeFs.writeFileSync(fallbackPath, body)` / 不 fsync / process crash 后可能 0 字节
- **状态**：C2 部分 acceptable
- **结论**：fallback 是 last-resort / sync write 至少入 OS 缓冲队列 / 0 user-facing 数据丢失证据 / fallback 本身 best-effort 设计
- **不修原因**：ROI 低 / 与 atomic write 一致的 acceptable durability 弱化

## phase 711 — workspace root 资源唯一归属（getWorkspaceRoot enforce / r96 D fork）

### E1-P1.1 10 site inline `process.env.CLAWFORUM_ROOT ?? process.cwd()` collapse（closed by phase 711）

- **claim**：`src/foundation/config/paths.ts:13-15` `getWorkspaceRoot()` 已存为 workspace root 资源唯一入口 / 但 10 site 内联绕过（9 file × 跨 cli + watchdog layer）/ 改 default fallback 时 10 处同步漂移风险
- **状态**：C1 verified tight
- **结论**：closed by phase 711 / 10 site collapse to `getWorkspaceRoot()` import / 单点 enforce 资源唯一归属（per ML M#3）
- **derive**：ML M#3「每种资源只归属唯一模块 / 其他模块通过该模块的对外入口间接访问」/ workspace root env 是资源 / `getWorkspaceRoot()` 是唯一入口

### E1-P3.1 cli/index.ts:6-8 bootstrap 副作用（stable design）

- **claim**：`cli/index.ts:6-8` 模块顶层 `if (!process.env.CLAWFORUM_ROOT) { process.env.CLAWFORUM_ROOT = process.cwd(); }` 副作用
- **状态**：C1+(b) framing / bootstrap 协议（非 bug）
- **结论**：stable design / bootstrap 是 CLI entry 唯一职责 / 与 `getWorkspaceRoot()` 读+兜底语义重复但 bootstrap 一次性写入 / 不替换
