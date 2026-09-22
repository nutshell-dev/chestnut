/**
 * Runtime processBatch-era orchestrator reverse tests (phase 1285)
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 *
 * 语义变迁记录：
 * - 旧 processBatch 对 interrupt/failed turn 重抛错误；现行 EventLoop 不冒泡——
 *   interrupt 经 TurnResult.interrupted + ack('graceful_interrupt') 结算，
 *   failed turn 经 nack + error handler 审计结算。相应「rejects」断言退役。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { StepAbortError } from '../../../src/core/step-executor/index.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';

// Step H (phase1895): EventLoop 驱动失败 turn 时 dispatchError fallback 有
// UNKNOWN_ERROR_RECOVERY_DELAY_MS 退避；测试用小值锁状态机。
vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10,
    INTERRUPT_RECOVERY_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50,
  };
});

describe('Runtime processBatch orchestrator (phase 1285)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-orchestrator-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  /**
   * Step H: EventLoop 走 prepareInbox/formatPreparedInbox/peekPendingTurnFacts 公开面。
   * fake inbox batch 一次性消费（对齐旧 drain「领取后不再重复」语义）。
   */
  class InterruptTestRuntime extends Runtime {
    public fakeBatch: {
      injected: Message[];
      sources: Array<{ text: string; type: string }>;
      infos: InboxMessage[];
      handles: InboxHandle[];
    } | null = null;
    private preparedSnapshot: NonNullable<InterruptTestRuntime['fakeBatch']> | null = null;
    public reactThrow: Error | null = null;

    protected override async prepareInbox(): Promise<PreparedInboxBatch> {
      const batch = this.fakeBatch;
      this.fakeBatch = null;
      this.preparedSnapshot = batch;
      if (!batch) return { entries: [] };
      return {
        entries: batch.handles.map((handle, i) => ({ message: batch.infos[i], handle })),
      };
    }

    protected override async formatPreparedInbox(): Promise<FormattedInboxBatch> {
      const batch = this.preparedSnapshot;
      if (!batch) return { injected: [], sources: [], count: 0, infos: [] };
      return {
        injected: batch.injected,
        sources: batch.sources,
        count: batch.injected.length,
        infos: batch.infos,
      };
    }

    protected override async peekPendingTurnFacts(): Promise<{ addressed: InboxMessage[]; controls: InboxMessage[] }> {
      return { addressed: this.fakeBatch ? this.fakeBatch.infos : [], controls: [] };
    }

    protected override async _runReact(_messages: Message[]) {
      if (this.reactThrow) throw this.reactThrow;
    }
  }

  function makeFakeBatch(
    injected: Message[],
    infos: InboxMessage[],
    handles: InboxHandle[],
  ): NonNullable<InterruptTestRuntime['fakeBatch']> {
    return {
      injected,
      sources: injected.map(m => ({
        text: typeof m.content === 'string' ? m.content : '[content]',
        type: 'user_chat',
      })),
      infos,
      handles,
    };
  }

  function msg(id: string, type: string, from: string, content: string): InboxMessage {
    return {
      id, type, from, to: 'edge-claw',
      content, priority: 'normal', timestamp: new Date().toISOString(),
    } as InboxMessage;
  }

  function handle(name: string): InboxHandle {
    return { filePath: `inflight/${name}.md`, originalFileName: `${name}.md` } as InboxHandle;
  }

  async function makeInterruptRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
    const runtime = new InterruptTestRuntime({
      clawId: 'edge-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime;
  }

  /** EventLoop 单 owner 驱动一轮（替代已删除的 legacy-process-batch）。 */
  function driveLoop(runtime: Runtime) {
    return createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();
  }

  it('UserInterrupt + user_chat message: commitTurn(reason=user_interrupt) + ack、不 nack/rollback (phase 1391 / 1403)', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      [msg('msg1', 'user_chat', 'user', 'hi')],
      [handle('msg1')],
    );
    runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

    // Step H: 现行 EventLoop 不冒泡 interrupt——turn 以 TurnResult.interrupted 结算
    // + ack('graceful_interrupt')（旧「rejects StepAbortError」断言随 processBatch 退役）。
    await driveLoop(runtime);

    expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalled();
    expect(nackSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('UserInterrupt + system-typed message (type=message): commitTurn + ack、不 nack/rollback (phase 1415 reframe phase 1403)', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [{ role: 'user', content: [{ type: 'text', text: 'contract done' }] }],
      [msg('msg1', 'message', 'dialogstore-auditor', 'contract done')],
      [handle('msg1')],
    );
    runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

    await driveLoop(runtime);

    expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'inflight/msg1.md' }),
    );
    expect(nackSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('UserInterrupt + mixed batch (user_chat + system message): ack both (phase 1415 reframe phase 1403)', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'contract done' }] },
      ],
      [
        msg('msg1', 'user_chat', 'user', 'hi'),
        msg('msg2', 'message', 'auditor', 'contract done'),
      ],
      [handle('msg1'), handle('msg2')],
    );
    runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

    await driveLoop(runtime);

    expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'inflight/msg1.md' }));
    expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'inflight/msg2.md' }));
    expect(ackSpy).toHaveBeenCalledTimes(2);
    expect(nackSpy).not.toHaveBeenCalled();
  });

  it('successful turn calls commitTurn + ack', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      [msg('msg1', 'message', 'sender', 'hi')],
      [handle('msg1')],
    );
    runtime.reactThrow = null;

    await driveLoop(runtime);

    expect(commitSpy).toHaveBeenCalled();
    expect(ackSpy).toHaveBeenCalledWith({ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' });
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('MaxStepsExceededError calls rollbackTurn + ack(agent_loop_crash) + outbox notification', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      [msg('msg1', 'message', 'sender', 'hi')],
      [handle('msg1')],
    );
    runtime.reactThrow = new MaxStepsExceededError(10);

    // Step H: 现行 EventLoop 不冒泡 crash——turn 以 failed TurnResult 结算；
    // phase 1121 Step B：agent-loop crash 不 mutate Contract、ack 破热循环
    //（旧 helper 的 nack('rollback') 断言退役，现行等价面 = ack + rollback + FATAL 审计）。
    await driveLoop(runtime);

    expect(rollbackSpy).toHaveBeenCalled();
    expect(ackSpy).toHaveBeenCalled();
    expect(nackSpy).not.toHaveBeenCalled();
  });

  it('processBatch calls beginTurn before runReact', async () => {
    const runtime = await makeInterruptRuntime();
    const beginSpy = vi.spyOn((runtime as any).sessionManager, 'beginTurn').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.fakeBatch = makeFakeBatch(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      [msg('msg1', 'message', 'sender', 'hi')],
      [handle('msg1')],
    );

    await driveLoop(runtime);
    expect(beginSpy).toHaveBeenCalled();
    expect(commitSpy).toHaveBeenCalled();
  });
});
