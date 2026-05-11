# FileWatcher 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) FileWatcher 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §5「FileWatcher 本质：文件变化通知能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），FileWatcher 的单一职责 = **OS 文件变化通知能力的原语暴露加跨平台抹平**：

- **OS 文件变化通知原语暴露**：OS 文件系统提供什么变化通知能力，本模块暴露什么 — 不阉割也不增添。具体能力含路径监听加 add/modified/deleted 事件加初始 ready 信号加 stats 元信息等，由 OS watch 机制（inotify / FSEvents / ReadDirectoryChangesW）决定。
- **跨 OS 平台抹平**：吸收 OS watch 机制异构 — 调用方写一套代码跨 OS 跑 / **含 OS watch 不可靠兜底**（如 macOS FSEvents 对快速连续 append 静默停火 / L1 应内置 fallback poll 兜底 / 不 leak 到 L2 业务模块）/ derive 自 Design Principle「分布式部署加跨 OS 平台」+ M#5 单向依赖（L2 业务不应处理 L1 OS detail）。
  - **fallback poll 内置策略**（per phase 469 G1-G3 derive / 详 `coding plan/phase469/derive.md`）：
    - **G1 触发条件**：仅 `stability === 'immediate'` 模式启用 fallback poll（`'stable'` 模式 chokidar `awaitWriteFinish` 已兜底 / 不需独立 fallback）
    - **G2 间隔默认值**：默认 500ms（const `DEFAULT_FALLBACK_POLL_MS = 500` / phase352 实测验证 / caller 极少需要不同间隔）
    - **G2 caller override**：options `fallbackPollMs?: number` escape hatch（应然预留 / 当前 0 caller 用 / 长期观察 0 用即退化删字段）
    - **G3 平台**：仅 macOS 启用（`process.platform === 'darwin'`）/ Linux inotify + Windows ReadDirectoryChangesW 默认 0 fallback（不可靠 reproducer 触发后再扩 platforms list）
    - **触发行为**：fallback timer 每 tick emit 一个 `{ type: 'change', path: absolutePath }` event 给 callback / caller readIncrement 逻辑 idempotent (offset-based) / 不破坏一致性
    - **G4 escalation 终止条件**（per phase 581 / r69 D fork / main `678f70fd`）：fallback timer 闭包 count `consecutiveCallbackFails` / callback success 重置 / fail increment / 达 `FALLBACK_CONSECUTIVE_FAIL_LIMIT = 5`（mirror reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT 模板）→ `clearInterval` + nullify fallbackTimer + onError(err, `'fallback_disabled'`) 通知 caller。**应然依据**：M#10 不合理停下（poller 持续抛应识别系统级失败终止）+ Path #7 总难度（资源耗尽路径成本无界 / escalation 是兜底）+ D5 信息洁癖（避免 audit 爆涨）。**caller 处理**：`WatcherErrorContext` 加 `'fallback_disabled'` / 5 caller 既有 binary discrimination `context === 'callback' ? CALLBACK_FAILED : FAILED` 自然落入 else 分支 = FAILED tier audit / 0 caller cascade NEW const。
- **watch 句柄生命周期管理**：创建 watcher / 关闭 idempotent / 状态查询 — 句柄是有限资源（OS fd），生命周期管理是 M#3 资源唯一归属的运行期一面。

> 具体 API 形态归 [interfaces/l1.md](../interfaces/l1.md) FileWatcher 节。具体行为细节（稳定性窗口加事件映射加错误回调 context discriminator 等）的存在依据是「OS 原语提供 / 跨平台一致性需要」— 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / 业务文件结构 / inbox / outbox / dialog / contract 等）— derive 自 M#2 业务语义归属（FileWatcher 业务语义仅 OS 级）加 M#5 单向依赖
- **不依赖任何其他 clawforum 模块**（含 L1 FileSystem 加 L2 AuditLog）— derive 自 M#5 单向依赖（L1 不依赖任何同层加上层）
- **不 own 业务目录语义**（调用方告诉 watch 什么路径）— derive 自 M#2
- **不 own 文件内容读取**（变化通知到了内容读取由调用方用 L1 FileSystem 做）— derive 自 M#1 独立可变职责
- **不 own audit**（fs watch 可观察性的业务上下文归调用方 / caller 拿 raw onError(err, context) 自治写 audit）— derive 自 M#1 + M#2
- **不 own 事件批处理加去重加节流**（消费侧业务策略）— derive 自 M#1
- **不 own 历史事件回放**（初始状态扫描归调用方用 FileSystem.list 做）— derive 自 M#1
- **不 own 跨平台之外的能力增强**（OS / chokidar 能力上限 = 本模块上限）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），FileWatcher 的业务语义边界：

- **own**：OS 级文件变化事件概念 — 路径加事件类型（add / modified / deleted）加 stats 元信息（size / mtime）。这些是 FileWatcher 唯一懂的「业务」（OS 抽象层级）。
- **角色定位**：FileWatcher 是「**事件源**」非「**事件解读器**」。仅产出 raw OS 事件，不解读业务含义（如「这个文件修改意味着 inbox 有新消息」由调用方业务解读）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），FileWatcher 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| OS 文件系统变化通知机制访问（M#5 业务模块不直 import chokidar）| 概念性 / 唯一入口 | — |
| watch 句柄运行期资源（每 createWatcher 产生独立 chokidar instance + OS fd / 调用方持句柄生命周期）| 派生态 | ✗ |

**FileWatcher 是 clawforum 对 OS 文件 watch 机制的唯一调用入口**。

> 注：不占用 audit 命名空间（FileWatcher 自身不发 audit 事件 / 各 caller 自有 prefix / 详 §7.E KD#1）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），FileWatcher 自身的持久化立场：

- **模块零状态**：FileWatcher 不持自有磁盘 artifact — 是「观察者」（仅订阅事件 / 不写磁盘）。
- **重建语义**：进程重启时所有 watcher 句柄随进程销毁，调用方在新进程装配期重新 createWatcher 即重建订阅；目标路径加配置由调用方装配期重新提供（无需从磁盘恢复）。
- **运行期句柄**：chokidar instance + OS fd 是运行期资源 / close() 释放 fd / 不持久化。

## 5. 审计事件清单

**FileWatcher 不产生任何 audit 事件**（应然 / M2 业务语义归属：fs watch 可观察性归 caller）。

错误经 `onError(err, context)` 单回调暴露给调用方 / caller 在自有命名空间写 audit。已知 4 caller 命名空间（实然实测）：

| caller | 命名空间 | audit-events.ts 位置 |
|---|---|---|
| StreamReader | `READER_WATCHER_*` | `src/foundation/stream/audit-events.ts` |
| AsyncTaskSystem | `PENDING_WATCHER_*` | `src/core/async-task-system/audit-events.ts` |
| Daemon (InboxWatcher) | `INBOX_WATCHER_*` | `src/foundation/messaging/audit-events.ts` |
| ChatViewport | `WATCHER_*` | `src/cli/commands/viewport-audit-events.ts` |

每 caller 命名空间含 `*_WATCHER_FAILED` + `*_WATCHER_CALLBACK_FAILED` 二事件（详 caller 各自模块契约 §5）。

## 6. 层级声明

L1 OS / external 抽象层 / chokidar 跨平台 fs 事件原语。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 CLI 绕过 FileWatcher 直用 `fs.watch` | drift | 已闭环（phase152）| CLI 散落 fsNative.watch / 候选 β 收敛（stability: 'immediate' 选项落地）|
| A.2 callback / onReady / onError 抛错未隔离 | drift | 已闭环（phase148）| 调用方 throw 透传到 chokidar / try/catch 隔离 + audit |
| A.3 FileWatcher 内化 audit + 依赖 FileSystem | drift | 已闭环（phase327 / `da747c3` + `5373c94` + `cf5e545`）| L1→L2 反向 + L1→L1 横向 / signature 5→3 参数化 + onError context 单回调 + 4 caller bridge audit |
| A.4 code @module 注解层归属 drift `L2.FileWatcher` ↔ 应然 `L1.FileWatcher` | naming/layer drift / 中 | ✅ closed（phase415 / main `6ca0395e`）| **应然权威 = architecture.md §5 + 表 1「FileWatcher L1」**（modules/*.md 内文 L9 / interfaces/l1.md 全 align）。实然 `src/foundation/file-watcher/index.ts:2` 注 `@module L2.FileWatcher` + `types.ts:2` 注释「FileWatcher types (L2)」/ 同 phase378 ShellTool drift 同型（commit author 自治起注 vs arch 权威）/ 治理：code 注解修「L2」→「L1」（2 处）|
| **A.5 fallback poll 实然在 L2 / 应然 L1 内置** | M#5 弱违反 / 中 | ✅ **closed phase 469 (`ec412a1e`)** | **应然 sharpen**：fallback poll 是 OS watch 异构吸收一部分（macOS FSEvents 静默停火兜底）/ 应 L1 FileWatcher 内置 / 跨 OS 平台抹平范围（per §1）。**G1-G3 derive 结论**（详 derive doc）：G1 仅 'immediate' 模式触发 / G2 默认 500ms + caller 可经 `fallbackPollMs?` override / G3 仅 macOS (`process.platform === 'darwin'`) 启用 / 综合判定 `enableFallback = stability === 'immediate' && process.platform === 'darwin'`。**实然 drift**：phase352 实施 fallback poll setInterval(500ms) 在 `src/foundation/stream/reader.ts:215` L2 Stream 内 / 救 L1 chokidar 'immediate' stability macOS 不可靠 / 违 M#5（L2 业务知 L1 OS detail）。**真合规**：(1) L1 FileWatcher createWatcher options 加 `fallbackPollMs?: number` 字段 + 实现内 `enableFallback` 综合判定 + setInterval 启用 / 触发 `{type:'change',path}` event 给 callback（per phase 469 derive）/ (2) L2 Stream reader.ts 删 fallbackTimer + setInterval + FALLBACK_POLL_MS const + 相关 clearInterval 共 5 处 / (3) 同型 4 caller 受益面：StreamReader 自动剥离 / ChatViewport 同 use case 漏覆盖自动获救 / AsyncTaskSystem + InboxWatcher 'immediate' + macOS 启用但实际是「新文件创建」pattern 受益面边际 / 0 perf cost 不破现状。源：phase 448 design 重审 / phase 469 derive + sharpen / phase 469 code 闭环 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| chokidar 未识别事件静默丢弃 | 应然未规定 / 实然采 silent skip / `mapEventType` 返 null → `on('all')` return / 当前 chokidar 只发 5 种 | chokidar 升级新增事件类型 → 重评 |
| `persistent: true` / `ignoreInitial: true` 硬编码 | 应然「持久化观察」职责定位 / 实然采硬编码 | 出现「短命 watch + 初始扫描」场景 → 拆子类或扩 options |
| 事件命名空间分配 α「各 caller 自有 prefix」（phase327）| 应然 silent / 实然采 α | 引入新 caller 沿用同 pattern |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：单一职责 = chokidar 跨平台 FS 事件通知统一封装
- **M#2 业务语义归属**：`createWatcher` / `Watcher.close/isActive/getPath` 业务发起方 / fs watch 可观察性归 caller
- **M#3 资源归属**：FS 事件通知能力归 FileWatcher / audit event 命名空间归各 caller
- **M#4 持久化**：无（订阅状态仅 mem）
- **M#5 依赖单向**：L1 不依赖任何 clawforum 模块 / 仅 chokidar 外部
- **M#6 依赖结构稳定**：构造期参数稳定（path / callback / options）
- **M#7 耦合界面稳定**：`Watcher` 接口 3 方法 + `createWatcher` 3 参数（path / callback / options）
- **M#8 耦合界面最小**：`WatcherOptions` 精选字段（recursive / ignored / stability / persistent / onReady / onError / fallbackPollMs）
- **M#9 显式表达编译器可检**：`stability: 'stable' | 'immediate'` 显式 discriminated / `WatcherErrorContext` 同
- **M#10-M#11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D1b 状态可观察** / **D1c 中断可恢复** / **D1d 事后可审计**：错误经 `onError(err, context)` 单回调 + caller 自写 audit / `Watcher.isActive` / `close()` idempotent
- **D2 不得丢弃/静默**：见 §7.B chokidar 未识别事件偏差
- **D3 用户可观察**：灰度（基础设施）
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：FileWatcher 是事件驱动链路源头
- **D4-D6 / D9-D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：监控 agent dir 文件
- **P2 上下文工程**：无关
- **P3 分多个智能体加分子任务**：FS 事件是 daemon 驱动触发源 / 单一代码基
- **P4 系统为智能体服务**：基础设施 / 不参与决策

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（历史触发 3 次 / 冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase148 / phase152 / phase193 / phase327 各 phase 收尾报告。

关键里程碑：
- phase148：A.2 闭环（callback / onReady / onError try/catch 隔离 + audit）
- phase152：A.1 闭环（CLI fs.watch 全清 / 候选 β stability: 'immediate' 选项落地）
- phase193 L2 FileWatcher backfill（旧 §7 四子节登记 / phase327 前模块为 L2 标记）
- phase327：A.3 闭环 / L1→L2 audit 解耦 + L1→L1 fs 解耦 / signature 5→3 / onError context 单回调 / 4 caller bridge / main `da747c3` + `5373c94` + `cf5e545`
- r44 A：契约结构升 9 节模板 / FileWatcher L2 → L1 应然 align（phase327 的层级修订）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l1.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table + 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design 已正确）
- r60+ design 同步实然：phase327 闭环 sharpening 后 `interfaces/l1.md` FileWatcher 接口形态 lag 修正 — 删 hypothetical `interface FileWatcher { watch(path) }`（实然 0 此 interface / 实然是 functional `createWatcher`）/ `WatchHandle` → `Watcher` 名 + `close/isActive/getPath` 3 方法 / `WatchOptions` → `WatcherOptions` + 加 `ignored` / `stability` / `persistent` / `onReady` / `onError` 字段 / `onError(err)` → `onError(err, context: WatcherErrorContext)` 加 discriminator / `ChangeEvent.type` 'added/modified/deleted' → 'add/change/unlink/addDir/unlinkDir'（chokidar 原生事件名）+ 加 stats 字段 / 删 hypothetical `WatcherStartError` class（实然 createWatcher 同步抛通用 Error / 不抛专 class）
- 2026-05-04 / phase 469 应然 sharpen done（design only / `coding plan/phase469/`）/ G1-G3 derive 完成（详 derive doc）：fallback poll 内置策略 = 'immediate' + macOS 自动启用 / 默认 500ms / caller 可经 `fallbackPollMs?` override / §1.做 加 G1-G3 子条 / §A.5 status 改「应然 sharpen done」/ code 实施推 phase 469+ Step 3-5
- 2026-05-04 / phase 469 code 闭环（`ec412a1e`）：L1 watcher.ts 内置 fallback poll + L2 reader.ts 删 fallbackTimer / tsc 0 error / vitest 1358+ PASS（1 flaky 无关）/ §A.5 status closed
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l1_file_watcher.md vs arch §5 + 表 1/2 + interfaces/l1.md FileWatcher 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d/D2/D3/D7/D8 + D4-D6/D9-D11 无关 + Philosophy P1 监控 agent dir + P3 触发源 + P4 基础设施 + P2 无关 + Path #1-#7）/ 主能力 align arch 表 2（OS watch 原语 + 跨 OS 抹平 + fallback poll 内置 + 句柄生命周期）/ 0 dep + 4 caller align arch 表 1（StreamReader / AsyncTaskSystem / Daemon InboxWatcher / ChatViewport）/ 资源 OS watch 唯一入口 + watch 句柄派生态 align / phase148+152+327+415+469 五 phase cascade closed §7.A / §7.A 0 open / §7.B 3 项偏差皆有升档条件 / design only / 0 src 改
- 2026-05-05 / r65 重核补 §7.C M#8 字段列表加 `fallbackPollMs`（phase 469 加字段后未同步登记 / 同 interfaces/l1.md FileWatcher options 7 字段全集 align）
- 2026-05-09 / **phase 581 fallback poller escalation（D fork r69 / main `678f70fd` / merge `45ce8766`）**（code phase / 主会话 plan + 用户 code / 起步 SHA `6a299b99`）/ §1 fallback poll 内置策略加 G4 escalation 终止条件（mirror reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT = 5 模板）/ watcher.ts 闭包 count consecutiveCallbackFails + check + clearInterval + nullify + onError 'fallback_disabled' / types.ts WatcherErrorContext 加 `'fallback_disabled'` / NEW tests/foundation/file-watcher/fallback-escalation.test.ts（2 it macOS skipIf）/ 3 files +106 -2 / 0 caller cascade（5 caller 既有 binary discrimination 自然落入 else 分支 = FAILED tier）/ 0 audit dep（M#5 layering 严守）/ **「dispatch audit event 标 framing 不全 → Path #1 实测层级核 → onError callback 模板」N+1 实证**（接 phase 563 helper 命名 refine）/ **「caller binary discrimination NEW context 自然落入 else → 0 caller cascade」首发模板**（升格独立 feedback 候选）/ **CONSECUTIVE_FAIL_LIMIT 模板复用 N=2 实证**（reader.ts 首发 + 本 phase / 推 r+ 累实证升格独立 feedback「同模块同型 escalation 模板」）/ **「review claim 实测四态分类」第 4 phase 实证**（phase 556+563+567+581 / Meta 38 升格阈值更近）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#1 命名空间分配 α「各 caller 自有 prefix」（phase327）| ✓ 4 caller bridge 落地 / Stage 2 后续 leak 模块（LLMService 等）直接复用 |
| KD#2 onError(err, context) 单回调 α | ✓ phase327 决策 / context discriminator 'watch' \| 'callback' \| 'ready' |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **createWatcher 基本路径**：事件映射（add/change/unlink/addDir/unlinkDir）/ stats 字段（size/mtime）
- **生命周期**：close idempotent / isActive 状态查询 / getPath 返回绝对路径
- **stability 分支**：'stable' 100ms 稳定性窗口 / 'immediate' 立即触发 / 二者行为差异
- **onError 三 context**：chokidar `'watch'` 错误 / callback 抛错 `'callback'` / onReady 抛错 `'ready'` / 后续事件仍正常 deliver
- **caller 隔离**：callback / onReady / onError 抛错经 try/catch 隔离 / 不冒泡到 chokidar

## phase 695 — r93 E fork V4-P1.3 fallback-escalation Tier 1 + V4-P1.2 设计判断 row

### V4-P1.3 fallback-escalation `setTimeout(100)` 紧 margin → `waitFor`（closed by phase 695）

- **claim**：`tests/foundation/file-watcher/fallback-escalation.test.ts:41` 用 `setTimeout(100)` 等 6 poll × 10ms = 60ms / margin 40ms 在慢 CI 紧
- **状态**：C1+(b) verified
- **结论**：closed by phase 695 / 改用 `await waitFor(() => errors.some(e => e.context === 'fallback_disabled'), 2000)` / 等真实 audit event 落盘 / 不墙钟猜测

### V4-P1.2 file-watcher.test conditional assertion silent skip 设计判断 row

- **claim**：`tests/foundation/file-watcher.test.ts:122-130` 500ms 物理 sleep + `if (errors.length > 0) { expect(...) }` / chokidar 慢于 500ms 触发时 silent pass
- **业务决策**：测试设计判断（如何处理 chokidar 本质 nondeterministic）
- **选项**：
  - α：强制错误条件（unlink watched file / 真实触发 ENOENT）+ waitFor strict / 0 silent skip
  - β：保现状 + 改注释说明「tolerates async error window」/ 显式承认 nondeterminism
  - γ：删测试 + 用确定性 contract 测试替（如 watcher.close() 必走 onError finalizer）
- **28 原则核**：
  - M#1 fail-loud → α（silent skip 违反）
  - 测试 oracle quality（phase 677 实证）→ α
  - 维护成本 → β
- **主会话预期**：α 强制错误条件 + waitFor strict / 防 silent skip
- **决策状态**：**closed by phase 703**（r94 D-1 / α.1 minimal — 替 conditional 为 `waitFor` strict / 28 原则 derive：DP「不得静默忽略」+「状态可观察」推翻 β/γ / 用户确认 framework 后主会话自决 land / 不立 ratify gate per r93 D 教训）

## phase 711 — file-watcher.test.ts global spy lifecycle gap closed（r96 D fork）

### P3-P1.1 + P3-P1.2 `process.platform` getter spy + `globalThis.setInterval` spy 无 afterEach restore（closed by phase 711）

- **claim**：`tests/foundation/file-watcher.test.ts` 6 处 `vi.spyOn(process, 'platform', 'get')` + `vi.spyOn(globalThis, 'setInterval')` / afterEach 仅 `fsp.rm`（无 `vi.restoreAllMocks()`）/ 跨 worker（vitest threads pool）spy leak
- **状态**：C1 verified tight
- **结论**：closed by phase 711 / afterEach add `vi.restoreAllMocks()` / mirror phase 675 test_spy_mock_lifecycle 模板
- **derive**：DP「状态可观察」+「不丢弃静默忽略」/ 跨 worker 不可见 global state mutation 违反
