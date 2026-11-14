/** Phase 2135 Step B：EventLoop turn-state 发布时序、terminal/finally 与故障隔离。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import type { EventLoopTurnStateSink } from '../../../src/core/event-loop/types.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import type { Runtime, RuntimeTurnCallbacks, TurnResult } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { StreamWriter } from '../../../src/foundation/stream/index.js';
import type { InboxHandle, InboxMessage } from '../../../src/foundation/messaging/index.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>(
    '../../../src/core/event-loop/constants.js',
  );
  return { ...actual, UNKNOWN_ERROR_RECOVERY_DELAY_MS: 0 };
});

type Terminal = 'end' | 'interrupted' | 'error';

function makeSink(): EventLoopTurnStateSink {
  return {
    turnStart: vi.fn(),
    turnEnd: vi.fn(),
    turnInterrupted: vi.fn(),
    turnError: vi.fn(),
    turnFinish: vi.fn(),
  };
}

function makeAudit(): AuditLog & { entries: Array<[string, ...(string | number)[]]> } {
  const entries: Array<[string, ...(string | number)[]]> = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

describe('EventLoop turn-state (phase 2135 Step B)', () => {
  let agentDir: string;
  let inboxPendingDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `event-loop-turn-state-${randomUUID()}`);
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    fs.mkdirSync(inboxPendingDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function makeRuntime(options: {
    terminal?: Terminal;
    reject?: boolean;
    order?: string[];
  } = {}) {
    const message = {
      id: 'message-1',
      type: 'user_chat',
      from: 'test',
      to: '',
      content: 'hi',
      priority: 'normal',
      timestamp: new Date(0).toISOString(),
    } as InboxMessage;
    const entry = { message, handle: 'handle-1' as InboxHandle };
    let prepareCalls = 0;
    const processTurn = vi.fn(async (
      _messages: Message[],
      _systemPrompt: string,
      _tools: unknown[],
      callbacks?: RuntimeTurnCallbacks,
    ): Promise<TurnResult> => {
      options.order?.push('processTurn');
      if (options.reject) throw new Error('processTurn rejected');
      if (options.terminal === 'end') callbacks?.onTurnEnd?.();
      if (options.terminal === 'interrupted') callbacks?.onTurnInterrupted?.('user_interrupt');
      if (options.terminal === 'error') callbacks?.onTurnError?.('turn failed');
      if (options.terminal === 'interrupted') return { status: 'interrupted', cause: 'user_interrupt' };
      if (options.terminal === 'error') return { status: 'failed', error: new Error('turn failed') };
      return { status: 'success' };
    });
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      prepareInbox: vi.fn().mockImplementation(async () => ({ entries: prepareCalls++ === 0 ? [entry] : [] })),
      formatPreparedInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [message],
        selected: [entry],
        deferred: [],
        oversizedAlone: false,
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation(async (messages: Message[]) => messages),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn(),
      getLLMFailureDisposition: vi.fn().mockReturnValue('unknown'),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [message], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
      getCurrentTraceId: vi.fn().mockReturnValue(undefined),
    } as unknown as Runtime;
    return { runtime, processTurn, ackHandles, nackHandles };
  }

  function makeLoop(options: {
    runtime: Runtime;
    turnState: EventLoopTurnStateSink;
    audit?: AuditLog;
    streamWriter?: StreamWriter;
  }): EventLoop {
    return new EventLoop({
      runtime: options.runtime,
      fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
      agentDir,
      clawId: 'motion',
      audit: options.audit ?? makeAudit(),
      inbox: { clawRoot: agentDir, fallbackTimeoutMs: 1 },
      turnState: options.turnState,
      streamWriter: options.streamWriter,
    });
  }

  it.each([
    ['end', 'turnEnd', 'turn_end'],
    ['interrupted', 'turnInterrupted', 'turn_interrupted'],
    ['error', 'turnError', 'turn_error'],
  ] as const)('terminal=%s 先发布对应终态，processTurn finally 再幂等 finish', async (terminal, method, streamType) => {
    const order: string[] = [];
    const turnState = makeSink();
    const originalStart = turnState.turnStart;
    turnState.turnStart = vi.fn(() => { order.push('turnStart'); originalStart(); });
    turnState[method] = vi.fn(() => { order.push(method); });
    turnState.turnFinish = vi.fn(() => { order.push('turnFinish'); });
    const streamWriter = {
      write: (event: { type: string }) => { order.push(`stream:${event.type}`); },
    } as unknown as StreamWriter;
    const { runtime } = makeRuntime({ terminal, order });
    await makeLoop({ runtime, turnState, streamWriter }).run();

    expect(order).toEqual([
      'stream:turn_start',
      'turnStart',
      'processTurn',
      `stream:${streamType}`,
      method,
      'turnFinish',
    ]);
    expect(turnState.turnStart).toHaveBeenCalledTimes(1);
    expect(turnState[method]).toHaveBeenCalledTimes(1);
    expect(turnState.turnFinish).toHaveBeenCalledTimes(1);
  });

  it('processTurn reject 时 finally 仍收束 idle', async () => {
    const turnState = makeSink();
    const { runtime, nackHandles } = makeRuntime({ reject: true });
    await makeLoop({ runtime, turnState }).run();

    expect(turnState.turnStart).toHaveBeenCalledTimes(1);
    expect(turnState.turnEnd).not.toHaveBeenCalled();
    expect(turnState.turnInterrupted).not.toHaveBeenCalled();
    expect(turnState.turnError).not.toHaveBeenCalled();
    expect(turnState.turnFinish).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
  });

  it('原 stream onTurnStart 抛错时不发布 active、不进入 processTurn', async () => {
    const turnState = makeSink();
    const streamWriter = {
      write: () => { throw new Error('stream turn_start failed'); },
    } as unknown as StreamWriter;
    const { runtime, processTurn } = makeRuntime({ terminal: 'end' });
    await makeLoop({ runtime, turnState, streamWriter }).run();

    expect(turnState.turnStart).not.toHaveBeenCalled();
    expect(processTurn).not.toHaveBeenCalled();
  });

  it('terminal stream 写失败仍发布对应终态并由 finally 兜底', async () => {
    const turnState = makeSink();
    const streamWriter = {
      write: (event: { type: string }) => {
        if (event.type === 'turn_end') throw new Error('stream turn_end failed');
      },
    } as unknown as StreamWriter;
    const { runtime } = makeRuntime({ terminal: 'end' });
    await makeLoop({ runtime, turnState, streamWriter }).run();

    expect(turnState.turnStart).toHaveBeenCalledTimes(1);
    expect(turnState.turnEnd).toHaveBeenCalledTimes(1);
    expect(turnState.turnFinish).toHaveBeenCalledTimes(1);
  });

  it('sink 写失败逐项审计且不影响 processTurn/ack 业务', async () => {
    const audit = makeAudit();
    const turnState = makeSink();
    for (const method of ['turnStart', 'turnEnd', 'turnInterrupted', 'turnError', 'turnFinish'] as const) {
      turnState[method] = vi.fn(() => { throw new Error(`${method} write failed`); });
    }
    const { runtime, processTurn, ackHandles } = makeRuntime({ terminal: 'end' });
    await makeLoop({ runtime, turnState, audit }).run();

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'normal_turn_end');
    const failures = audit.entries.filter(([type]) => type === EVENTLOOP_AUDIT_EVENTS.TURN_STATE_WRITE_FAILED);
    expect(failures.map(([, operation]) => operation)).toEqual([
      'operation=turnStart',
      'operation=turnEnd',
      'operation=turnFinish',
    ]);
  });
});
