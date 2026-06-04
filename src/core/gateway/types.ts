/**
 * Gateway module types (L3)
 *
 * 外部客户端 ↔ 内部系统 的实时交互门面。
 *
 * 不可消除耦合（显式）：
 * 1. Gateway → Daemon interrupt 回调（反向控制流；回调由 Daemon 注入）
 * 2. Gateway → Stream 只读订阅（不阻塞 writer；backpressure 契约已定）
 * 3. Gateway ↔ Transport 生命周期绑定（同 start/stop 周期）
 * 4. Gateway → Transport 连接视图派生（Map 跟随 onConnect/onDisconnect）
 */

import type { Connection, Transport } from '../../foundation/transport/index.js';
import type { StreamEvent, StreamReader } from '../../foundation/stream/index.js';
import type { ToolResult, ExecContext } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

/**
 * Gateway 构造输入。
 *
 * 契约：
 * - streamFactory：Daemon 传入工厂，Gateway 注入 onEvent 后构造 reader。
 * - transport：若传入，则**已经 listening**；Gateway 只绑回调，stop 时 close。
 *   未传入 = offline 模式，Gateway 不做任何网络操作。
 */
export interface GatewayInput {
  /** StreamReader 工厂；Gateway 注入 onEvent 回调后调用 start */
  streamFactory: (onEvent: (event: StreamEvent) => void) => StreamReader;
  /** 已处于 listening 状态的 Transport；undefined = offline */
  transport?: Transport;
  /** Daemon 注入的 interrupt 回调 */
  interrupt: (reason: 'user') => void;
  /** askUser 超时（Step 3 使用） */
  askUserTimeoutMs?: number;
  /** audit 写入器；Gateway 用于写 10 类结构化事件 */
  audit: AuditLog;
  /** 启动期 reader initialOffset 计算（assembly 闭包绑 fs+streamPath / chat-viewport spinner bug 同型 fix）/ undefined = 默认 tail mode */
  getInitialOffset?: () => number;
}

/**
 * Gateway interface — 外部客户端 ↔ 内部系统 的实时交互门面。
 *
 * 派生状态不持久化：connections、lastInterruptTs 重启后从事件流自然重建。
 */
export interface Gateway {
  /** Start：绑 transport 回调、构造并启动 StreamReader。重复调用 throw。offline 下 no-op。 */
  start(): Promise<void>;
  /** Stop：先停 reader，再 drop 连接，最后 close transport。idempotent。 */
  stop(): Promise<void>;
  /** 向客户端发送 question、阻塞等待用户回复；超时 / abort / 无 listener / broadcast 失败 → 返回 failureResult。 */
  askUser(question: string, ctx: ExecContext): Promise<ToolResult>;
  /** 返回当前连接快照（调用方不持有引用） */
  getActiveConnections(): readonly Connection[];
  /** online/offline 一次性定型 */
  isOnline(): boolean;
}

// ---------------------------------------------------------------------------
// Client → Gateway
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'interrupt'; reason: 'user' }
  | { type: 'ask_user_reply'; id: string; answer: string };

// ---------------------------------------------------------------------------
// Gateway → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'ask_user_pending'; id: string; question: string }
  | { type: 'ask_user_resolved'; id: string; by: string }
  | { type: 'ask_user_cancelled'; id: string; reason: 'timeout' | 'abort' }
  | { type: 'connection_dropped'; connectionId: string; reason: string };
