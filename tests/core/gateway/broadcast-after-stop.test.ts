import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGateway } from '../../../src/core/gateway/index.js';
import type { Gateway, GatewayInput } from '../../../src/core/gateway/index.js';
import type { Transport, Connection } from '../../../src/foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../../src/foundation/stream/index.js';

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

describe('Gateway broadcast guard (phase 793 / P0.21)', () => {
  let transport: ReturnType<typeof createStubTransport>;
  let streamStub: ReturnType<typeof createStubStreamReaderFactory>;
  let gateway: Gateway | null = null;

  beforeEach(() => {
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
      audit: mockAudit(),
    };
  }

  it('broadcast silent after transport.close (P0.21 fix)', async () => {
    gateway = createGateway(createOnlineInput());
    await gateway.start();

    // pre-stop: stream event triggers broadcast
    const ev: StreamEvent = { ts: 1, type: 'test', data: 'hello' };
    streamStub.fireEvent(ev);
    expect(transport.broadcast).toHaveBeenCalledTimes(1);

    const broadcastsBeforeStop = transport.broadcast.mock.calls.length;

    await gateway.stop();

    // post-stop: late stream event must NOT trigger broadcast
    streamStub.fireEvent({ ts: 2, type: 'test', data: 'late' });
    expect(transport.broadcast).toHaveBeenCalledTimes(broadcastsBeforeStop);
  });
});
