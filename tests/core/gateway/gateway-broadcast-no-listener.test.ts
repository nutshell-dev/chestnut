import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGateway } from '../../../src/core/gateway/index.js';
import type { Gateway, GatewayInput } from '../../../src/core/gateway/index.js';
import type { Transport, Connection } from '../../../src/foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../../src/foundation/stream/index.js';
import { GATEWAY_AUDIT_EVENTS } from '../../../src/core/gateway/audit-events.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function mockAudit() {
  return { write: vi.fn() };
}

function createStubTransport(): Transport & {
  _connect(conn: Connection): void;
  _disconnect(conn: Connection): void;
  _message(conn: Connection, data: string): void;
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
  };
}

function createStubStreamReaderFactory(): {
  factory: (onEvent: (ev: StreamEvent) => void) => StreamReader;
  fireEvent: (ev: StreamEvent) => void;
} {
  let onEventRef: ((ev: StreamEvent) => void) | null = null;

  const factory = (cb: (ev: StreamEvent) => void): StreamReader => {
    onEventRef = cb;
    return {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
    };
  };

  return {
    factory,
    fireEvent: (ev) => onEventRef?.(ev),
  };
}

describe('Gateway askUser 0-listener short-circuit (phase 994 E.2)', () => {
  let transport: ReturnType<typeof createStubTransport>;
  let streamStub: ReturnType<typeof createStubStreamReaderFactory>;
  let audit: ReturnType<typeof mockAudit>;
  let gateway: Gateway | null = null;

  beforeEach(() => {
    transport = createStubTransport();
    streamStub = createStubStreamReaderFactory();
    audit = mockAudit();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (gateway) {
      await gateway.stop();
      gateway = null;
    }
  });

  function createInput(): GatewayInput {
    return {
      streamFactory: streamStub.factory,
      transport,
      interrupt: vi.fn(),
      askUserTimeoutMs: 50,
      audit,
    };
  }

  it('askUser when 0 connections short-circuits to failureResult', async () => {
    gateway = createGateway(createInput());
    await gateway.start();
    // No connections established

    const result = await gateway.askUser('hello?', makeExecContext({ signal: undefined }));

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/无活动连接/);
    expect(audit.write).toHaveBeenCalledWith(
      GATEWAY_AUDIT_EVENTS.ASK_USER_NO_LISTENER,
      expect.stringContaining('id='),
    );
  });
});
