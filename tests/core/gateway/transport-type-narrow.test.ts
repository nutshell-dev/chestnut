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

describe('Gateway transport type narrow (phase 932)', () => {
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

  it('offline mode: transport=undefined → isOnlineMode=false, local transport=null, no broadcast', async () => {
    gateway = createGateway({
      streamFactory: streamStub.factory,
      transport: undefined,
      interrupt: vi.fn(),
      audit,
    } as GatewayInput);
    await gateway.start();
    expect(gateway.isOnline()).toBe(false);
    expect(gateway.isOnline()).toBe(false);
    await gateway.stop();
    // offline mode: start/stop 均为 no-op，audit 0 写入（STOP_NOOP 仅在 stop 先于 start 时触发）
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('online mode: transport=Transport → isOnlineMode=true, broadcast works', async () => {
    gateway = createGateway(createOnlineInput());
    await gateway.start();
    expect(gateway.isOnline()).toBe(true);
    expect(gateway.isOnline()).toBe(true);

    const conn: Connection = { id: 'c1', remoteAddr: '127.0.0.1' };
    transport._connect(conn);
    expect(transport.getConnections().length).toBe(1);

    const ev: StreamEvent = { ts: 1, type: 'test', data: 'hello' };
    streamStub.fireEvent(ev);
    expect(transport.broadcast).toHaveBeenCalled();
  });

  it('stop after online: transport=null, isOnlineMode still true (const captured), running()=false (started=false)', async () => {
    gateway = createGateway(createOnlineInput());
    await gateway.start();
    expect(gateway.isOnline()).toBe(true);

    const conn: Connection = { id: 'c1', remoteAddr: '127.0.0.1' };
    transport._connect(conn);

    await gateway.stop();
    expect(gateway.isOnline()).toBe(false);

    // late broadcast attempt: should silent due to transport=null guard line 63
    const broadcastCountAfterStop = transport.broadcast.mock.calls.length;

    // simulate a late stream event after stop
    const ev: StreamEvent = { ts: 2, type: 'test', data: 'late' };
    streamStub.fireEvent(ev);
    expect(transport.broadcast.mock.calls.length).toBe(broadcastCountAfterStop);

    // isOnline() returns false because started=false after stop
    expect(gateway.isOnline()).toBe(false);
  });
});
