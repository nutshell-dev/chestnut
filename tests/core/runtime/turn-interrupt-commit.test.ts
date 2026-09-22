/**
 * Turn interrupt graceful → commit reclassify
 * Phase 1375 reverse tests
 *
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 * 语义变迁：interrupt/失败不冒泡——「rejects」断言退役；commit/nack/rollback/
 * 消息保留断言强度不变（现行 EventLoop 结算语义与旧 helper 一致或等价）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { StepAbortError } from '../../../src/core/step-executor/index.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
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

describe('turn interrupt: graceful → commit (phase 1375)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-turn-interrupt-${randomUUID()}`);
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
    public midTurnSaves = 0;

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
      const sessionManager = (this as any).sessionManager;
      // Simulate mid-turn saves (mirrors onStepComplete incremental save)
      for (let i = 0; i < this.midTurnSaves; i++) {
        await sessionManager.save({
          systemPrompt: 'sp',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: `step-${i}` },
          ],
          toolsForLLM: [],
        });
      }
      if (this.reactThrow) throw this.reactThrow;
    }
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

  function seedOneMessage(runtime: InterruptTestRuntime, info: InboxMessage) {
    runtime.fakeBatch = {
      injected: [{ role: 'user', content: [{ type: 'text', text: info.content }] }],
      sources: [],
      infos: [info],
      handles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' } as InboxHandle],
    };
  }

  function makeInfo(type: InboxMessage['type'], from: string, content: string): InboxMessage {
    return {
      id: 'msg1', type, from, to: 'edge-claw',
      content, priority: 'high', timestamp: new Date().toISOString(),
    } as InboxMessage;
  }

  /** EventLoop 单 owner 驱动一轮（替代已删除的 legacy-process-batch）。 */
  function driveLoop(runtime: Runtime) {
    return createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();
  }

  it('UserInterrupt + user_chat: dialog retains partial messages + TURN_COMMIT reason=user_interrupt + ack (phase 1391 / 1403)', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const origCommit = (runtime as any).sessionManager.commitTurn;
    const commitCallSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockImplementation(async (reason?: string) => {
      return origCommit.call((runtime as any).sessionManager, reason);
    });

    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

    seedOneMessage(runtime, makeInfo('user_chat', 'user', 'hi'));
    runtime.midTurnSaves = 3;
    runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

    // Step H: interrupt 不冒泡——EventLoop 以 ack('graceful_interrupt') 结算。
    await driveLoop(runtime);

    expect(commitCallSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalled();
    expect(nackSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();

    // Verify dialog retained partial messages (mid-turn saves preserved)
    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toBe('step-2');

    // Verify audit TURN_COMMIT with reason
    const turnCommitCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT,
    );
    expect(turnCommitCalls.length).toBeGreaterThanOrEqual(1);
    const lastTurnCommit = turnCommitCalls[turnCommitCalls.length - 1];
    expect(lastTurnCommit.some((c: any) => String(c).includes('reason=user_interrupt'))).toBe(true);
  });

  it('UserInterrupt + system-typed (type=message): dialog retains + TURN_COMMIT reason=user_interrupt + ack (phase 1415 reframe phase 1403)', async () => {
    const runtime = await makeInterruptRuntime();
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const origCommit = (runtime as any).sessionManager.commitTurn;
    const commitCallSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockImplementation(async (reason?: string) => {
      return origCommit.call((runtime as any).sessionManager, reason);
    });
    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

    seedOneMessage(runtime, makeInfo('message', 'dialogstore-auditor', 'contract done'));
    runtime.midTurnSaves = 1;
    runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

    await driveLoop(runtime);

    expect(commitCallSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'inflight/msg1.md' }),
    );
    expect(nackSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();

    // Dialog 仍保留 mid-turn 内容（commit 语义不变）
    const { session } = await sessionManager.load();
    expect(session.messages.length).toBeGreaterThanOrEqual(2);

    // TURN_COMMIT reason=user_interrupt 一致
    const turnCommitCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT,
    );
    expect(turnCommitCalls.length).toBeGreaterThanOrEqual(1);
    const lastTurnCommit = turnCommitCalls[turnCommitCalls.length - 1];
    expect(lastTurnCommit.some((c: any) => String(c).includes('reason=user_interrupt'))).toBe(true);
  });

  it('IdleTimeoutSignal mid-turn: dialog retains + TURN_COMMIT reason=idle_timeout', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const origCommit = (runtime as any).sessionManager.commitTurn;
    const commitCallSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockImplementation(async (reason?: string) => {
      return origCommit.call((runtime as any).sessionManager, reason);
    });
    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

    seedOneMessage(runtime, makeInfo('message', 'sender', 'hi'));
    runtime.midTurnSaves = 2;
    runtime.reactThrow = new StepAbortError({ kind: 'idle_timeout', ms: 30000 });

    // Step H: idle_timeout interrupt 现行结算 = nack(cause=idle_timeout, graceful_interrupt)。
    await driveLoop(runtime);

    expect(commitCallSpy).toHaveBeenCalledWith('idle_timeout');
    expect(nackSpy).toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();

    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toBe('step-1');

    const turnCommitCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT,
    );
    expect(turnCommitCalls.length).toBeGreaterThanOrEqual(1);
    const lastTurnCommit = turnCommitCalls[turnCommitCalls.length - 1];
    expect(lastTurnCommit.some((c: any) => String(c).includes('reason=idle_timeout'))).toBe(true);
  });

  it('真错误（throw Error）: dialog rollback to begin snapshot + TURN_ROLLBACK', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);
    const origRollback = (runtime as any).sessionManager.rollbackTurn;
    const rollbackCallSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockImplementation(async (reason?: string) => {
      return origRollback.call((runtime as any).sessionManager, reason);
    });
    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

    seedOneMessage(runtime, makeInfo('message', 'sender', 'hi'));
    runtime.midTurnSaves = 2;
    runtime.reactThrow = new Error('tool crash');

    // Step H: 失败 turn 不冒泡——EventLoop 以 nack + rollback 结算（断言强度不变）。
    await driveLoop(runtime);

    expect(rollbackCallSpy).toHaveBeenCalled();
    expect(nackSpy).toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();

    // Verify dialog rolled back to pre-turn state (pre-seed message only, mid-turn saves gone)
    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('pre-seed');

    // Verify audit TURN_ROLLBACK
    const rollbackCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_ROLLBACK,
    );
    expect(rollbackCalls.length).toBe(1);
  });

  it('invariant: rollbackTurn ≤ 1 call site in runtime.ts (真错误 else 分支)', async () => {
    const runtimePath = path.join(__dirname, '../../../src/core/runtime/runtime.ts');
    const src = await fs.readFile(runtimePath, 'utf8');
    const matches = src.match(/rollbackTurn/g);
    // 1 reference in import/type + 1 actual call site in else branch
    expect(matches?.length ?? 0).toBeLessThanOrEqual(2);
  });
});
