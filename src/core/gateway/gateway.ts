/**
 * Gateway (L5): 外部客户端 ↔ 内部系统 的实时交互门面。
 *
 * 不可消除耦合（显式）：
 * 1. Gateway → Daemon interrupt 回调（反向控制流；回调由 Daemon 注入）
 * 2. Gateway → Stream 只读订阅（不阻塞 writer；backpressure 契约已定）
 * 3. Gateway ↔ Transport 生命周期绑定（同 start/stop 周期）
 * 4. Gateway → Transport 连接视图派生（Map 跟随 onConnect/onDisconnect）
 *
 * 派生状态不持久化：connections、lastInterruptTs 重启后从事件流自然重建。
 */

import type {
  Gateway,
  GatewayInput,
  ClientMessage,
  ServerMessage,
} from './types.js';
import type { Connection, Transport } from '../../foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../foundation/stream/index.js';
import { GATEWAY_AUDIT_EVENTS } from './audit-events.js';
import { GATEWAY_INTERRUPT_DEBOUNCE_MS } from './constants.js';

export function createGateway(input: GatewayInput): Gateway {
  const { streamFactory, interrupt, audit } = input;
  const isOnlineMode = input.transport !== undefined;
  let transport: Transport | null = input.transport ?? null;   // phase 932: type union narrow 至 2 token 单 absent (phase 877 sister-open-extension)

  const connections = new Map<string, Connection>();
  let streamReader: StreamReader | null = null;
  let lastInterruptTs = 0;
  let debouncedAuditedInWindow = false;
  let started = false;
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

  const handleClientMessage = (conn: Connection, data: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      dropConnection(conn.id, 'malformed JSON');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      dropConnection(
        conn.id,
        `invalid message: expected object, got ${parsed === null ? 'null' : typeof parsed}`,
      );
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
      default:
        dropConnection(conn.id, `unknown message type: ${String((msg as { type?: unknown }).type)}`);
        return;
    }
  };

  return {
    async start() {
      if (started) throw new Error('Gateway already started');
      started = true;
      if (!isOnlineMode) {
        audit.write(GATEWAY_AUDIT_EVENTS.STARTED, 'isOnline=false');
        return;
      }

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
              case 'buffer_overflow':
                // phase 364 D1: 之前漏分支 — write buffer 满、connection 即将丢消息
                baseFields.push(`connId=${evt.connectionId}`, `bufferedBytes=${evt.bufferedBytes}`);
                break;
              default: {
                // phase 364 D1 (review-2026-06-13): exhaustive 守 TransportErrorEvent variant
                const _exhaustive: never = evt;
                throw new Error(`gateway onTransportError: unhandled variant: ${JSON.stringify(_exhaustive)}`);
              }
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
      if (!isOnlineMode) {
        started = false;
        audit.write(GATEWAY_AUDIT_EVENTS.STOPPED);
        return;
      }

      const errors: Error[] = [];

      // 1. Stop reader to prevent further stream events during shutdown
      if (streamReader) {
        const sr = streamReader;
        try {
          await sr.stop();
        } catch (err) { // silent: best-effort stop cleanup, collected into errors array
          errors.push(err as Error);
        }
        streamReader = null;
      }

      // 2. Drop all connections
      for (const id of [...connections.keys()]) {
        try {
          dropConnection(id, 'gateway stopping');
        } catch (err) { // silent: best-effort stop cleanup, collected into errors array
          errors.push(err as Error);
        }
      }

      // 3. Close transport
      if (transport) {
        const t = transport;
        try {
          await t.close();
        } catch (err) { // silent: best-effort stop cleanup, collected into errors array
          errors.push(err as Error);
        }
        transport = null;
      }

      // COMMIT: only now mark stopped
      started = false;
      if (errors.length > 0) {
        audit.write(GATEWAY_AUDIT_EVENTS.STOPPED_WITH_ERRORS, `count=${errors.length}`);
        throw new AggregateError(errors, 'Gateway stop completed with errors');
      }
      audit.write(GATEWAY_AUDIT_EVENTS.STOPPED);
    },
  };
}
