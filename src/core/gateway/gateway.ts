/**
 * Gateway (L3): 外部客户端 ↔ 内部系统 的实时交互门面。
 *
 * 不可消除耦合（显式）：
 * 1. Gateway → Daemon interrupt 回调（反向控制流；回调由 Daemon 注入）
 * 2. Gateway → Stream 只读订阅（不阻塞 writer；backpressure 契约已定）
 * 3. Gateway ↔ Transport 生命周期绑定（同 start/stop 周期）
 * 4. Gateway → Transport 连接视图派生（Map 跟随 onConnect/onDisconnect）
 *
 * 派生状态不持久化：connections、lastInterruptTs、pending 重启后从事件流自然重建。
 */

import type {
  Gateway,
  GatewayInput,
  ClientMessage,
  ServerMessage,
} from './types.js';
import type { Connection } from '../../foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../foundation/stream/index.js';
import type { ToolResult, ExecContext } from '../tools/index.js';
import type { AuditWriter } from '../../foundation/audit/index.js';
import { GATEWAY_AUDIT_EVENTS } from './audit-events.js';
import {
  GATEWAY_INTERRUPT_DEBOUNCE_MS,
  GATEWAY_ASK_USER_TIMEOUT_MS,
} from '../../constants.js';

interface AskUserEntry {
  id: string;
  resolve: (r: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener: (() => void) | null;
  signal: AbortSignal | null;
}

function successResult(content: string): ToolResult {
  return { success: true, content };
}

function failureResult(content: string): ToolResult {
  return { success: false, content };
}

export function createGateway(input: GatewayInput): Gateway {
  const { streamFactory, transport, interrupt, askUserTimeoutMs, audit } = input;
  const isOnlineMode = transport !== undefined;
  const timeoutMs = askUserTimeoutMs ?? GATEWAY_ASK_USER_TIMEOUT_MS;

  const connections = new Map<string, Connection>();
  const pending = new Map<string, AskUserEntry>();
  let streamReader: StreamReader | null = null;
  let lastInterruptTs = 0;
  let started = false;
  let askCounter = 0;

  const broadcast = (msg: ServerMessage): void => {
    if (!transport) return;
    const { failed } = transport.broadcast(JSON.stringify(msg));
    for (const { connectionId } of failed) {
      dropConnection(connectionId, 'broadcast write failed');
    }
  };

  const dropConnection = (connId: string, reason: string): void => {
    if (!connections.has(connId)) return;
    connections.delete(connId);
    audit.write(GATEWAY_AUDIT_EVENTS.CONNECTION_DROPPED, `connId=${connId}`, `reason=${reason}`);
    broadcast({ type: 'connection_dropped', connectionId: connId, reason });
  };

  const cleanup = (id: string): void => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortListener);
    }
    pending.delete(id);
  };

  const cancel = (id: string, reason: 'timeout' | 'abort'): void => {
    const entry = pending.get(id);
    if (!entry) return; // 已被其他分支收口
    cleanup(id);
    const message =
      reason === 'timeout'
        ? `用户未回复（超时 ${timeoutMs}ms）`
        : 'ask_user 被中断取消';
    entry.resolve(failureResult(message));
    audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_CANCELLED, `id=${id}`, `reason=${reason}`);
    broadcast({ type: 'ask_user_cancelled', id, reason });
  };

  const handleClientMessage = (conn: Connection, data: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      dropConnection(conn.id, 'malformed JSON');
      return;
    }

    const msg = parsed as ClientMessage;
    switch (msg.type) {
      case 'interrupt': {
        const now = Date.now();
        if (now - lastInterruptTs < GATEWAY_INTERRUPT_DEBOUNCE_MS) {
          audit.write(GATEWAY_AUDIT_EVENTS.INTERRUPT_DEBOUNCED, `connId=${conn.id}`);
          return;
        }
        lastInterruptTs = now;
        interrupt('user');
        audit.write(GATEWAY_AUDIT_EVENTS.INTERRUPT_TRIGGERED, `connId=${conn.id}`);
        return;
      }
      case 'ask_user_reply': {
        const entry = pending.get(msg.id);
        if (!entry) {
          // 重复 / 过期 reply：drop 消息，不 drop 连接
          audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_REPLY_DROPPED, `id=${msg.id}`, `connId=${conn.id}`);
          return;
        }
        cleanup(msg.id);
        entry.resolve(successResult(msg.answer));
        audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_RESOLVED, `id=${msg.id}`, `by=${conn.id}`);
        broadcast({ type: 'ask_user_resolved', id: msg.id, by: conn.id });
        return;
      }
      default:
        dropConnection(conn.id, 'unknown message type');
        return;
    }
  };

  return {
    async start() {
      if (started) throw new Error('Gateway already started');
      started = true;
      if (!isOnlineMode) return;

      transport!.onConnect((c) => {
        connections.set(c.id, c);
      });
      transport!.onDisconnect((c, _reason) => {
        connections.delete(c.id);
        // _reason 留给 Gateway A.3 audit phase 使用
      });
      transport!.onMessage((c, data) => {
        handleClientMessage(c, data);
        // 抛错由 Transport safeFire 捕获 → fireTransportError({ kind: 'callback_error', callbackName: 'onMessage', error })
        // → Gateway 的 onTransportError 处理器接收（见下方）
      });
      transport!.onTransportError((evt) => {
        audit.write(
          GATEWAY_AUDIT_EVENTS.TRANSPORT_ERROR,
          `kind=${evt.kind}`,
          `error=${String(evt.error)}`,
          evt.kind === 'callback_error' ? `callbackName=${evt.callbackName}` : '',
        );
      });

      streamReader = streamFactory((ev: StreamEvent) => {
        broadcast({ type: 'stream', event: ev });
      });
      streamReader.start();
      audit.write(GATEWAY_AUDIT_EVENTS.STARTED, `isOnline=${isOnlineMode}`);
    },

    async stop() {
      if (!started) return;
      started = false;
      if (!isOnlineMode) return;

      // 1. 先取消所有 pending askUser，让等待者立刻 unblock
      for (const id of [...pending.keys()]) {
        cancel(id, 'abort');
      }

      // 2. 停 reader，避免 stop 过程中仍有事件尝试 broadcast
      if (streamReader) {
        const sr = streamReader;
        streamReader = null;
        await sr.stop();
      }

      // 3. 内部 drop 所有连接
      for (const id of [...connections.keys()]) {
        dropConnection(id, 'gateway stopping');
      }

      // 4. 关闭 transport
      await transport!.close();
      audit.write(GATEWAY_AUDIT_EVENTS.STOPPED);
    },

    async askUser(question: string, ctx: ExecContext): Promise<ToolResult> {
      if (!started) {
        throw new Error('Gateway not started');
      }
      if (!isOnlineMode) {
        return failureResult('未启用实时交互通道，跳过 ask_user');
      }
      if (ctx.signal?.aborted) {
        return failureResult('ask_user 被中断取消');
      }

      const id = `ask_${Date.now()}_${askCounter++}`;

      return new Promise<ToolResult>((resolve) => {
        const timer = setTimeout(() => {
          cancel(id, 'timeout');
        }, timeoutMs);

        let abortListener: (() => void) | null = null;
        if (ctx.signal) {
          abortListener = () => {
            cancel(id, 'abort');
          };
          ctx.signal.addEventListener('abort', abortListener, { once: true });
        }

        pending.set(id, { id, resolve, timer, abortListener, signal: ctx.signal ?? null });

        audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_PENDING, `id=${id}`);
        broadcast({ type: 'ask_user_pending', id, question });
      });
    },

    getActiveConnections() {
      return Array.from(connections.values());
    },

    isOnline() {
      return isOnlineMode && started;
    },
  };
}
