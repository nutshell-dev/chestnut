/**
 * Gateway (L5): 外部客户端 ↔ 内部系统 的实时交互门面。
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
import type { Connection, Transport } from '../../foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../foundation/stream/index.js';
import type { ToolResult, ExecContext } from '../../foundation/tools/index.js';
import { GATEWAY_AUDIT_EVENTS } from './audit-events.js';
import {
  GATEWAY_INTERRUPT_DEBOUNCE_MS,
  GATEWAY_ASK_USER_TIMEOUT_MS,
} from './constants.js';

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
  const { streamFactory, interrupt, askUserTimeoutMs, audit } = input;
  const isOnlineMode = input.transport !== undefined;
  let transport: Transport | null = input.transport ?? null;   // phase 932: type union narrow 至 2 token 单 absent (phase 877 sister-open-extension)
  const timeoutMs = askUserTimeoutMs ?? GATEWAY_ASK_USER_TIMEOUT_MS;

  const connections = new Map<string, Connection>();
  const pending = new Map<string, AskUserEntry>();
  let streamReader: StreamReader | null = null;
  let lastInterruptTs = 0;
  let debouncedAuditedInWindow = false;
  let started = false;
  let askCounter = 0;
  let unsubListeners: Array<() => void> = [];

  const broadcast = (msg: ServerMessage): void => {
    // phase 956 (audit-2026-05-15 new.P2.5): stop 期间 (started=false at line 216) skip broadcast 防 O(n²) transport writes + cascade depth N
    if (!started) return;
    // phase 877 (audit-2026-05-15 new.P1.3): transport nullness 单 source-of-truth
    // stop 期间 dropConnection 在 transport.close 前 broadcast connection_dropped 仍 emit
    // transport.close 完成后 transport=null → 后续 late callback 静默
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
    if (!entry) {
      // race-loss: ask_user_reply 或并发 cancel 已 win / silent return 漂移、emit 区分 (phase 1011 D.1)
      audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_RACE_LOSS, `id=${id}`, `reason=${reason}`, 'lost_to=other_branch');
      return;
    }
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
          // sampling：window 内仅首次 audit / 防 client spam flood audit log
          if (!debouncedAuditedInWindow) {
            audit.write(GATEWAY_AUDIT_EVENTS.INTERRUPT_DEBOUNCED, `connId=${conn.id}`);
            debouncedAuditedInWindow = true;
          }
          return;
        }
        lastInterruptTs = now;
        debouncedAuditedInWindow = false;
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
        dropConnection(conn.id, `unknown message type: ${String((msg as { type?: unknown }).type)}`);
        return;
    }
  };

  return {
    async start() {
      if (started) throw new Error('Gateway already started');
      started = true;
      if (!isOnlineMode) return;

      const t = transport!;
      // G1: cleanup stale listeners + F2: clear stale connections before registering
      connections.clear();
      unsubListeners.forEach((u) => u());
      unsubListeners = [];
      try {
        unsubListeners.push(
          t.onConnect((c) => {
            connections.set(c.id, c);
            audit.write(GATEWAY_AUDIT_EVENTS.CONNECTION_ACCEPTED, `connId=${c.id}`);
          }),
          t.onDisconnect((c, reason) => {
            connections.delete(c.id);
            audit.write(GATEWAY_AUDIT_EVENTS.CONNECTION_DISCONNECTED, `connId=${c.id}`, `reason=${String(reason)}`);
          }),
          t.onMessage((c, data) => {
            handleClientMessage(c, data);
            // 抛错由 Transport safeFire 捕获 → fireTransportError({ kind: 'callback_error', callbackName: 'onMessage', error })
            // → Gateway 的 onTransportError 处理器接收（见下方）
          }),
          t.onTransportError((evt) => {
            const baseFields = [`kind=${evt.kind}`];
            switch (evt.kind) {
              case 'callback_error':
                baseFields.push(`error=${String(evt.error)}`, `callbackName=${evt.callbackName}`);
                if (evt.connectionId) baseFields.push(`connId=${evt.connectionId}`);
                break;
              case 'server_error':
                baseFields.push(`error=${String(evt.error)}`);
                break;
              case 'write_failed':
                baseFields.push(`connId=${evt.connectionId}`, `error=${String(evt.error)}`, `bytes=${evt.bytes}`);
                break;
              case 'backpressure_pending':
                baseFields.push(`connId=${evt.connectionId}`, `bufferedBytes=${evt.bufferedBytes}`);
                break;
              case 'drain_completed':
                baseFields.push(`connId=${evt.connectionId}`);
                break;
              case 'partial_message_lost':
                baseFields.push(`connId=${evt.connectionId}`, `bufferedBytes=${evt.bufferedBytes}`, `bufferPreview=${evt.bufferPreview}`);
                break;
              case 'send_error':
                baseFields.push(`connId=${evt.connectionId}`, `error=${String(evt.error)}`);
                break;
            }
            audit.write(GATEWAY_AUDIT_EVENTS.TRANSPORT_ERROR, ...baseFields);
          }),
        );

        streamReader = streamFactory((ev: StreamEvent) => {
          broadcast({ type: 'stream', event: ev });
        });
        const initialOffset = input.getInitialOffset?.();
        if (initialOffset !== undefined) streamReader.start(initialOffset);
        else streamReader.start();
      } catch (err) {
        unsubListeners.forEach((u) => u());
        unsubListeners = [];
        started = false;
        streamReader = null;
        audit.write(GATEWAY_AUDIT_EVENTS.STARTUP_FAILED, `error=${String(err)}`);
        throw err;
      }
      audit.write(GATEWAY_AUDIT_EVENTS.STARTED, `isOnline=${isOnlineMode}`);
    },

    async stop() {
      if (!started) {
        audit.write(GATEWAY_AUDIT_EVENTS.STOP_NOOP);
        return;
      }
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

      // 4. 关闭 transport (phase 877: null-out 先 + close 后、close throw 时 transport 已 null → broadcast 静默)
      const t = transport!;
      transport = null;
      await t.close();
      audit.write(GATEWAY_AUDIT_EVENTS.STOPPED);
    },

    async askUser(question: string, ctx: ExecContext): Promise<ToolResult> {
      if (!started) {
        return failureResult('Gateway not started');
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
        }

        // phase 1102 gw-2: pending.set BEFORE addEventListener to prevent abort/cancel race
        // If abort fires between addEventListener and pending.set, cancel() finds null → timer leaks.
        pending.set(id, { id, resolve, timer, abortListener, signal: ctx.signal ?? null });

        if (ctx.signal && abortListener) {
          ctx.signal.addEventListener('abort', abortListener, { once: true });
          // G4 robust：addEventListener 后立即 check / spec 不 retroactively fire
          if (ctx.signal.aborted) {
            ctx.signal.removeEventListener('abort', abortListener);
            clearTimeout(timer);
            pending.delete(id);
            resolve(failureResult('ask_user 被中断取消'));
            return;
          }
        }

        audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_PENDING, `id=${id}`);
        try {
          broadcast({ type: 'ask_user_pending', id, question });
        } catch (err) {
          cleanup(id);
          audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_BROADCAST_FAILED, `id=${id}`, `error=${String(err)}`);
          resolve(failureResult(`ask_user broadcast 失败：${String(err)}`));
          return;
        }
        // 0-listener short-circuit: broadcast 后无连接 → 立即 fail-loud
        if (connections.size === 0) {
          cleanup(id);
          audit.write(GATEWAY_AUDIT_EVENTS.ASK_USER_NO_LISTENER, `id=${id}`);
          resolve(failureResult('ask_user 无活动连接'));
          return;
        }
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
