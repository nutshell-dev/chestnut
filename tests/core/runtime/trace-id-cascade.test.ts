/**
 * trace-id cascade — phase 1343 α-6 reverse tests
 *
 * Covers:
 * - trace_id 唯一性（10 turn no dup）
 * - cross-module propagation invariant（audit row 必含 trace_id col）
 * - execContext trace_id forward verify
 * - turn 结束后 trace_id 清除
 *
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';
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

describe('Runtime trace-id cascade (phase 1343 α-6)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-trace-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'trace-claw');
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
  class TraceTestRuntime extends Runtime {
    public fakeBatch: {
      injected: Message[];
      sources: Array<{ text: string; type: string }>;
      infos: InboxMessage[];
      handles: InboxHandle[];
    } | null = null;
    private preparedSnapshot: NonNullable<TraceTestRuntime['fakeBatch']> | null = null;
    public capturedTraceIds: string[] = [];

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

    protected override async _runReact() {
      const execCtx = (this as any).execContext;
      if (execCtx.trace_id) {
        this.capturedTraceIds.push(execCtx.trace_id);
      }
    }
  }

  async function makeTraceRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'trace-claw' });
    const runtime = new TraceTestRuntime({
      clawId: 'trace-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    // fake inflight 句柄无真实文件——ack 结算走 mock（旧 helper addressedHandles:[] 不
    // ack；现行 EventLoop 对成功 turn 必 ack，等价性由 ack mock 承接）。
    vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    return runtime;
  }

  function seedOneMessage(runtime: TraceTestRuntime) {
    runtime.fakeBatch = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      infos: [{
        id: 'msg1', type: 'user_chat', from: 'user', to: 'trace-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      handles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' } as InboxHandle],
    };
  }

  /** EventLoop 单 owner 驱动一轮（替代已删除的 legacy-process-batch）。 */
  function driveLoop(runtime: Runtime) {
    return createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'trace-claw' }).run();
  }

  it('EventLoop-driven turn generates 16-char hex trace_id and sets on execContext', async () => {
    const runtime = await makeTraceRuntime();
    seedOneMessage(runtime);

    const execCtx = (runtime as any).execContext;
    expect(execCtx.trace_id).toBeUndefined();

    await driveLoop(runtime);

    expect(runtime.capturedTraceIds.length).toBe(1);
    const traceId = runtime.capturedTraceIds[0];
    expect(traceId).toBeDefined();
    expect(traceId).toMatch(/^[0-9a-f]{16}$/);
  });

  // trace_id 是 16-char hex = 2^64 entropy / N=10 与 N=50 的生日碰撞概率均 ≈ 0
  // (~10^-18)，两者都是在断言"生成器不平凡复用 (cache bug / off-by-one / 截断 bug)"
  // 而非做统计意义 uniqueness 测量。N=10 同样能抓所有可疑实现，省 ~3s。
  it('trace_id is unique across 10 turns', async () => {
    const runtime = await makeTraceRuntime();

    for (let i = 0; i < 10; i++) {
      seedOneMessage(runtime);
      await driveLoop(runtime);
    }

    const seen = new Set(runtime.capturedTraceIds);
    expect(seen.size).toBe(10);
    for (const traceId of runtime.capturedTraceIds) {
      expect(traceId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('audit rows contain trace_id col during turn', async () => {
    const runtime = await makeTraceRuntime();
    const auditWriter = (runtime as any).auditWriter;
    const originalWrite = auditWriter.write.bind(auditWriter);
    const captured: Array<{ args: (string | number)[]; traceId?: string }> = [];

    auditWriter.write = function (type: string, ...cols: (string | number)[]) {
      captured.push({ args: [type, ...cols], traceId: (auditWriter as any).traceId });
      return originalWrite(type, ...cols);
    };

    seedOneMessage(runtime);

    await driveLoop(runtime);

    // At least TURN_START audit row was captured
    const turnStartRow = captured.find(c => c.args[0] === 'turn_start');
    expect(turnStartRow).toBeDefined();
    expect(turnStartRow!.traceId).toBeDefined();
    expect(turnStartRow!.traceId).toMatch(/^[0-9a-f]{16}$/);

    // TURN_END also has same traceId
    const turnEndRow = captured.find(c => c.args[0] === 'turn_end');
    expect(turnEndRow).toBeDefined();
    expect(turnEndRow!.traceId).toEqual(turnStartRow!.traceId);
  });

  it('session save receives trace_id in snapshot', async () => {
    const runtime = await makeTraceRuntime();
    const saveSpy = vi.spyOn((runtime as any).sessionManager, 'save')
      .mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    seedOneMessage(runtime);

    await driveLoop(runtime);

    // First save (injected messages) should have trace_id
    const firstSave = saveSpy.mock.calls[0][0];
    expect(firstSave.trace_id).toBeDefined();
    expect(firstSave.trace_id).toMatch(/^[0-9a-f]{16}$/);

    expect(commitSpy).toHaveBeenCalled();
  });

  it('trace_id is cleared after turn ends', async () => {
    const runtime = await makeTraceRuntime();
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    seedOneMessage(runtime);

    await driveLoop(runtime);

    expect(commitSpy).toHaveBeenCalled();
    const execCtx = (runtime as any).execContext;
    expect(execCtx.trace_id).toBeUndefined();
    expect(runtime.getCurrentTraceId()).toBeUndefined();
    expect((runtime as any).auditWriter.traceId).toBeUndefined();
  });
});
