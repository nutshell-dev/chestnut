# Transport 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md ~~§5~~ §4 align）：L1 实时双向持久连接原语。管理 connection 生命周期，提供消息推送 / 接收能力。具体协议（socket / pipe / WebSocket / 等）是内部实现细节，契约层不暴露。

**实然**：当前实现 `UnixDomainSocketTransport`（local UDS / 单机 IPC）；`socketPath` 位置由调用方装配期决定（建议 `~/.clawforum/<clawId>/transport.sock`）。

**归属**：
- **应然**：L1 原语 / 装配归属「按需」（任何需要持久连接通信的 daemon 装）
- **实然**：default 配置 motion daemon 启用 listen / 当前实然 Gateway 是唯一上游消费者
- **依赖**：无（不反向依赖 L2）
- **被调用**（应然）：装配方提供的连接消费者（任何需要持久连接通信的模块）；**实然**：Gateway 唯一上游

## 职责边界

### 做

1. `listen` / `close` 管理监听生命周期；`close` idempotent
2. `send(connectionId, data)` 定向发送；未知 id 抛错（调用方捕获后决策 drop 连接）
3. `broadcast(data)` 广播；best-effort——单连接写失败不冒泡、不影响其他连接
4. 连接建立 / 断开 / 消息回调（`onConnect` / `onDisconnect` / `onMessage`）
5. 消息边界保证：每次 `onMessage` 回调收到"一条完整逻辑消息"；frame 方案（当前 `\n` 分隔）对调用方不可见
6. 错误隔离：单连接 socket 错误、回调抛错不冒泡；server-level 错误只记 log
7. stale socket 清理：`listen` 前若 socket path 残留，探测活性——死进程残留则 unlink；活进程占用则抛错拒绝启动

### 不做

- 不解析消息语义（`data` 是 opaque string / 业务含义归装配方提供的连接消费者）
- 不做连接鉴权 / 授权 / 限流（消费者或未来安全层职责）
- 不自己维护消息 buffer / retry（best-effort delivery / 上层做更高层 backpressure）
- 不做 TLS / 加密
- **应然**：跨机 / Windows named pipe 等具体协议不在契约层约束，由具体实现决定支持范围
- **实然**：当前实现仅 local UDS（不跨机 / 不支持 Windows named pipe）

## 接口

```ts
interface Connection {
  id: string;                // 实现生成（当前 UDS 用 randomUUID）；对调用方 opaque
  connectedAt: number;       // Unix ms timestamp
}

interface TransportOptions {
  socketPath?: string;       // 本地 IPC 路径（UDS 专属）；见"与现状的差异" B 类
}

interface BroadcastFailure {
  connectionId: string;
  error: Error;
}

type TransportErrorEvent =
  | { kind: 'callback_error'; callbackName: 'onConnect' | 'onDisconnect' | 'onMessage' | 'onTransportError'; connectionId?: string; error: Error }
  | { kind: 'server_error'; error: Error };

interface Transport {
  listen(options?: TransportOptions): Promise<void>;
  close(): Promise<void>;                                      // idempotent

  send(connectionId: string, data: string): void;              // 未知 id 抛错
  broadcast(data: string): { failed: BroadcastFailure[] };     // 预期失败走返回值

  getConnections(): Connection[];
  onConnect(cb: (conn: Connection) => void): void;
  onDisconnect(cb: (conn: Connection, reason?: Error) => void): void;
  onMessage(cb: (conn: Connection, data: string) => void): void;
  onTransportError(cb: (evt: TransportErrorEvent) => void): void;  // 不可预期失败显式通道
}
```

关键约定：
- **消息帧协议对调用方不可见**：`onMessage` 每次回调 = 一条完整逻辑消息；底层如何分帧（UDS 用 `\n`，未来 TCP/WebSocket 可换）不属接口层
- **空消息仍交付**：连续分隔符产生的空字符串也会走 `onMessage`，由调用方决定忽略
- **`send` 未知 id 抛错**是设计语义（预期失败，由 Gateway try/catch 后 drop 连接），不是 bug
- **`broadcast` 返回失败列表**：单连接写失败不冒泡、不影响其他连接，但失败 connectionId 与错误原因通过返回值暴露；Gateway 按列表 drop 连接或审计
- **`onDisconnect(conn, reason?)`**：被动断开且有 socket `'error'` 捕获到原因时透传；主动关闭 / 无错误断开时 `reason` 为 `undefined`
- **`onTransportError`**：承接"不可预期失败"——用户回调抛错、server-level 错误等；调用方（Gateway）负责 emit 审计事件 / 告警；Transport 内部仍做错误隔离防主路径崩溃
- **`close` 期间 pending `listen`** 会让 `listen` reject

## 失败语义

| 失败源 | Transport 行为 |
|---|---|
| `listen` 缺 `socketPath` | 抛 `Error('socketPath required')` |
| `listen` 时 socket 文件残留且无进程占用 | 自动 unlink 后重试 listen |
| `listen` 时 socket 文件被活进程占用 | 抛 `Error('socket ... is in use by a live process')` |
| `listen` 其他错误 | 原样抛 Node 错误 |
| 重复 `listen` | 抛 `Error('transport already listening')` |
| `listen` 期间调用方调 `close()` | server 被 close，`listen` reject `Error('transport closed during listen')` |
| `close()` 后再 `listen` | 抛 `Error('transport already closed')` |
| 重复 `close()` | no-op，idempotent |
| `send` 传入未知 connectionId | 抛 `Error('unknown connection: <id>')` |
| `broadcast` 中单连接 write 抛错 | 计入返回值 `failed`（含 connectionId + error），继续处理下一个连接；调用方按列表决策 drop / 审计 |
| 单连接 socket 触发 `'error'` | 捕获 error，随后 `'close'` 触发 `onDisconnect(conn, reason)` 携带该 error |
| `onConnect` / `onDisconnect` / `onMessage` 回调抛错 | Transport 内部 try/catch 隔离，不影响其他回调；通过 `onTransportError({ kind: 'callback_error', callbackName, connectionId?, error })` 暴露 |
| `onTransportError` 回调自身抛错 | 再捕获后 `console.error`（递归边界，类似 AuditLog `[AUDIT CRITICAL]`）——至此不再回推 |
| server-level `'error'` | 通过 `onTransportError({ kind: 'server_error', error })` 暴露；Transport 状态不自动改变 |

## 不可消除的耦合

- **无跨模块运行时耦合**。**应然**：消费者通过 interface 调用 / **实然**：当前唯一消费者 Gateway。
- **`Connection.id` 是 opaque 字符串**：Transport 生成、消费者持有；两边对 id 的字符集 / 长度 / 唯一性无共享约束——契约只保证"实现内唯一且稳定"。
- **frame 协议对调用方不可见**：UDS → TCP / WebSocket 切换时 frame 方案会变；调用方不得假设 `\n` 分隔等实现细节。此隐藏是显式设计决策。
- **`TransportOptions` 与实现协议相关的字段**（当前 `socketPath`）：interface 层用 optional 吸纳特化字段，属轻微界面泄漏；见 B 类登记。

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `socketPath` | 调用方装配期传入 | 本模块不决定路径策略；建议 `~/.clawforum/<clawId>/transport.sock` |
| frame 分隔符（当前 `\n`） | UDS 实现内部 | 不暴露；未来非 UDS 实现可换 |
| 连接 id 生成（`randomUUID`） | UDS 实现内部 | interface 仅约束"实现内唯一" |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规（✅ phase253 全部清零）

**A.1 `broadcast` 单连接失败走返回值而非 `console.error`** — ✅ phase253 已清零

违反原则："预期失败由调用方显式处理"——broadcast 写失败是可预期事件，应由 Gateway 决策 drop / 审计；而非吞进 log。

**已修复**（phase253 `ee24df5`）：`broadcast(data)` 返回 `{ failed: BroadcastFailure[] }`；Gateway 按列表 dropConnection，`console.error` 已清零。

**A.2 单连接 `'error'` 原因通过 `onDisconnect(conn, reason?)` 透传** — ✅ phase253 已清零

违反原则："事后仅凭日志和记录能完整重建决策链路"——原先断开原因丢失。

**已修复**（phase253 `ee24df5`）：`onDisconnect` 签名扩 `reason?: Error`；单连接 `'error'` 事件保存 reason，`'close'` 时透传；Gateway 联动更新签名。

**A.3 回调抛错 / server error 走 `onTransportError` 显式通道** — ✅ phase253 已清零

违反编码规范："不可预期失败暴露而非吞没"。回调内部 bug、server-level 错误属"不可预期失败"，不应降级到 `console.error`。

**已修复**（phase253 `ee24df5`）：新增 `onTransportError(cb: (evt: TransportErrorEvent) => void)` + `fireTransportError` 私有方法（递归边界 = console.error 地板，类 `[AUDIT CRITICAL]`）；`safeFire` catch 改调 `fireTransportError`；server error → `fireTransportError({ kind: 'server_error' })`。Gateway 已注册 interim 处理器（console.error 临时，待 Gateway A.3 audit phase 替换）。

**原则分工**（设计依据保留）：broadcast 失败 / disconnect reason = **预期失败**，走返回值 / 回调参数；callback / server 错误 = **不可预期失败**，走 onTransportError 通道。与 LLMService `LLMEventSink` 同构。

### B. 偏差登记（当前合理或代价过高）

- **`listen(options?)` 的 optional 与实现必填不一致**：interface 签名的 `?` 暗示可不传；但 UDS 实现运行时必填 `socketPath`。违反编码规范"名字准确反映意图"——编译期可捕获的约束推到运行期。修复候选：
  - 候选 α：`listen(options: TransportOptions)` 去掉 `?`；`TransportOptions.socketPath` 也改为必填
  - 候选 β：`TransportOptions` 拆成 discriminated union，按协议区分字段
  - 与"未来多协议并存的 options 组织"合并讨论
- **`broadcast` best-effort 是显式设计决策**：Gateway 契约明确说"backpressure 时 drop oldest"由 Gateway 做而非 Transport——Transport 只保证单连接失败不影响其他连接。best-effort 属**显式决策**路径；但失败通道没暴露就滑入违规（见 A.1）
- **`Connection` 字段极小**：仅 `id + connectedAt`。是否需要 `remoteAddr` / `authContext` 等留给未来——当前 UDS 同机本地无此需求
- **空消息交付**：连续分隔符产生的空字符串交付调用方决定是否忽略。属**显式设计决策**——Transport 不替调用方判断"空消息"语义
- **stale socket 清理的竞态窗口**：探测 → `unlink` → `listen` 之间微小窗口，另一进程可能抢 listen。当前被 "daemon 单实例" 约定兜住（`ProcessManager` 保证同 claw 只有一个 daemon），不额外锁定
- **`listen` 与 `close` 的 race**：`closed=true` 在 listen 回调中检查的路径已在失败语义表登记
- **`Connection` 类型与 Gateway 契约同名**：两处指同一对象；类型层共享，非运行时耦合

## 测试覆盖现状

`tests/foundation/transport.test.ts`（20 个 it）覆盖契约主要行为：listen/close idempotency、单连接往返、广播、断线、消息回调、未知 id 抛错、并发连接、stale 清理、活进程保护、chunk 分帧、close 后状态、double listen、race、回调错误隔离、空消息；及 phase253 新增：`onTransportError` 注册与触发（server error / connection error）、`broadcast` 返回 `{ failed }` 列表、`onDisconnect` reason 透传。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A ↔ §A 映射

既有 "§A 修复方向" 节已登记 3 条修复方向（onTransportError 协议 / `{ failed: BroadcastFailure[] }` 返回 / `onDisconnect(reason?)`）。phase187 实测复核：

| 位点 | 判据 | 映射 | 状态 |
|---|---|---|---|
| `unix-socket.ts:51` server error | **已清零** | A.1 — onTransportError | ✅ phase253 |
| `unix-socket.ts:70` stale socket 清理失败 | **合规**（cleanup 辅助；主失败已 throw） | - | 保留 |
| `unix-socket.ts:97` connection error | **已清零** | A.2 — onDisconnect(reason) | ✅ phase253 |
| `unix-socket.ts:118` broadcast write error | **已清零** | A.3 — `{ failed: BroadcastFailure[] }` | ✅ phase253 |
| `unix-socket.ts:148` safeFire 递归边界 | **合规** → 改为 fireTransportError 调用 | - | ✅ phase253（safeFire 不再 console.error / 改调 fireTransportError） |
| `unix-socket.ts:155` fireTransportError 递归守护 | **合规**（態③ 递归边界：callback 抛出时不得再调 fireTransportError 否则无限递归）| - | 保留（phase253 引入 fireTransportError 时同步引入） |

**§7.A = §A 登记的 3 条必修违规 — 已于 phase253 全部清零**。

### 7.B ↔ §B 映射

既有 §B 登记 6 条（listen optional 不一致 / broadcast best-effort / Connection 字段极小 / 空消息交付 / stale race 窗口 / Connection 类型同名）。phase187 补 0 条。

### 7.C 原则对照（32 条）

全 32 条覆盖。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规（UDS IPC 封装）
- **M2 业务语义归属**：合规
- **M3 资源归属**：合规（socketPath 独占）
- **M4 持久化**：无关
- **M5 依赖单向**：合规
- **M6 依赖结构稳定**：合规（Transport interface 稳定）
- **M7 耦合界面稳定**：灰度（§B TransportOptions.socketPath optional 与实现必填不一致登记）
- **M8 耦合界面最小**：合规
- **M9 显式表达编译器可检**：灰度（§B listen options 不一致登记）
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条）

- **D1a 信息不丢失**：合规（phase253 §7.A A.1/A.2/A.3 全清零后，broadcast失败/disconnect reason/server error 全部传播；灰度消除）
- **D1b 状态可观察**：合规（phase253 A.2 清零后，onDisconnect(reason) 透传连接断开原因，状态可观察；灰度消除）
- **D1c 中断可恢复**：合规（close idempotent）
- **D1d 事后可审计**：无关（audit 归调用方 Gateway）
- **D2 不得丢弃/静默**：合规（phase253 §7.A A.1/A.2/A.3 全清零后无静默丢弃路径；灰度消除）
- **D3 用户可观察**：合规（phase253 A.3 清零后，onTransportError 回调将 Transport 错误传递至 Gateway，可达用户侧；灰度消除）
- **D4 LLM 调用恢复**：无关
- **D5 日志重建**：合规（phase253 §7.A 全清零后，Transport 层所有信息经 onTransportError/onDisconnect 传播至 Gateway，Gateway phase256 已落 audit，重建链路完整；灰度消除）
- **D6a 决策主体**：无关
- **D6b 子代理不阻塞**：合规
- **D7 系统可信路径**：合规（stale socket 探测 + 单实例保护）
- **D8 事件驱动**：合规（onMessage / onConnect / onDisconnect 事件驱动）
- **D9 多 claw 不隔绝**：无关
- **D10 motion 特殊**：合规（Transport motion 独占，modules.md §5 明示）
- **D11 CLI 唯一对外**：无关（Transport 是 motion ↔ TUI/IM bot 通道，不替代 CLI）

#### Philosophy（3 条）

- **P1 上下文工程**：合规（IPC 承载 agent 间上下文）
- **P2 多 agent 复用**：合规
- **P3 Agent 即目录 / 对话即状态**：无关

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ Read 源码 274 行 + 测试 17 it
- **Path #2 差距显式登记**：✓ §A 3 条 + §B 6 条
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = backfill
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only
- **Path #5 完成后复盘**：将于 phase187 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#11（原 modules.md）Transport 独立原语**：实时双向通信与文件 I/O、进程调用并列为第三种 I/O 原语

---

### 7.Phase 执行纪律

#### phase187 纪律 — L1 Transport backfill（2026-04-21，design 本地 only）

- **scope**：既有 §A/§B/测试覆盖节完整；phase187 补 §7.C 32 条原则对照 + §7.Phase + console 位点实测表
- **产出**：§7.A ↔ §A 映射 + 实测 5 位点判据表 / §7.B ↔ §B 无补 / §7.C 32 条 / §7.Phase（本节）
- **对比定位**：与 LLMService 同属 "需 event sink wire" L1（3 软吞）；修复方向已定（onTransportError 协议）
- **方法论贡献**：契约 §A 修复方向与实测位点逐一对齐表首次落地

#### phase253 纪律 — Transport §7.A 清零（r17 分支 C / main 85d1a60）

- **scope**：3 条 §7.A 软吞清零（A.1 server error / A.2 connection error / A.3 broadcast write error）
- **接口破坏性变更**：`broadcast` void→`{ failed: BroadcastFailure[] }` / `onDisconnect(conn,reason?)` / 新增 `onTransportError`
- **safeFire 改造**：catch → `fireTransportError` / 新增 `fireTransportError` 递归边界方法
- **Gateway 联动清零**：A.2 联动违规（2 处 console.error 兜底）
- **Gateway A.3 解锁**：Transport 已暴露结构化通道 / 11 个 Gateway audit 事件独立 phase 可执行
- **测试**：17 it 全更新 + 新增 3 it = 20 it（transport.test.ts）；gateway mock 同步更新

#### phase275 纪律 — G6 console 评估（r21 分支 F / 2026-04-24 / design 本地 only）

- **scope**：phase226 G6 Transport console 全评估 / 路径事实核查
- **Path #1 实测**：unix-socket.ts 2 处 console.error：L71（stale socket cleanup 辅助 / 合规保留 / 已登记）+ L155（fireTransportError 递归守护 / 態③ 合规保留 / **N1 drift 补登**）
- **N1 drift 修正**：L148 safeFire 位点表描述更新 + 新增 L155 fireTransportError 递归守护条目
- **结论**：G6 §7.A 全清零（phase253 3/3），无代码改动，无真残留

#### phase284 纪律 — §7.C cascade 补登记（r23 分支 F / 2026-04-25 / design 本地 only）

- **scope**：§7.C 全模块复核 phase284 发现；Transport §7.A A.1/A.2/A.3 phase253 全清零后 §7.C cascade 遗漏补登
- **触发源**：phase279 叙述式补扫方法识别 Transport 同属"叙述式灰度未同步"模式
- **cascade 前进 5 条**：D1a 灰度→合规 / D1b 灰度→合规 / D2 灰度→合规 / D3 灰度→合规 / D5 灰度→合规
- **保留不动**：M7/M9 灰度（→§7.B structural）/ D1d 无关（audit 归 Gateway）

### 7.编号 drift 表

| modules.md 应然 § | 本契约引用 § | delta | 说明 |
|---|---|---|---|
| §4 | ~~§5~~ §4（已修） | -1 → 0 | 新增 FileTool(§14)/ShellTool(§15) 导致后续模块编号 +2 drift / phase324 sharpening 修正 |

