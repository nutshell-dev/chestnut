import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/types.js';
import * as maybeTrimModule from '../../../src/core/context_manager/maybe-trim-proactive.js';
import { CACHE_TTL_MS, CONTEXT_TRIM_RECENT_WINDOW_MS } from '../../../src/core/context_manager/constants.js';
import { CONTEXT_TRIM_COMPLETED } from '../../../src/core/context_manager/audit-events.js';
import { estimateMessagesTokens, estimateTextTokens } from '../../../src/foundation/llm-provider/token-estimator.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';
import { processRuntimeMessage } from '../../helpers/process-runtime-message.js';

function makeFakeBatch(injected: Message[]) {
  return {
    injected,
    sources: injected.map(m => ({
      text: typeof m.content === 'string' ? m.content : '[content]',
      type: 'user_chat',
    })),
    infos: injected.map((m, i) => ({
      id: `fake-${i}`,
      type: 'user_chat',
      from: 'user',
      to: 'test-claw',
      content: typeof m.content === 'string' ? m.content : '[content]',
      priority: 'normal',
      timestamp: new Date(0).toISOString(),
    } as InboxMessage)),
    handles: injected.map((_, i) => ({
      filePath: `inbox/inflight/fake-${i}.md`,
      originalFileName: `fake-${i}.md`,
    } as InboxHandle)),
  };
}

/**
 * Step H: EventLoop 走 prepareInbox/formatPreparedInbox/peekPendingTurnFacts 公开面。
 * fake inbox batch 一次性消费（对齐旧 drain「领取后不再重复」语义），
 * 保持注入消息与旧 drainResult 逐字节一致（无真实格式化 enrichment）。
 */
class ProactiveTrimTestRuntime extends Runtime {
  public fakeBatch: ReturnType<typeof makeFakeBatch> | null = null;
  private preparedSnapshot: ReturnType<typeof makeFakeBatch> | null = null;
  public runReactMessages?: Message[];
  /** 为测试 4 开启：调用真实 _runReact 以触发 onLLMResult callback */
  public callSuperRunReact = false;

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
    if (!batch) return { injected: [], sources: [], count: 0, infos: [], selected: [], deferred: [], oversizedAlone: false };
    return {
      injected: batch.injected,
      sources: batch.sources,
      count: batch.injected.length,
      infos: batch.infos,
      selected: batch.handles.map((handle, i) => ({ message: batch.infos[i], handle })),
      deferred: [],
      oversizedAlone: false,
    };
  }

  protected override async peekPendingTurnFacts(): Promise<{ addressed: InboxMessage[]; controls: InboxMessage[] }> {
    return { addressed: this.fakeBatch ? [{ id: 'fake' } as InboxMessage] : [], controls: [] };
  }

  protected override async _runReact(messages: Message[], ..._rest: unknown[]) {
    this.runReactMessages = messages;
    if (this.callSuperRunReact) {
      return (super._runReact as (...args: unknown[]) => Promise<void>)(messages, ..._rest);
    }
    // 默认：不调用真实 runReact，避免测试需要完整 LLM 装配
  }
}

describe('runtime proactive trim integration', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-proactive-trim-${randomUUID()}`);
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

  async function makeRuntime(
    contextTrimmingEnabled?: boolean,
    contextTrimPolicy?: Record<string, number>,
  ) {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new ProactiveTrimTestRuntime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
      ...(contextTrimmingEnabled === undefined ? {} : { contextTrimmingEnabled }),
      ...(contextTrimPolicy === undefined ? {} : { contextTrimPolicy }),
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime as ProactiveTrimTestRuntime;
  }

  /** EventLoop 单 owner 驱动一轮（替代已删除的 legacy-process-batch）。 */
  function driveLoop(runtime: Runtime) {
    return createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' }).run();
  }

  it('1. first turn calls maybeTrimProactive with cacheExpired = false', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime(true);
    const msg = { role: 'user', content: 'hi' } as Message;
    runtime.fakeBatch = makeFakeBatch([msg]);

    await driveLoop(runtime);

    expect(spy).toHaveBeenCalledTimes(1);
    // phase 1861 (CM-D2)：首 turn（lastLLMCallAt = 0）由 caller 判 cacheExpired = false
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cacheExpired: false }));
    expect(runtime.runReactMessages).toEqual([msg]);
  });

  it('1b. idle ≤ CACHE_TTL_MS → cacheExpired = false（caller 判据）', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime(true);
    runtime.fakeBatch = makeFakeBatch([{ role: 'user', content: 'hi' } as Message]);
    (runtime as any).lastLLMCallAt = Date.now() - CACHE_TTL_MS + 60_000;

    await driveLoop(runtime);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cacheExpired: false }));
  });

  it('1c. idle > CACHE_TTL_MS → cacheExpired = true（caller 判据）', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime(true);
    runtime.fakeBatch = makeFakeBatch([{ role: 'user', content: 'hi' } as Message]);
    (runtime as any).lastLLMCallAt = Date.now() - CACHE_TTL_MS - 60_000;

    await driveLoop(runtime);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cacheExpired: true, now: expect.any(Number) }),
    );
  });

  it('2. processBatch replaces messages when maybeTrimProactive returns result', async () => {
    const original = { role: 'user', content: 'original' } as Message;
    const trimmed = { role: 'assistant', content: 'trimmed' } as Message;
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue({
      newMessages: [trimmed],
      archived: true,
      estimatedTokensAfter: 5,
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    runtime.fakeBatch = makeFakeBatch([original]);

    await driveLoop(runtime);

    expect(runtime.runReactMessages).toEqual([trimmed]);
  });

  it('3. test message driver calls maybeTrimProactive and replaces messages', async () => {
    const original = { role: 'user', content: 'original' } as Message;
    const trimmed = { role: 'assistant', content: 'trimmed' } as Message;
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue({
      newMessages: [trimmed],
      archived: true,
      estimatedTokensAfter: 5,
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });

    await processRuntimeMessage(runtime, original);

    expect(runtime.runReactMessages).toEqual([trimmed]);
  });

  it('3b. unarchived proactive result does not leak candidate messages into runReact', async () => {
    const original = { role: 'user', content: 'original' } as Message;
    const candidate = { role: 'assistant', content: 'candidate' } as Message;
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue({
      newMessages: [candidate],
      archived: false,
      estimatedTokensAfter: 5,
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    runtime.fakeBatch = makeFakeBatch([original]);

    await driveLoop(runtime);

    expect(runtime.runReactMessages).toEqual([original]);
  });

  it('4. _runReact onLLMResult callback updates lastLLMCallAt', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runReactSpy = vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      options.stepCallbacks?.onLLMResult?.({ model: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 });
      return { finalText: '', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    runtime.callSuperRunReact = true;
    expect((runtime as any).lastLLMCallAt).toBe(0);

    await processRuntimeMessage(runtime, { role: 'user', content: 'hi' } as Message);

    expect(runReactSpy).toHaveBeenCalled();
    expect((runtime as any).lastLLMCallAt).toBeGreaterThan(0);
  });

  it('5. does not call maybeTrimProactive when contextManagerConfig is absent', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime();
    runtime.fakeBatch = makeFakeBatch([{ role: 'user', content: 'hi' } as Message]);

    await driveLoop(runtime);

    expect(spy).not.toHaveBeenCalled();
  });

  it('6. contextTrimPolicy injection flows into maybeTrimProactive inputs (CM-D1)', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime(true, {
      proactiveTargetRatio: 0.5,
      recentWindowMs: 1_234,
      previewBytes: 56,
      reactiveTargetRatio: 0.6,
    });
    runtime.fakeBatch = makeFakeBatch([{ role: 'user', content: 'hi' } as Message]);

    await driveLoop(runtime);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          proactiveTriggerRatio: 0.75,
          proactiveTargetRatio: 0.5,
          reactiveTargetRatio: 0.6,
          recentWindowMs: 1_234,
          previewBytes: 56,
        }),
      }),
    );
  });

  it('routes a prepared additive meter through the real Runtime-to-trimV2 chain', async () => {
    const runtime = await makeRuntime(true);
    const measureMessage = vi.fn((message: Message) => estimateMessagesTokens([message]));
    const meter = {
      descriptor: {
        revision: 'phase2138-runtime', provider: 'test', model: 'test', api: 'test',
        contextWindow: 1_000, profile: 'legacy-cl100k-v2',
      },
      capability: {
        kind: 'message_additive' as const,
        measureFixed: () => estimateTextTokens('sys'),
        measureMessage,
      },
      measure: vi.fn((input: { messages: readonly Message[] }) => ({
        kind: 'estimated' as const,
        tokens: estimateTextTokens('sys') + estimateMessagesTokens(input.messages),
        method: 'legacy-cl100k' as const,
        reason: 'baseline',
      })),
    };
    const prepare = vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'available', meter,
    });
    const audit = vi.spyOn(runtime.getAuditWriter(), 'write');
    const now = Date.now();
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      const addedAt = new Date(now - CONTEXT_TRIM_RECENT_WINDOW_MS - 100 + i).toISOString();
      messages.push({ role: 'user', content: `old request ${i}`, addedAt });
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${i} ${'测'.repeat(400)}` }],
        addedAt,
      });
    }
    messages.push({ role: 'user', content: 'recent', addedAt: new Date(now).toISOString() });
    (runtime as any).lastLLMCallAt = now - CACHE_TTL_MS - 1_000;

    const trimmed = await runtime.proactiveTrimIfNeeded(messages, 'sys', []);

    expect(prepare).toHaveBeenCalledWith({ kind: 'preview' });
    expect(meter.measure).not.toHaveBeenCalled();
    expect(measureMessage).toHaveBeenCalled();
    expect(trimmed).not.toEqual(messages);
    expect(trimmed.some(message => message.systemSubtype === 'context_trim_summary')).toBe(true);
    const completed = audit.mock.calls.filter(([event]) => event === CONTEXT_TRIM_COMPLETED);
    expect(completed).toHaveLength(2);
    expect(completed.every(([, ...details]) => details.includes('token_count_mode=message_ledger'))).toBe(true);
    expect(completed.every(([, ...details]) => details.includes('token_count_full_candidate_scans=0'))).toBe(true);
  });
});
