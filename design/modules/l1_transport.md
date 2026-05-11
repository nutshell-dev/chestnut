# Transport 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) Transport 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §4「Transport 本质：持久双向通道能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Transport 的单一职责 = **持久双向连接通道的原语暴露加协议异构吸收**：

- **持久双向连接原语暴露**：监听加连接管理加定向发送加广播加生命周期回调 — 这是任何持久双向通道（socket / pipe / WebSocket / Named Pipe / etc）共同的能力概念。
- **协议异构吸收**：具体连接协议（UDS / TCP / WebSocket / Windows Named Pipe / etc）是内部实现细节 — 调用方写一套代码经不同协议跑（derive 自 Design Principle「分布式部署加跨 OS 平台」加「CLI 可替换为远程调用」）。
- **失败语义二分**：预期失败（broadcast 单连接失败 / disconnect 原因）经返回值或回调参数暴露；不可预期失败（用户回调抛错 / server-level 错误）经独立 `onTransportError` 通道暴露 — 让 caller 区分两类失败做不同决策（M#7 耦合界面稳定 derive）。

> 具体 API 形态归 [interfaces/l1.md](../interfaces/l1.md) Transport 节。具体行为细节（消息边界 framing 加 stale socket 清理加错误隔离 try/catch 加 onTransportError 递归边界 console.error 兜底等）的存在依据是「持久双向通道原语 + 实现细节」— 实然采纳的协议加细节差异（当前仅 UDS）登记 §7.B。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / Gateway / inbox / outbox / 业务消息 schema 等）— derive 自 M#2 业务语义归属（Transport 业务语义仅 IPC 级）加 M#5 单向依赖
- **不 own 跨进程消息持久化**（实时通道掉线即丢 / 持久化通信走 L2 Messaging 的 inbox 加 outbox）— derive 自 M#1 独立可变职责
- **不 own 业务消息 schema 加路由**（data 是 opaque string / 业务含义归装配方提供的连接消费者）— derive 自 M#2
- **不 own 连接鉴权 / 授权 / 限流**（消费者或未来安全层职责）— derive 自 M#1
- **不 own 重连策略**（消费者侧业务）— derive 自 M#1
- **不 own 消息 buffer / retry**（best-effort delivery / 上层做更高层 backpressure）— derive 自 M#1
- **不 own TLS / 加密**（消费者或未来安全层职责）— derive 自 M#1
- **不 own audit**（调用方经 onTransportError / onDisconnect 回调获取信号 / 在自有命名空间写 audit）— derive 自 M#1 + M#2

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Transport 的业务语义边界：

- **own**：IPC 级连接概念 — connectionId 加 socketPath 加 message 字节流加 framing 边界。这些是 Transport 唯一懂的「业务」（IPC 抽象层级，不是 clawforum 业务层级）。
- **角色定位**：Transport 是「**实时通道**」非「**持久存储**」。掉线即丢，不保证不丢消息（持久化通信走 L2 Messaging）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Transport 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `socketPath`（或等价协议端点 / 构造期参数）| 持久化（独占 / 实例运行时占用文件路径或端口）| ✓ socket 文件 |
| connections 运行期连接句柄 | 派生态 | ✗ 内存 Map / 重启即丢 |

**持久双向连接通道访问** — clawforum 内部任何实时双向通信必经 Transport 间接访问（M#5 业务模块不直 import `node:net` / `ws` 等）/ 是 clawforum 对 OS / 协议库通道能力的唯一调用入口。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Transport 自身的持久化立场：

- **模块零业务状态**：Transport 不持自有业务 artifact — 实时通道，掉线即丢，连接表仅在内存。
- **协议端点持久态**：UDS socketPath 等协议产物是 OS-level 资源（进程在则文件在 / close 时清理 / 崩溃残留由下次 listen 探测活性 unlink）— 这是协议机制的「持久化痕迹」，非 Transport 业务持久化。
- **重建语义**：进程重启时所有 connection 随进程销毁，客户端需重连；调用方装配期重新 listen 即可重建监听端点。

## 5. 审计事件清单

**Transport 不产生任何 audit 事件**（应然 / cross-cutting 业务归 caller / Transport 是 L1 原语）。

调用方（Gateway）通过 `onTransportError` / `onDisconnect` 等回调获取信号 / 在自有命名空间写 audit。

> 递归边界例外：`onTransportError` 回调自身抛错时由 `console.error` 兜底（不通过自身回调通道 / 防递归）/ 类似 AuditLog `[AUDIT CRITICAL]` 形态。

## 6. 层级声明

L1 原语 / 实时双向持久连接抽象。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 broadcast 单连接失败走 console.error | drift | 已闭环（phase253 / `85d1a60`）| `broadcast(data)` 返 `{ failed: BroadcastFailure[] }` / Gateway 按列表 dropConnection / console.error 清零 |
| A.2 单连接 'error' 原因丢失 | drift | 已闭环（phase253）| `onDisconnect` 签名扩 `reason?: Error` / 单连接 'error' 事件保存 reason / 'close' 时透传 / Gateway 联动更新签名 |
| A.3 回调抛错 / server error 走 onTransportError 显式通道 | drift | 已闭环（phase253）| 新增 `onTransportError(cb)` + `fireTransportError` 私有方法（递归边界 = console.error 地板 / 类 `[AUDIT CRITICAL]`）/ safeFire catch 改调 fireTransportError / server error → fireTransportError({ kind: 'server_error' }) |
| **A.4 probeAndCleanStale unlink 失败 silent** | drift / 中 / r68 C fork phase 561 derive | **closed by phase 561**（main `3739dc1a` / merge `6cd2b6f2`）| 实然 `unix-socket.ts:69-73` `fs.unlink(socketPath).catch(err => console.error(...)).then(() => resolve())` / unlink 失败仅 console.error / 后续 tryListen(false) 再撞 EADDRINUSE / **真错原因丢** / 违 D2 + D5。**为何 fireTransportError 路径不通**：listen() 在 caller register `onTransportError` 之前调用 / probeAndCleanStale 阶段 transportErrorCbs 为空 / event 落地 silent。**phase 561 决策（28 原则核 5/5 一致 dominant 自决）**：α reject 路径 / unlink 失败 → reject(`unlink stale socket X failed: <reason>`) / ENOENT 例外 silent（race 良性 / 文件已不在）/ caller (Gateway) 经 listen() reject 链路 audit `STARTUP_FAILED` 拿到真原因 / fail-fast（unlink 不行后续 bind 必失 / 省一次冗余尝试）/ β 给 transport 加 audit dep 引新依赖过度 reject / γ fireTransportError 现执行流时序下死路 reject |

> **§7.A = §A 登记的 4 条必修违规 — A.1-A.3 phase253 清零（main `85d1a60`） / A.4 phase 561 清零（main `3739dc1a`）**。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `listen(options?)` optional 与实然必填不一致 | interface 签名 `?` 暗示可不传 / 但 UDS 实现运行时必填 socketPath / 违 M#9 编译期可检 | 候选 α：`listen(options: TransportOptions)` 去掉 `?` + socketPath 改必填 / 候选 β：discriminated union 按协议区分字段 / 与「未来多协议并存的 options 组织」合并讨论 |
| `broadcast` best-effort 是显式设计决策 | Gateway 契约明确「backpressure 时 drop oldest」由 Gateway 做而非 Transport / Transport 只保证单连接失败不影响其他连接 | / |
| `Connection` 字段极小（仅 id + connectedAt）| 是否需要 remoteAddr / authContext 等留给未来 / 当前 UDS 同机本地无此需求 | 跨机 / 鉴权需求出现 |
| 空消息交付 | 连续分隔符产生的空字符串交付调用方决定是否忽略 / 显式设计决策（Transport 不替调用方判断「空消息」语义）| / |
| stale socket 清理的竞态窗口 | 探测 → unlink → listen 之间微小窗口 / 另一进程可能抢 listen | 当前被「daemon 单实例」约定兜住（ProcessManager 保证同 claw 只有一个 daemon）/ 不额外锁定 |
| `Connection` 类型与 Gateway 契约同名 | 两处指同一对象 / 类型层共享 / 非运行时耦合 | / |
| `onTransportError` 回调自身抛错走 console.error | 递归边界（类似 AuditLog `[AUDIT CRITICAL]`）/ 至此不再回推 | / |
| 实然仅 POSIX UDS / 不跨机 / 不支持 Windows named pipe | 与 ProcessExec sh 硬编码同型决策 / 当前部署聚焦 Unix | 跨 OS 适配启动 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：UDS IPC 封装 / 与「连接消费者业务」（Gateway）独立可变
- **M#2 业务语义归属**：connection 生命周期 / send / broadcast 由本模块发起
- **M#3 资源归属**：socketPath 独占
- **M#4 持久化**：无关
- **M#5 依赖单向**：Transport → Node.js net/fs / 0 反向
- **M#6 依赖结构稳定**：Transport interface 稳定
- **M#7 耦合界面稳定**：灰度（§7.B TransportOptions.socketPath optional 与实然必填不一致登记）
- **M#8 耦合界面最小**：Transport 接口 9 方法（listen / close / send / broadcast / getConnections / onConnect / onDisconnect / onMessage / onTransportError / phase253 后扩 onTransportError + onDisconnect reason）
- **M#9 显式表达编译器可检**：灰度（§7.B listen options 不一致登记 / TransportErrorEvent discriminated union ✓）
- **M#10-M#11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：phase253 闭环（broadcast 失败 + disconnect reason + server error 全部传播）
- **D1b 状态可观察**：phase253 闭环（onDisconnect(reason) 透传连接断开原因）
- **D1c 中断可恢复**：close idempotent
- **D1d 事后可审计**：无关（audit 归调用方 Gateway）
- **D2 不得丢弃/静默**：phase253 全清零 / 无静默丢弃路径
- **D3 用户可观察**：phase253 闭环（onTransportError 回调将 Transport 错误传递至 Gateway / 可达用户侧）
- **D5 日志重建**：phase253 闭环（Transport 层所有信息经 onTransportError / onDisconnect 传播至 Gateway / Gateway phase256 已落 audit / 重建链路完整）
- **D7 系统可信路径**：stale socket 探测 + 单实例保护
- **D8 事件驱动**：onMessage / onConnect / onDisconnect 事件驱动
- **D9 CLI 唯一对外**：无关（Transport 是 motion ↔ TUI/IM bot 数据面通道 / 不替代 CLI 控制面 / 数据面 vs 控制面分离）
- **D10 多 claw 信息不隔绝**：Transport 不直接承载多 claw 间通信（多 claw 持久化通信走 L2 Messaging inbox+outbox）/ Transport 是 motion ↔ 外部客户端实时数据面通道
- **D11 motion 特殊**：Transport motion 独占（实然 motion-only / D11 align）
- **D4 / D6**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：无关（IPC 通道 / 不直接消费目录形态）
- **P2 上下文工程**：IPC 承载 agent 间上下文
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

详 phase187 / phase253 / phase275 / phase284 各 phase 收尾报告。

关键里程碑：
- phase187 L1 Transport 契约 backfill / §A 3 条修复方向登记 + 实测 5 位点判据表
- phase253 §7.A 3 条全清零（main `85d1a60`）/ broadcast 返 `{ failed }` / `onDisconnect(reason?)` / 新增 `onTransportError` 协议 / Gateway 联动更新
- phase275 G6 console 评估 / Path #1 实测确认 phase253 3/3 清零 / N1 drift 修订（unix-socket.ts:148 safeFire 位点表 + L155 fireTransportError 递归守护补登）
- phase284 §7.C cascade 补登记（D1a/D1b/D2/D3/D5 灰度→合规）
- r44 A：契约结构升 9 节模板 / phase253 闭环状态保留 audit trail
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l1.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table + 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design 已正确）
- r60+ design 同步实然：phase253 闭环 sharpening 后 `interfaces/l1.md` Transport 接口签名 lag 修正 — `startListen/stopListen` → `listen/close` / `send(target, msg: unknown)` → `send(connectionId, data: string)` / `broadcast(msg)` → `broadcast(data): { failed: BroadcastFailure[] }` / 加 `onDisconnect` + `getConnections` / `onError` → `onTransportError` + `TransportErrorEvent` discriminated union / `ConnectionInfo` → `Connection` / 删 hypothetical `TransportError` class（实然不存在）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l1_transport.md vs arch §4 + 表 1/2 + interfaces/l1.md Transport 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d/D2/D3/D5/D7/D8/D11 + D9/D10 + D4/D6 无关 + Philosophy P2 承载 + P1/P3/P4 中性 + Path #1-#7）/ 3 主能力 align arch 表 2（持久双向连接 + 协议异构吸收 + 失败语义二分）/ 0 dep + Gateway caller align arch 表 1 / 资源 socketPath + connections 派生态 align / phase253 §7.A 3/3 + phase256 Gateway audit 联动 + phase284 §7.C cascade / §7.A 0 open / §7.B 8 项偏差皆有升档条件 / design only / 0 src 改
- 2026-05-05 / r65 重核补 §7.C M#8 method 计数 stale 同步（7 → 9 / phase253 闭环扩 onTransportError + onDisconnect reason 后未跟进）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#11 Transport 独立原语（实时双向通信与文件 I/O / 进程调用并列为第三种 I/O 原语）| ✓ |
| KD（应然）broadcast 预期失败走返回值 / callback 不可预期失败走 onTransportError | ✓ phase253 闭环 |
| KD（应然）frame 协议对调用方不可见 | ✓（UDS `\n` 分隔 / 未来 TCP/WebSocket 可换不破坏接口）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **生命周期**：listen / close idempotency / double listen 抛错 / close 后 listen 抛错
- **单连接路径**：往返 / 未知 id 抛错 / 单连接 'error' onDisconnect reason 透传
- **broadcast**：成功 + 单连接失败计入 `{ failed }` 列表（phase253）
- **回调隔离**：onConnect / onDisconnect / onMessage 抛错经 onTransportError 暴露 / 不影响其他回调
- **server error**：onTransportError({ kind: 'server_error' }) 触发
- **递归边界**：onTransportError 回调自身抛错走 console.error
- **stale socket**：死进程残留 unlink + 活进程占用拒启动
- **chunk 分帧**：消息边界 / 空消息交付
- **race**：close 期间 listen reject
- **并发连接**：多连接同时

## phase 695 — r93 E fork V4-P2.5 transport.test Windows skipIf gate Tier 1 land

### V4-P2.5 transport.test `describe('UnixDomainSocketTransport')` 0 win32 skipIf（closed by phase 695）

- **claim**：`tests/foundation/transport.test.ts:63` UNIX domain socket describe 块 0 Windows 平台 gate
- **状态**：C2 platform / verified（实读 line 63）
- **结论**：closed by phase 695 / 加 `describe.skipIf(process.platform === 'win32')(...)` / mirror `tests/foundation/file-watcher/fallback-escalation.test.ts` darwin-only skipIf 模板 / Windows CI 跳过整 describe（UNIX socket 平台限定）
