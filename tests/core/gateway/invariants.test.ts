/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - gateway-askuser-stopped.test.ts
 *  - gateway-broadcast-no-listener.test.ts
 *  - broadcast-after-stop.test.ts
 *  - gateway-stop-broadcast-cascade.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGateway } from '../../../src/core/gateway/index.js';
import type { Gateway, GatewayInput } from '../../../src/core/gateway/index.js';
import type { Transport, Connection } from '../../../src/foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../../src/foundation/stream/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { GATEWAY_AUDIT_EVENTS } from '../../../src/core/gateway/audit-events.js';

describe('gateway-askuser-stopped', () => {
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

  describe('Gateway askUser stopped (phase 994 E.1)', () => {
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

    function createInput(): GatewayInput {
      return {
        streamFactory: streamStub.factory,
        transport,
        interrupt: vi.fn(),
        askUserTimeoutMs: 50,
        audit: mockAudit(),
      };
    }

    it('askUser when not started returns failureResult instead of throwing', async () => {
      gateway = createGateway(createInput());
      // Do NOT start gateway

      const result = await gateway.askUser('hello?', makeExecContext({ signal: undefined }));

      expect(result.success).toBe(false);
      expect(result.content).toMatch(/not started/i);
    });
  });
});

describe('gateway-broadcast-no-listener', () => {
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
});

describe('broadcast-after-stop', () => {
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
});

describe('gateway-stop-broadcast-cascade', () => {
  function mockAudit() {
    const events: [string, ...string[]][] = [];
    return {
      write: vi.fn((...args: [string, ...string[]]) => events.push(args)),
      events,
    };
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

  describe('phase 956: stop broadcast cascade prevention (started guard)', () => {
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

    it('stop loop 期间 dropConnection 会 broadcast connection_dropped (started committed at end)', async () => {
      gateway = createGateway(createOnlineInput());
      await gateway.start();

      // 模拟 3 个连接
      const conn1: Connection = { id: 'c1', remoteAddr: '127.0.0.1' };
      const conn2: Connection = { id: 'c2', remoteAddr: '127.0.0.2' };
      const conn3: Connection = { id: 'c3', remoteAddr: '127.0.0.3' };
      transport._connect(conn1);
      transport._connect(conn2);
      transport._connect(conn3);
      expect(transport.getConnections().length).toBe(3);

      // 清空 pre-stop broadcast calls
      transport.broadcast.mockClear();

      await gateway.stop();

      // phase 971: stop 期间 started 保持 true 直到最后，每个 dropConnection 都会触发 transport.broadcast
      expect(transport.broadcast).toHaveBeenCalledTimes(3);
      const droppedPayloads = transport.broadcast.mock.calls.map((c) => JSON.parse(c[0] as string));
      expect(droppedPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'connection_dropped', connectionId: 'c1', reason: 'gateway stopping' }),
          expect.objectContaining({ type: 'connection_dropped', connectionId: 'c2', reason: 'gateway stopping' }),
          expect.objectContaining({ type: 'connection_dropped', connectionId: 'c3', reason: 'gateway stopping' }),
        ]),
      );

      // audit CONNECTION_DROPPED 仍 emit per drop（observability 完整）
      const droppedEvents = audit.events.filter((e) => e[0] === GATEWAY_AUDIT_EVENTS.CONNECTION_DROPPED);
      expect(droppedEvents.length).toBe(3);
      expect(droppedEvents.map((e) => e[1])).toEqual(
        expect.arrayContaining([
          expect.stringContaining('connId=c1'),
          expect.stringContaining('connId=c2'),
          expect.stringContaining('connId=c3'),
        ])
      );

      // STOPPED 仍 emit
      const stoppedEvents = audit.events.filter((e) => e[0] === GATEWAY_AUDIT_EVENTS.STOPPED);
      expect(stoppedEvents.length).toBe(1);
    });
  });
});
