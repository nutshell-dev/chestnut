import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createGateway, createAskUserTool } from '../../src/core/gateway/index.js';
import type { Gateway, GatewayInput } from '../../src/core/gateway/index.js';
import type { Transport, Connection } from '../../src/foundation/transport/index.js';
import type { StreamReader, StreamEvent } from '../../src/foundation/stream/index.js';
import type { ExecContext } from '../../src/foundation/tools/index.js';

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
  const transportErrorCbs: Array<(evt: import('../../src/foundation/transport/index.js').TransportErrorEvent) => void> = [];

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
        try { cb(conn); }
        catch (err) {
          transportErrorCbs.forEach((tcb) => tcb({
            kind: 'callback_error',
            callbackName: 'onConnect',
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        }
      }
    },
    _disconnect: (conn) => {
      connections.delete(conn.id);
      for (const cb of disconnectCbs) {
        try { cb(conn); }
        catch (err) {
          transportErrorCbs.forEach((tcb) => tcb({
            kind: 'callback_error',
            callbackName: 'onDisconnect',
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        }
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

function mockCtx(signal?: AbortSignal): ExecContext {
  return {
    signal,
  } as unknown as ExecContext;
}

function getBroadcastPayloads(transport: ReturnType<typeof createStubTransport>): unknown[] {
  return transport.broadcast.mock.calls.map((c) => JSON.parse(c[0] as string));
}

function extractAskId(transport: ReturnType<typeof createStubTransport>): string {
  const payloads = getBroadcastPayloads(transport);
  const pendingPayload = payloads.find((p: { type: string }) => p.type === 'ask_user_pending') as
    | { type: 'ask_user_pending'; id: string }
    | undefined;
  if (!pendingPayload) throw new Error('No ask_user_pending broadcast found');
  return pendingPayload.id;
}

describe('Gateway askUser', () => {
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

  function createInput(overrides?: Partial<GatewayInput>): GatewayInput {
    return {
      streamFactory: streamStub.factory,
      transport,
      interrupt: vi.fn(),
      askUserTimeoutMs: 50,
      audit: mockAudit(),
      ...overrides,
    };
  }

  it('first-wins resolve', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const conn: Connection = { id: 'c1', connectedAt: Date.now() };
    transport._connect(conn);

    const promise = gateway.askUser('hello?', mockCtx());

    // pending broadcast
    await vi.advanceTimersByTimeAsync(0);
    const payloads = getBroadcastPayloads(transport);
    const pendingPayload = payloads.find((p: { type: string }) => p.type === 'ask_user_pending') as
      | { type: 'ask_user_pending'; id: string; question: string }
      | undefined;
    expect(pendingPayload).toBeDefined();
    const askId = pendingPayload!.id;

    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'yes' }));

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.content).toBe('yes');

    const allPayloads = getBroadcastPayloads(transport);
    const resolvedPayload = allPayloads.find((p: { type: string }) => p.type === 'ask_user_resolved') as
      | { type: 'ask_user_resolved'; id: string; by: string }
      | undefined;
    expect(resolvedPayload).toBeDefined();
    expect(resolvedPayload!.by).toBe('c1');
  });

  it('duplicate reply is dropped, connection not dropped', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const conn: Connection = { id: 'c1', connectedAt: Date.now() };
    transport._connect(conn);

    const promise = gateway.askUser('hello?', mockCtx());
    const askId = extractAskId(transport);
    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'yes' }));
    await promise;

    // second reply with same id
    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'no' }));

    expect(gateway.getActiveConnections().some((c) => c.id === 'c1')).toBe(true);
    const droppedCalls = getBroadcastPayloads(transport).filter(
      (p: { type: string }) => p.type === 'connection_dropped',
    );
    expect(droppedCalls).toHaveLength(0);
  });

  it('timeout returns failure and broadcasts cancelled', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const promise = gateway.askUser('hello?', mockCtx());

    vi.advanceTimersByTime(60);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.content).toContain('超时');

    const cancelledPayload = getBroadcastPayloads(transport).find(
      (p: { type: string }) => p.type === 'ask_user_cancelled',
    );
    expect(cancelledPayload).toBeDefined();
    expect((cancelledPayload as { reason: string }).reason).toBe('timeout');
  });

  it('abort mid-flight returns failure and broadcasts cancelled', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const controller = new AbortController();
    const promise = gateway.askUser('hello?', mockCtx(controller.signal));

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.content).toContain('中断');

    const cancelledPayload = getBroadcastPayloads(transport).find(
      (p: { type: string }) => p.type === 'ask_user_cancelled',
    );
    expect(cancelledPayload).toBeDefined();
    expect((cancelledPayload as { reason: string }).reason).toBe('abort');
  });

  it('pre-aborted returns failure immediately without broadcast', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const controller = new AbortController();
    controller.abort();

    const result = await gateway.askUser('hello?', mockCtx(controller.signal));

    expect(result.success).toBe(false);
    expect(result.content).toContain('中断');

    const pendingPayloads = getBroadcastPayloads(transport).filter(
      (p: { type: string }) => p.type === 'ask_user_pending' || p.type === 'ask_user_cancelled',
    );
    expect(pendingPayloads).toHaveLength(0);
  });

  it('offline returns failure immediately', async () => {
    gateway = createGateway(createInput({ transport: undefined }));
    await gateway.start();

    const result = await gateway.askUser('hello?', mockCtx());

    expect(result.success).toBe(false);
    expect(result.content).toContain('未启用实时交互');
  });

  it('stop() cancels pending askUser with abort reason', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const promise = gateway.askUser('hello?', mockCtx());

    await gateway.stop();
    gateway = null; // prevent afterEach double stop

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.content).toContain('中断');

    const cancelledPayload = getBroadcastPayloads(transport).find(
      (p: { type: string }) => p.type === 'ask_user_cancelled',
    );
    expect(cancelledPayload).toBeDefined();
    expect((cancelledPayload as { reason: string }).reason).toBe('abort');
  });

  it('resource cleanup: timeout then reply does not leak or throw', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const conn: Connection = { id: 'c1', connectedAt: Date.now() };
    transport._connect(conn);

    const promise = gateway.askUser('hello?', mockCtx());

    vi.advanceTimersByTime(60);
    await promise;

    const broadcastCountBefore = getBroadcastPayloads(transport).length;

    // reply after timeout should be silently ignored
    const askId = extractAskId(transport);
    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'late' }));

    const broadcastCountAfter = getBroadcastPayloads(transport).length;
    expect(broadcastCountAfter).toBe(broadcastCountBefore);
  });

  it('first-wins across multiple clients: c1 wins, c2 reply is dropped', async () => {
    gateway = createGateway(createInput());
    await gateway.start();

    const c1: Connection = { id: 'c1', connectedAt: Date.now() };
    const c2: Connection = { id: 'c2', connectedAt: Date.now() };
    transport._connect(c1);
    transport._connect(c2);

    const promise = gateway.askUser('hello?', mockCtx());
    const askId = extractAskId(transport);

    transport._message(c1, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'A1' }));
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.content).toBe('A1');

    // c2 reply on same id must be dropped
    transport._message(c2, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'A2' }));
    expect(gateway.getActiveConnections().some((c) => c.id === 'c2')).toBe(true);

    const resolvedPayloads = getBroadcastPayloads(transport).filter(
      (p: { type: string }) => p.type === 'ask_user_resolved',
    );
    expect(resolvedPayloads).toHaveLength(1);
    expect((resolvedPayloads[0] as { by: string }).by).toBe('c1');
  });

  it('askUser: writes GATEWAY_ASK_USER_PENDING', async () => {
    const audit = mockAudit();
    gateway = createGateway(createInput({ audit }));
    await gateway.start();
    const conn: Connection = { id: 'c1', connectedAt: Date.now() };
    transport._connect(conn);

    const promise = gateway.askUser('What?', mockCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(audit.write).toHaveBeenCalledWith(
      'gateway_ask_user_pending',
      expect.stringContaining('id=ask_'),
    );
    // cleanup
    const askId = extractAskId(transport);
    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'x' }));
    await promise;
  });

  it('timeout: writes GATEWAY_ASK_USER_CANCELLED with reason=timeout', async () => {
    const audit = mockAudit();
    gateway = createGateway(createInput({ audit, askUserTimeoutMs: 1 }));
    await gateway.start();

    const result = await gateway.askUser('Q?', mockCtx());
    expect(result.success).toBe(false);

    expect(audit.write).toHaveBeenCalledWith(
      'gateway_ask_user_cancelled', expect.stringContaining('id='), 'reason=timeout',
    );
  });

  it('resolve: writes GATEWAY_ASK_USER_RESOLVED', async () => {
    const audit = mockAudit();
    gateway = createGateway(createInput({ audit }));
    await gateway.start();
    const conn: Connection = { id: 'c1', connectedAt: Date.now() };
    transport._connect(conn);

    const promise = gateway.askUser('Q?', mockCtx());
    const askId = extractAskId(transport);
    transport._message(conn, JSON.stringify({ type: 'ask_user_reply', id: askId, answer: 'ok' }));
    await promise;
    expect(audit.write).toHaveBeenCalledWith(
      'gateway_ask_user_resolved', expect.stringContaining('id='), expect.stringContaining('by='),
    );
  });

});

describe('createAskUserTool', () => {
  // forwarding test: tool body 仅调 gateway.askUser(question, ctx) / failure path 由 Gateway.askUser unit tests 覆盖
  it('calls gateway.askUser with question and ctx', async () => {
    const mockGateway = {
      askUser: vi.fn().mockResolvedValue({ success: true, content: 'ok' }),
    };
    const tool = createAskUserTool(mockGateway as unknown as Gateway);

    const ctx = { signal: undefined } as unknown as ExecContext;
    const result = await tool.execute({ question: 'test?' }, ctx);

    expect(mockGateway.askUser).toHaveBeenCalledWith('test?', ctx);
    expect(result.success).toBe(true);
  });

  it('has name ask_user and required question schema', () => {
    const mockGateway = { askUser: vi.fn() };
    const tool = createAskUserTool(mockGateway as unknown as Gateway);

    expect(tool.name).toBe('ask_user');
    expect(tool.schema.properties).toHaveProperty('question');
    expect((tool.schema as { required?: string[] }).required).toContain('question');
  });
});
