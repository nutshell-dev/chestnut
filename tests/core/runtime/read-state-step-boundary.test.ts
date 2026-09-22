/**
 * Runtime read-state step boundary — Phase 1229 Step A
 *
 * Verifies that Runtime calls FileTool's persistence primitive exactly once per
 * complete step, after the dialog snapshot has been saved, and awaits it before
 * the step is considered complete.
 *
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 * 语义变迁：turn 失败不再冒泡——「rejects」断言改为 processTurn TurnResult/nack 等价面。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import * as persistModule from '../../../src/foundation/file-tool/file-state-persist.js';
import { READ_STATE_FILE } from '../../../src/foundation/file-tool/file-state-persist.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';

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

function createMockLLMConfig() {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'claude-3-opus-20240229',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 30_000,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
    events: { emit: () => {} },
  };
}

/**
 * Step H: EventLoop 走 prepareInbox/formatPreparedInbox/peekPendingTurnFacts 公开面。
 * fake inbox batch 一次性消费（对齐旧 drain「领取后不再重复」语义）。
 */
class ReadStateTestRuntime extends Runtime {
  public fakeBatch: {
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    infos: InboxMessage[];
    handles: InboxHandle[];
  } | null = null;
  private preparedSnapshot: NonNullable<ReadStateTestRuntime['fakeBatch']> | null = null;

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
}

describe('Runtime read-state step boundary (Phase 1229 Step A)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-read-state-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'test-claw');
    await fs.mkdir(testClawDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function seedOneMessage(runtime: ReadStateTestRuntime, content = 'hi') {
    const injected = [{ role: 'user', content } as Message];
    runtime.fakeBatch = {
      injected,
      sources: injected.map(m => ({
        text: typeof m.content === 'string' ? m.content : '[content]',
        type: 'user_chat',
      })),
      infos: [{
        id: 'msg1', type: 'user_chat', from: 'user', to: 'test-claw',
        content, priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      handles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' } as InboxHandle],
    };
  }

  async function makeRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new ReadStateTestRuntime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime as ReadStateTestRuntime;
  }

  /** EventLoop 单 owner 驱动一轮（替代已删除的 legacy-process-batch）。 */
  function driveLoop(runtime: Runtime) {
    return createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' }).run();
  }

  it('onStepComplete saves dialog before persisting read-state', async () => {
    const runtime = await makeRuntime();
    const sessionManager = (runtime as any).sessionManager;
    const saveSpy = vi.spyOn(sessionManager, 'save')
      .mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    const persistSpy = vi.spyOn(persistModule, 'persistReadFileState').mockResolvedValue(undefined);

    let capturedOnStepComplete: ((stepCount: number) => Promise<void>) | undefined;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      capturedOnStepComplete = options.onStepComplete;
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    seedOneMessage(runtime);
    await driveLoop(runtime);

    expect(capturedOnStepComplete).toBeDefined();
    expect(saveSpy).toHaveBeenCalled();
    expect(persistSpy).toHaveBeenCalledWith((runtime as any).execContext);
    expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      persistSpy.mock.invocationCallOrder[0],
    );
  });

  it('read-state persist awaits dialog save (barrier)', async () => {
    const runtime = await makeRuntime();
    const sessionManager = (runtime as any).sessionManager;

    // The first save call is the turn-begin snapshot in _processTurnImpl and must resolve
    // so the step can reach onStepComplete. The second save call is inside onStepComplete
    // and is the one we defer to prove ordering.
    let saveCallCount = 0;
    let saveResolve: (() => void) | undefined;
    const saveDeferred = new Promise<void>((resolve) => { saveResolve = resolve; });
    vi.spyOn(sessionManager, 'save').mockImplementation(async (...args: any[]) => {
      saveCallCount++;
      if (saveCallCount === 2) {
        // onStepComplete's dialog save: block until the test releases it.
        await saveDeferred;
      }
      return { blockIndexPersisted: true, assignedBlockIds: [] };
    });

    let capturedOnStepComplete: ((stepCount: number) => Promise<void>) | undefined;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      capturedOnStepComplete = options.onStepComplete;
      // Return without awaiting onStepComplete so the test can inspect the barrier.
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    seedOneMessage(runtime);
    const batchPromise = driveLoop(runtime);

    await vi.waitUntil(() => capturedOnStepComplete !== undefined, { timeout: 1000 });
    const stepPromise = capturedOnStepComplete!(1);

    // Persist must not run until dialog save settles.
    const fileExistsBefore = await fs.access(path.join(testClawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsBefore).toBe(false);

    saveResolve!();
    await stepPromise;
    await batchPromise;

    // After the barrier, the real persistence primitive wrote the file.
    const fileExistsAfter = await fs.access(path.join(testClawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsAfter).toBe(true);
  });

  it('persist failure is not swallowed by Runtime', async () => {
    const runtime = await makeRuntime();
    const persistError = new Error('disk full');
    vi.spyOn(persistModule, 'persistReadFileState').mockRejectedValue(persistError);

    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    // Step H: 现行 EventLoop 不冒泡——turn 以 failed TurnResult 结算且 error 保持
    // 原对象身份（旧「rejects 'disk full'」断言的现行等价面）。
    let turnError: unknown;
    vi.spyOn(runtime, 'processTurn').mockImplementation(async (...args: any[]) => {
      const result = await Runtime.prototype.processTurn.apply(runtime, args as any);
      turnError = result.error;
      return result;
    });

    seedOneMessage(runtime);
    await driveLoop(runtime);

    expect(turnError).toBe(persistError);
    expect((turnError as Error).message).toBe('disk full');
  });

  it('parallel tool reads aggregate into a single step snapshot', async () => {
    const runtime = await makeRuntime();
    const persistSpy = vi.spyOn(persistModule, 'persistReadFileState').mockResolvedValue(undefined);

    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      // Simulate parallel readonly tool calls updating the same Map.
      (runtime as any).execContext.readFileState.set('x.md', {
        hash: 'hx', timestamp: 1, isFullRead: true,
      });
      (runtime as any).execContext.readFileState.set('y.md', {
        hash: 'hy', timestamp: 2, isFullRead: true,
      });
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    seedOneMessage(runtime);
    await driveLoop(runtime);

    // One persist call commits the aggregated state of the whole step.
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        readFileState: expect.objectContaining({ size: 2 }),
      }),
    );
  });
});
