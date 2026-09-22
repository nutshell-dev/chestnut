/**
 * Phase 1121 Step B: Runtime catch must NOT mutate Contract on agent-loop crash.
 *
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 * 语义变迁：crash 不冒泡——「rejects」断言退役；现行等价面 =
 * ack(agent_loop_crash) 破热循环 + eventloop_fatal 审计；markCorrupted 断言强度不变。
 * 旧 helper 的 runtime_catch_unhandled（helper 局部事件）已随 processBatch 退役。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import {
  MaxStepsExceededError,
  WallTimeExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
} from '../../../src/core/agent-executor/errors.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';

import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';

// Step H (phase1895): EventLoop 驱动 crash turn 时 fallback handler 有
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

/**
 * Step H: EventLoop 走 prepareInbox/formatPreparedInbox/peekPendingTurnFacts 公开面。
 * fake inbox batch 一次性消费（对齐旧 drain「领取后不再重复」语义）。
 */
class CrashTestRuntime extends Runtime {
  public fakeBatch: {
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    infos: InboxMessage[];
    handles: InboxHandle[];
  } | null = null;
  private preparedSnapshot: NonNullable<CrashTestRuntime['fakeBatch']> | null = null;
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

describe('Runtime crash handling (phase 1121 Step B)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-mark-loop-crashed-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function makeCrashRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
    const runtime = new CrashTestRuntime({
      clawId: 'edge-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime;
  }

  function seedOneMessage(runtime: CrashTestRuntime, metadata?: Record<string, string>) {
    runtime.fakeBatch = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sources: [],
      infos: [{
        id: 'msg1', type: 'task_result', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      } as InboxMessage],
      handles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' } as InboxHandle],
    };
  }

  const errClasses = [
    { Cls: MaxStepsExceededError, args: [10] },
    { Cls: WallTimeExceededError, args: [1000, 2000] },
    { Cls: ConsecutiveParseErrorsExceededError, args: [3] },
    { Cls: ConsecutiveMaxTokensToolUseError, args: [5] },
    { Cls: LLMAllProvidersFailedError, args: [[{ provider: 'test', error: new Error('fail') }]] },
  ];

  for (const { Cls, args } of errClasses) {
    it(`${Cls.name} with contract_id does NOT call markCorrupted`, async () => {
      const runtime = await makeCrashRuntime();
      const markSpy = vi.spyOn((runtime as any).contractManager, 'markCorrupted').mockResolvedValue(undefined);
      const auditWrites: string[][] = [];
      vi.spyOn((runtime as any).auditWriter, 'write').mockImplementation((type: string, ...cols: string[]) => {
        auditWrites.push([type, ...cols]);
      });
      vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
      vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);

      seedOneMessage(runtime, { contract_id: 'test-contract' });
      runtime.reactThrow = new (Cls as any)(...args);

      // Step H: crash 不冒泡——EventLoop ack(agent_loop_crash) + FATAL 审计结算。
      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      expect(markSpy).not.toHaveBeenCalled();
      expect(auditWrites.some(a => a[0] === 'eventloop_fatal')).toBe(true);
      markSpy.mockRestore();
    });
  }

  it('contract_id 缺失 → audit-only (no Contract mutation)', async () => {
    const runtime = await makeCrashRuntime();
    const markSpy = vi.spyOn((runtime as any).contractManager, 'markCorrupted').mockResolvedValue(undefined);
    const auditWrites: string[][] = [];
    vi.spyOn((runtime as any).auditWriter, 'write').mockImplementation((type: string, ...cols: string[]) => {
      auditWrites.push([type, ...cols]);
    });
    vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);

    seedOneMessage(runtime);
    runtime.reactThrow = new MaxStepsExceededError(10);

    // Step H: 旧 helper 的 runtime_catch_unhandled 已随 processBatch 退役；
    // 现行等价面 = EventLoop agentLoopCrashHandler 的 FATAL 审计（reason=agent_loop_crash）。
    await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

    expect(markSpy).not.toHaveBeenCalled();
    expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => String(c).includes('reason=agent_loop_crash')))).toBe(true);
    markSpy.mockRestore();
  });
});
