import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGateway } from '../../../src/core/gateway/index.js';
import type { Gateway, GatewayInput } from '../../../src/core/gateway/index.js';
import type { Transport, Connection } from '../../../src/foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../../src/foundation/stream/index.js';
import { GATEWAY_AUDIT_EVENTS } from '../../../src/core/gateway/audit-events.js';

function mockAudit() {
  return { write: vi.fn() };
}

function createStubTransport(): Transport & {
  _connect(conn: Connection): void;
  _disconnect(conn: Connection): void;
  _message(conn: Connection, data: string): void;
  fireTransportError(evt: import('../../../src/foundation/transport/index.js').TransportErrorEvent): void;
} {
  const connections = new Map<string, Connection>();
  const connectCbs: Array<(conn: Connection) => void> = [];
  const disconnectCbs: Array<(conn: Connection, reason?: Error) => void> = [];
  const messageCbs: Array<(conn: Connection, data: string) => void> = [];
  const transportErrorCbs: Array<(evt: import('../../../src/foundation/transport/index.js').TransportErrorEvent) => void> = [];

  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    broadcast: vi.fn().mockReturnValue({ failed: [] }),
    getConnections: () => Array.from(connections.values()),
    onConnect: (cb) => connectCbs.push(cb),
    onDisconnect: (cb) => disconnectCbs.push(cb),
    onMessage: (cb) => messageCbs.push(cb),
    onTransportError: (cb) => transportErrorCbs.push(cb),
    _connect: (conn) => {
      connections.set(conn.id, conn);
      for (const cb of connectCbs) {
        try { cb(conn); } catch (err) { /* Transport safeFire isolates */ }
      }
    },
    _disconnect: (conn) => {
      connections.delete(conn.id);
      for (const cb of disconnectCbs) {
        try { cb(conn); } catch (err) { /* Transport safeFire isolates */ }
      }
    },
    _message: (conn, data) => {
      for (const cb of messageCbs) {
        try {
          cb(conn, data);
        } catch (err) {
          transportErrorCbs.forEach((tcb) => tcb({
            kind: 'callback_error',
            callbackName: 'onMessage',
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        }
      }
    },
    fireTransportError: (evt) => {
      transportErrorCbs.forEach((tcb) => tcb(evt));
    },
  };
}

function createStubStreamReaderFactory(): {
  factory: (onEvent: (ev: StreamEvent) => void) => StreamReader;
  fireEvent: (ev: StreamEvent) => void;
  lastReader: StreamReader | null;
} {
  let onEventRef: ((ev: StreamEvent) => void) | null = null;
  const readers: StreamReader[] = [];

  const factory = (cb: (ev: StreamEvent) => void): StreamReader => {
    onEventRef = cb;
    const reader: StreamReader = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
    };
    readers.push(reader);
    return reader;
  };

  return {
    factory,
    fireEvent: (ev) => onEventRef?.(ev),
    get lastReader() {
      return readers[readers.length - 1] ?? null;
    },
  };
}

describe('transport nullness single source-of-truth (phase 877 / r113 E fork)', () => {
  let audit: ReturnType<typeof mockAudit>;
  let transport: ReturnType<typeof createStubTransport>;
  let streamStub: ReturnType<typeof createStubStreamReaderFactory>;
  let gateway: Gateway | null = null;

  beforeEach(() => {
    audit = mockAudit();
    transport = createStubTransport();
    streamStub = createStubStreamReaderFactory();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (gateway) {
      await gateway.stop();
      gateway = null;
    }
  });

  function createOnlineInput(): GatewayInput {
    return {
      streamFactory: streamStub.factory,
      transport,
      interrupt: vi.fn(),
      audit,
    };
  }

  describe('offline mode (transport=undefined)', () => {
    it('broadcast no-op + isOnline()=false', async () => {
      gateway = createGateway({
        streamFactory: streamStub.factory,
        transport: undefined,
        interrupt: vi.fn(),
        audit,
      } as GatewayInput);
      await gateway.start();
      expect(gateway.isOnline()).toBe(false);
      await gateway.stop();
      // offline mode: start/stop 均为 no-op，audit 0 写入（STOP_NOOP 仅在 stop 先于 start 时触发）
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('online mode: stop sequence broadcast', () => {
    it('dropConnection during stop broadcasts connection_dropped (started committed at end, phase 971)', async () => {
      gateway = createGateway(createOnlineInput());
      await gateway.start();
      const conn: Connection = { id: 'c1', remoteAddr: '127.0.0.1' };
      transport._connect(conn);
      expect(transport.getConnections().length).toBe(1);

      // phase 956 legacy: clear pre-stop broadcasts then verify broadcast during stop
      transport.broadcast.mockClear();
      await gateway.stop();

      // phase 971: stop 期间 started 保持 true，dropConnection 会触发 transport.broadcast
      expect(transport.broadcast).toHaveBeenCalledTimes(1);
      expect(JSON.parse(transport.broadcast.mock.calls[0][0] as string)).toEqual(
        expect.objectContaining({ type: 'connection_dropped', connectionId: 'c1', reason: 'gateway stopping' }),
      );
      expect(transport.close).toHaveBeenCalledOnce();

      // audit CONNECTION_DROPPED 仍 emit per drop（observability 完整）
      const droppedEvents = audit.write.mock.calls.filter(([type]) => type === GATEWAY_AUDIT_EVENTS.CONNECTION_DROPPED);
      expect(droppedEvents.length).toBe(1);
    });
  });

  describe('online mode: transport.close throw', () => {
    it('close error is aggregated and second stop is STOP_NOOP', async () => {
      const closeError = new Error('mock close failure');
      transport.close.mockRejectedValueOnce(closeError);
      gateway = createGateway(createOnlineInput());
      await gateway.start();

      // phase 971: close error is aggregated into AggregateError instead of re-thrown raw
      const err = await gateway.stop().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toBe('Gateway stop completed with errors');
      expect((err as AggregateError).errors[0]).toBe(closeError);

      // After a failed stop the gateway remains started; a second stop can recover.
      await gateway.stop();
      expect(audit.write).toHaveBeenCalledWith(GATEWAY_AUDIT_EVENTS.STOP_NOOP);
    });
  });

  describe('online mode: stop() idempotent', () => {
    it('second stop is STOP_NOOP + transport.close not called twice', async () => {
      gateway = createGateway(createOnlineInput());
      await gateway.start();
      await gateway.stop();
      expect(transport.close).toHaveBeenCalledOnce();

      await gateway.stop();
      expect(transport.close).toHaveBeenCalledOnce();

      const stopNoopCalls = audit.write.mock.calls.filter(([type]) => type === GATEWAY_AUDIT_EVENTS.STOP_NOOP);
      expect(stopNoopCalls.length).toBe(1);
    });
  });

  describe('inverse oracle (defense against single source regression)', () => {
    it('post-stop late stream event must not trigger broadcast (covered by broadcast-after-stop)', async () => {
      gateway = createGateway(createOnlineInput());
      await gateway.start();
      const ev: StreamEvent = { ts: 1, type: 'test', data: 'hello' };
      streamStub.fireEvent(ev);
      const broadcastsBeforeStop = transport.broadcast.mock.calls.length;
      await gateway.stop();
      streamStub.fireEvent({ ts: 2, type: 'test', data: 'late' });
      expect(transport.broadcast.mock.calls.length).toBe(broadcastsBeforeStop);
    });
  });
});
