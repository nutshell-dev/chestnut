/**
 * phase 690 Step B: Runtime 反应式 trim+retry 集成测试。
 * Step H (phase1895): 改由真实 EventLoop 单 owner 驱动（替代 legacy-process-batch）。
 *
 * 验：LLM 抛 LLMContextExceededError → EventLoop reactiveTrim → 有界重试（下轮 run）→ 成功 final。
 * 验：retry 预算 CONTEXT_TRIM_RETRY_MAX 耗尽 → blocked gate 持久化、不再调 LLM。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps, TEST_LLM_RETRY_DELAY_MS } from '../../helpers/runtime-deps.js';
import { testProviderConnection } from '../../helpers/llm-provider.js';
import { TEST_LLM_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { LLMContextExceededError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import * as trimAndPersistModule from '../../../src/core/context_manager/trim-and-persist.js';
import { ContextInputMeasurementError, type TrimRuntimePolicy } from '../../../src/core/context_manager/index.js';
import * as maybeTrimModule from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';
import type { StreamEvent } from '../../../src/foundation/stream/index.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const {
  TEST_UNKNOWN_ERROR_RECOVERY_DELAY_MS,
  TEST_INTERRUPT_RECOVERY_DELAY_MS,
  TEST_CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS,
  TEST_CONTEXT_TRIM_RETRY_MAX_DELAY_MS,
} = vi.hoisted(() => ({
  TEST_UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10, // 10ms 小预算，快速锁失败恢复状态机。
  TEST_INTERRUPT_RECOVERY_DELAY_MS: 10, // 与失败恢复同量级，避免打断测试真实等待。
  TEST_CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10, // 首次 trim 重试用小步长。
  TEST_CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50, // 5 × 初值，覆盖退避封顶。
}));

// Step H: EventLoop 的 trim 重试退避（30s 起）与 dispatchError fallback 退避
// 是生产值；测试用小值锁状态机（对齐 tests/core/event-loop/event-loop.test.ts）。
vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: TEST_UNKNOWN_ERROR_RECOVERY_DELAY_MS,
    INTERRUPT_RECOVERY_DELAY_MS: TEST_INTERRUPT_RECOVERY_DELAY_MS,
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: TEST_CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: TEST_CONTEXT_TRIM_RETRY_MAX_DELAY_MS,
  };
});

function createMockLLMConfig() {
  return {
    primary: testProviderConnection({
      name: 'mock',
      apiKey: 'test-key',
      model: 'claude-3-opus-20240229',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    }),
    maxAttempts: 1,
    retryDelayMs: TEST_LLM_RETRY_DELAY_MS,
    events: { emit: () => {} },
  };
}

/** Phase 1978: 捕获 EventLoop 经 streamWriter 发出的结构化 trim 事件。 */
function captureStreamEvents() {
  const events: StreamEvent[] = [];
  return {
    events,
    streamWriter: { write: (event: StreamEvent) => { events.push(event); } },
  };
}

describe('runtime reactive trim+retry path', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-reactive-trim-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'test-claw');
    await fs.mkdir(testClawDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent */ });
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  });

  async function makeRuntime(contextTrimPolicy?: Partial<TrimRuntimePolicy>) {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
      contextTrimmingEnabled: true,
      ...(contextTrimPolicy === undefined ? {} : { contextTrimPolicy }),
    });
    runtimes.push(runtime);
    await runtime.initialize();
    vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'available',
      meter: {
        descriptor: {
          revision: 'phase2148-reactive', provider: 'test', model: 'test', api: 'test',
          contextWindow: 1_000, profile: 'legacy-cl100k-v2',
        },
        capability: { kind: 'unknown' as const },
        measure: () => ({ kind: 'estimated' as const, tokens: 1000, method: 'deepseek-v41-text' as const, reason: 'test' }),
      },
    });
    return runtime;
  }

  function mockPrimaryTokens(runtime: Runtime, tokens: number, contextWindow = 1_000) {
    const meter = {
      descriptor: {
        revision: 'phase2209-reactive', provider: 'test', model: 'test', api: 'test',
        contextWindow, profile: 'legacy-cl100k-v2',
      },
      capability: { kind: 'unknown' as const },
      measure: vi.fn(() => ({
        kind: 'estimated' as const,
        tokens,
        method: 'deepseek-v41-text' as const,
        reason: 'test',
      })),
    };
    vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'available', meter,
    });
    return meter;
  }

  /** 真实 pending 消息：EventLoop drain 失败后会 nack 回 pending，供下轮 run 重试。 */
  async function writePendingMsg(id: string) {
    const content = `---\nid: ${id}\ntype: message\nfrom: sender\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nhi\n`;
    await fs.writeFile(path.join(testClawDir, 'inbox', 'pending', `${id}.md`), content);
  }

  it('catches LLMContextExceededError → trim → retry succeeds', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 1000,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      if (runReactCalls === 1) {
        throw new LLMContextExceededError('test-provider', 400, 'prompt is too long');
      }
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    const meter = {
      descriptor: {
        revision: 'phase2138-reactive', provider: 'test', model: 'test', api: 'test',
        contextWindow: 1_000, profile: 'legacy-cl100k-v2',
      },
      capability: {
        kind: 'message_additive' as const,
        measureFixed: () => ({ kind: 'estimated' as const, tokens: 0, method: 'legacy-cl100k' as const, reason: 'test' }),
        measureMessage: () => ({ kind: 'estimated' as const, tokens: 1, method: 'legacy-cl100k' as const, reason: 'test' }),
      },
      measure: vi.fn(() => ({ kind: 'estimated' as const, tokens: 1000, method: 'deepseek-v41-text' as const, reason: 'test' })),
    };
    const runtime = await makeRuntime();
    const prepare = vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'available', meter,
    });
    await writePendingMsg('m1');
    const capture = captureStreamEvents();
    const loop = createTestEventLoop({
      runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
    });

    // 第 1 轮：turn 失败 → reactiveTrim → 有界重试安排（消息 nack 回 pending）；
    // 第 2 轮：重新 drain 同消息 → turn 成功 → ack。
    await loop.run();
    await loop.run();

    expect(runReactCalls).toBe(2);
    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      triggerKind: 'reactive_overflow',
      measurementCapability: meter.capability,
      measurementDescriptor: meter.descriptor,
    }));
    expect(prepare).toHaveBeenCalledWith({ kind: 'failure', error: expect.any(LLMContextExceededError) });
    const trimInputs = trimSpy.mock.calls[0][0];
    expect(trimInputs.measureComplete?.([])).toEqual({
      kind: 'estimated', tokens: 1000, method: 'deepseek-v41-text', reason: 'test',
    });
    // Phase 1978: trim 成功 → 恰好一条 retry 事件（无 blocked）
    const trimEvents = capture.events.filter(e => String(e.type).startsWith('context_trim_'));
    expect(trimEvents).toHaveLength(1);
    expect(trimEvents[0]).toMatchObject({
      type: 'context_trim_retry_scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: TEST_CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS,
      before: 1000,
      after: 100,
    });
  });

  it('bounded retry: CONTEXT_TRIM_RETRY_MAX(3) 预算耗尽后 blocked gate、不再调 LLM', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 1000,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      throw new LLMContextExceededError('test-provider', 400, 'prompt is too long');
    });

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const capture = captureStreamEvents();
    const loop = createTestEventLoop({
      runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
    });

    // 3 次重试预算：每轮 fail → trim → 安排下一轮；第 4 次 fail 时预算耗尽
    // → 进入 blocked gate（persist 到 status/llm-request-blocked-state.json）。
    await loop.run();
    await loop.run();
    await loop.run();
    expect(runReactCalls).toBe(3);
    expect(trimSpy).toHaveBeenCalledTimes(3);

    await loop.run();
    expect(runReactCalls).toBe(4);
    // Phase 1978: 3 次 retry 事件 + 1 次 blocked（retry_exhausted）
    const retryEvents = capture.events.filter(e => e.type === 'context_trim_retry_scheduled');
    const blockedEvents = capture.events.filter(e => e.type === 'context_trim_blocked');
    expect(retryEvents.map(e => e.attempt)).toEqual([1, 2, 3]);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      type: 'context_trim_blocked',
      reason: 'retry_exhausted',
      attempts: 3,
      maxAttempts: 3,
    });
    expect(trimSpy).toHaveBeenCalledTimes(3);
    const blockedState = await fs.readFile(
      path.join(testClawDir, 'status', 'llm-request-blocked-state.json'),
      'utf-8',
    );
    expect(blockedState).toContain('retry_exhausted');

    // blocked gate fail-closed：后续 run 在 drain 前被拦，LLM 零新增调用。
    await loop.run();
    expect(runReactCalls).toBe(4);
  });

  it('fails closed without trimming when the failure window evidence is unavailable', async () => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist');
    const runtime = await makeRuntime();
    vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'unavailable', reason: 'missing_evidence',
    });
    const audit = vi.spyOn(runtime.getAuditWriter(), 'write');

    await expect(runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long')))
      .rejects.toBeInstanceOf(ContextInputMeasurementError);
    expect(trimSpy).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      'runtime_trim_window_unavailable', 'kind=reactive', 'reason=missing_evidence',
    );
  });

  it('returns typed not_applicable at 749 below a 750 threshold without persistence', async () => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist');
    const runtime = await makeRuntime();
    const meter = mockPrimaryTokens(runtime, 749);
    const archive = vi.spyOn((runtime as any).sessionManager, 'archive');
    const save = vi.spyOn((runtime as any).sessionManager, 'save');
    const audit = vi.spyOn(runtime.getAuditWriter(), 'write');

    const outcome = await runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long'));

    expect(outcome).toMatchObject({
      status: 'not_applicable',
      reason: 'primary_threshold_not_reached',
      before: 749,
      primaryWindow: 1000,
      triggerRatio: 0.75,
      triggerTokens: 750,
      archived: false,
    });
    expect(meter.measure).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.any(String),
      messages: expect.any(Array),
      tools: expect.any(Array),
    }));
    expect(trimSpy).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      'runtime_reactive_trim_not_applicable',
      'reason=primary_threshold_not_reached',
      'before=749',
      'primary_window=1000',
      'trigger_ratio=0.75',
      'trigger_tokens=750',
    );
  });

  it('calls reactive trim at the 750/750 threshold', async () => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 750,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    });
    const runtime = await makeRuntime();
    mockPrimaryTokens(runtime, 750);

    const outcome = await runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long'));

    expect(outcome.status).toBe('target_reached');
    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      policy: { kind: 'reactive', targetCompleteTokens: 750 },
    }));
  });

  it('uses custom trigger and reactive target ratios', async () => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 500,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    });
    const runtime = await makeRuntime({ proactiveTriggerRatio: 0.5, reactiveTargetRatio: 0.6 });
    mockPrimaryTokens(runtime, 500);

    await runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long'));

    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      policy: { kind: 'reactive', targetCompleteTokens: 600 },
    }));
  });

  it.each([
    { primaryWindow: 1_024_000, fallbackWindow: 1_000_000 },
    { primaryWindow: 1_000_000, fallbackWindow: 1_024_000 },
  ])('uses the primary window instead of smaller or larger fallback evidence', async ({ primaryWindow, fallbackWindow }) => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: primaryWindow,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    });
    const runtime = await makeRuntime();
    mockPrimaryTokens(runtime, primaryWindow, primaryWindow);
    const error = new LLMContextExceededError('fallback', 413, 'too long', {
      descriptor: {
        revision: 'fallback-evidence', provider: 'fallback', model: 'fallback', api: 'test',
        contextWindow: fallbackWindow, profile: 'fallback-profile',
      },
    });

    await runtime.reactiveTrim(error);

    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      contextWindow: primaryWindow,
      measurementDescriptor: expect.objectContaining({ contextWindow: primaryWindow }),
      policy: { kind: 'reactive', targetCompleteTokens: Math.floor(primaryWindow * 0.75) },
    }));
  });

  it('fails closed when the primary complete-input measurement is unavailable', async () => {
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist');
    const runtime = await makeRuntime();
    const meter = mockPrimaryTokens(runtime, 750);
    meter.measure.mockReturnValue({ kind: 'unavailable', reason: 'tokenizer_unavailable' } as any);
    const archive = vi.spyOn((runtime as any).sessionManager, 'archive');
    const save = vi.spyOn((runtime as any).sessionManager, 'save');

    await expect(runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long')))
      .rejects.toMatchObject({
        name: 'ContextInputMeasurementError',
        reason: 'tokenizer_unavailable',
      });
    expect(trimSpy).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('returns additive unavailability from the real ContextManager with its source reason and descriptor', async () => {
    const runtime = await makeRuntime();
    const descriptor = {
      revision: 'phase2220-reactive-additive', provider: 'test', model: 'test', api: 'test',
      contextWindow: 1_000, profile: 'legacy-cl100k-v2',
    };
    const meter = {
      descriptor,
      capability: {
        kind: 'message_additive' as const,
        measureFixed: () => ({ kind: 'unavailable' as const, reason: 'reactive_additive_unavailable' }),
        measureMessage: () => ({
          kind: 'estimated' as const, tokens: 1, method: 'legacy-cl100k' as const, reason: 'test',
        }),
      },
      measure: vi.fn(() => ({
        kind: 'estimated' as const, tokens: 1_000,
        method: 'legacy-cl100k' as const, reason: 'complete-trigger-succeeded',
      })),
    };
    const prepare = vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
      kind: 'available', meter,
    });
    const archive = vi.spyOn((runtime as any).sessionManager, 'archive');
    const save = vi.spyOn((runtime as any).sessionManager, 'save');

    await expect(runtime.reactiveTrim(new LLMContextExceededError('test-provider', 400, 'too long')))
      .rejects.toMatchObject({
        name: 'ContextInputMeasurementError',
        reason: 'reactive_additive_unavailable',
        descriptor,
      });

    expect(prepare).toHaveBeenCalledWith({ kind: 'failure', error: expect.any(LLMContextExceededError) });
    expect(meter.measure).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('not_applicable dispatches the original aggregate failure without trim persistence or blocked state', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist');
    const aggregate = new LLMAllProvidersFailedError([
      { provider: 'primary', error: new LLMContextExceededError('primary', 400, 'primary too long') },
      { provider: 'fallback', error: new LLMContextExceededError('fallback', 400, 'fallback too long') },
    ]);
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => { throw aggregate; });
    const runtime = await makeRuntime();
    mockPrimaryTokens(runtime, 749);
    const archive = vi.spyOn((runtime as any).sessionManager, 'archive');
    const audit = vi.spyOn(runtime.getAuditWriter(), 'write');
    await writePendingMsg('m1');
    const capture = captureStreamEvents();
    const loop = createTestEventLoop({
      runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
    });
    (loop as any).contextTrimRetryCount = 2;
    (loop as any).contextTrimRetryDelayMs = 40;

    await loop.run();

    expect(trimSpy).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(capture.events.filter(e => String(e.type).startsWith('context_trim_'))).toEqual([]);
    expect((loop as any).contextTrimRetryCount).toBe(0);
    expect((loop as any).contextTrimRetryDelayMs).toBe(TEST_CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS);
    await expect(fs.readFile(
      path.join(testClawDir, 'status', 'llm-request-blocked-state.json'), 'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
    expect(audit).toHaveBeenCalledWith(
      'eventloop_iteration',
      'type=context_trim_not_applicable',
      'reason=primary_threshold_not_reached',
      'before=749',
      'primary_window=1000',
      'trigger_ratio=0.75',
      'trigger_tokens=750',
    );
    expect(audit).toHaveBeenCalledWith(
      'eventloop_fatal',
      'reason=non_llm_error',
      `recovery_delay_ms=${TEST_UNKNOWN_ERROR_RECOVERY_DELAY_MS}`,
      expect.stringContaining(aggregate.message),
    );
  });

  it('non-context-exceeded errors NOT triggering retry', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'no_progress',
      before: 1000,
      after: 1000,
      reason: 'already_within_target',
      newMessages: [],
      archived: false,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      throw new Error('Some other error');
    });

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const capture = captureStreamEvents();
    const loop = createTestEventLoop({
      runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
    });

    // 非 context-exceeded 错不进 retry path；Phase 1956 Step C/E：未知系统错误
    // 不再 FATAL + 延迟重跑——EventLoop 消费 recovery_required，nack + blocked 阻断。
    const auditWrites: string[][] = [];
    vi.spyOn((runtime as any).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
      auditWrites.push([type, ...args]);
    });

    await loop.run();

    // 仅一次 runReact、trim 未触发
    expect(runReactCalls).toBe(1);
    expect(trimSpy).not.toHaveBeenCalled();
    expect(auditWrites.some(a => a[0] === 'eventloop_iteration' && a.some(c => c === 'type=turn_recovery_required'))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'eventloop_context_blocked' && a.some(c => c === 'reason=recovery_required'))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => String(c).includes('Some other error')))).toBe(false);
    // Phase 1978: 非 context 路径不得发 trim 事件
    expect(capture.events.filter(e => String(e.type).startsWith('context_trim_'))).toHaveLength(0);
  });

  it('trim no_progress → context_trim_blocked（reason=no_progress），无 retry 事件', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'no_progress',
      before: 1000,
      after: 1000,
      reason: 'already_within_target',
      newMessages: [],
      archived: false,
    } as any);

    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      throw new LLMContextExceededError('test-provider', 400, 'prompt is too long');
    });

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const capture = captureStreamEvents();
    const loop = createTestEventLoop({
      runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
    });

    await loop.run();

    const retryEvents = capture.events.filter(e => e.type === 'context_trim_retry_scheduled');
    const blockedEvents = capture.events.filter(e => e.type === 'context_trim_blocked');
    expect(retryEvents).toHaveLength(0);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      type: 'context_trim_blocked',
      reason: 'no_progress',
      before: 1000,
      after: 1000,
      attempts: 0,
      maxAttempts: 3,
    });
  });

  it('aggregate with context sub-error still triggers trim+retry', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 1000,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      if (runReactCalls === 1) {
        // Phase 1960：typed 子错误经 failures 结构化递归识别（不依赖聚合 message 文本）
        throw new LLMAllProvidersFailedError([
          { provider: 'p1', error: new LLMContextExceededError('p1', 400, 'prompt is too long') },
          { provider: 'p2', error: new LLMNetworkError('p2', new Error('ECONNRESET')) },
        ]);
      }
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' });

    await loop.run();
    await loop.run();

    expect(runReactCalls).toBe(2);
    expect(trimSpy).toHaveBeenCalledTimes(1);
  });

  it('plain Error with provider context text no longer triggers trim（typed 边界）', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      status: 'target_reached',
      before: 1000,
      after: 100,
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      throw new Error('Anthropic SDK error: prompt is too long: 250000 > 200000');
    });

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' });

    await loop.run();

    expect(runReactCalls).toBe(1);
    expect(trimSpy).not.toHaveBeenCalled();
  });
});


describe('Phase 2149 reactive persisted-candidate gate', () => {
  it('does not schedule retry for a target_reached candidate that was not archived', async () => {
    const testTempDir = await createTempDir('chestnut-phase2149-reactive-');
    const testClawDir = path.join(testTempDir, 'claws', 'test-claw');
    await fs.mkdir(testClawDir, { recursive: true });
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw', clawDir: testClawDir, llmConfig: createMockLLMConfig(),
      dependencies: deps, idleTimeoutMs: 0, contextTrimmingEnabled: true,
    });
    try {
      await runtime.initialize();
      vi.spyOn((runtime as any).llm, 'prepareInputBudget').mockResolvedValue({
        kind: 'available',
        meter: {
          descriptor: {
            revision: 'phase2209-persisted-gate', provider: 'test', model: 'test', api: 'test',
            contextWindow: 1_000, profile: 'legacy-cl100k-v2',
          },
          capability: { kind: 'unknown' as const },
          measure: () => ({
            kind: 'estimated' as const, tokens: 1_000,
            method: 'deepseek-v41-text' as const, reason: 'test',
          }),
        },
      });
      vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
      vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
        status: 'target_reached', before: 1_000, after: 100,
        newMessages: [{ role: 'user', content: 'unpersisted candidate' } as Message], archived: false,
      });
      vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
        throw new LLMContextExceededError('test-provider', 400, 'prompt is too long');
      });
      const content = `---\nid: m1\ntype: message\nfrom: sender\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nhi\n`;
      await fs.writeFile(path.join(testClawDir, 'inbox', 'pending', 'm1.md'), content);
      const capture = captureStreamEvents();
      const loop = createTestEventLoop({
        runtime, clawDir: testClawDir, clawId: 'test-claw', streamWriter: capture.streamWriter,
      });

      await loop.run();

      expect(capture.events.filter(event => event.type === 'context_trim_retry_scheduled')).toEqual([]);
    } finally {
      await runtime.stop().catch(() => { /* silent: cleanup */ });
      await cleanupTempDir(testTempDir);
    }
  });
});
