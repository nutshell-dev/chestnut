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
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';
import * as trimAndPersistModule from '../../../src/core/context_manager/trim-and-persist.js';
import * as maybeTrimModule from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';

// Step H: EventLoop 的 trim 重试退避（30s 起）与 dispatchError fallback 退避
// 是生产值；测试用小值锁状态机（对齐 tests/core/event-loop/event-loop.test.ts）。
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

  async function makeRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
      contextTrimmingEnabled: true,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime;
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

    const runtime = await makeRuntime();
    await writePendingMsg('m1');
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' });

    // 第 1 轮：turn 失败 → reactiveTrim → 有界重试安排（消息 nack 回 pending）；
    // 第 2 轮：重新 drain 同消息 → turn 成功 → ack。
    await loop.run();
    await loop.run();

    expect(runReactCalls).toBe(2);
    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      triggerKind: 'reactive_overflow',
    }));
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
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' });

    // 3 次重试预算：每轮 fail → trim → 安排下一轮；第 4 次 fail 时预算耗尽
    // → 进入 blocked gate（persist 到 status/llm-request-blocked-state.json）。
    await loop.run();
    await loop.run();
    await loop.run();
    expect(runReactCalls).toBe(3);
    expect(trimSpy).toHaveBeenCalledTimes(3);

    await loop.run();
    expect(runReactCalls).toBe(4);
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
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'test-claw' });

    // 非 context-exceeded 错不进 retry path；现行 EventLoop 不冒泡，
    // 经 dispatchError 落 eventloop_fatal 审计（error= 列含原 message）。
    const auditWrites: string[][] = [];
    vi.spyOn((runtime as any).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
      auditWrites.push([type, ...args]);
    });

    await loop.run();

    // 仅一次 runReact、trim 未触发
    expect(runReactCalls).toBe(1);
    expect(trimSpy).not.toHaveBeenCalled();
    expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => String(c).includes('Some other error')))).toBe(true);
  });

  it('SDK-path context-exceeded by message regex still triggers retry', async () => {
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
        // 非 LLMContextExceededError、但 message 含 regex 模式
        throw new Error('Anthropic SDK error: prompt is too long: 250000 > 200000');
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
});
