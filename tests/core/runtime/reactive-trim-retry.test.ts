/**
 * phase 690 Step B: Runtime 反应式 trim+retry 集成测试。
 *
 * 验：LLM 抛 LLMContextExceededError → Runtime trim → 同 turn 重试 → 成功 final。
 * 验：retry 超 N 次 → 上抛 / audit REACTIVE_TRIM_EXHAUSTED。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';
import * as trimAndPersistModule from '../../../src/core/context_manager/trim-and-persist.js';
import * as maybeTrimModule from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';
import { runLegacyBatch } from '../../helpers/legacy-process-batch.js';

function createMockLLMConfig() {
  return {
    provider: 'anthropic' as const,
    model: 'claude-3-opus-20240229',
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
  };
}

function makeDrainResult(injected: Message[]) {
  return {
    injected,
    sources: injected.map(m => ({
      text: typeof m.content === 'string' ? m.content : '[content]',
      type: 'user_chat',
    })),
    count: injected.length,
    infos: [] as InboxMessage[],
    addressedHandles: [] as any[],
  };
}

class ReactiveTrimTestRuntime extends Runtime {
  public drainResult = makeDrainResult([]);

  protected override async _drainOwnInbox() {
    return this.drainResult;
  }
}

describe('runtime reactive trim+retry path', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
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
    const runtime = new ReactiveTrimTestRuntime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
      contextManagerConfig: { filterSubtypes: new Set() },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime as ReactiveTrimTestRuntime;
  }

  it('catches LLMContextExceededError → trim → retry succeeds', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
      estimatedTokensAfter: 100,
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
    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);

    await runLegacyBatch(runtime);

    expect(runReactCalls).toBe(2);
    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(trimSpy).toHaveBeenCalledWith(expect.objectContaining({
      triggerKind: 'reactive_overflow',
    }));
  });

  it('throws after MAX_REACTIVE_TRIM_RETRIES exhausted', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
      estimatedTokensAfter: 100,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      throw new LLMContextExceededError('test-provider', 400, 'prompt is too long');
    });

    const runtime = await makeRuntime();
    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);

    // MAX_REACTIVE_TRIM_RETRIES = 2、总共 3 次 runReact（1 原始 + 2 retry）
    // 第 3 次仍抛、超 retry 上限、err 冒泡到 processBatch 的 turn-level catch、
    // 走 rollback 后再 throw 出 processBatch。
    await expect(runLegacyBatch(runtime)).rejects.toBeInstanceOf(LLMContextExceededError);

    expect(runReactCalls).toBe(3);
  });

  it('non-context-exceeded errors NOT triggering retry', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      newMessages: [],
      archived: false,
      estimatedTokensAfter: 0,
    } as any);

    let runReactCalls = 0;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async () => {
      runReactCalls++;
      throw new Error('Some other error');
    });

    const runtime = await makeRuntime();
    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);

    // 非 context-exceeded 错冒泡、不进 retry path
    await expect(runLegacyBatch(runtime)).rejects.toThrow('Some other error');

    // 仅一次 runReact、trim 未触发
    expect(runReactCalls).toBe(1);
    expect(trimSpy).not.toHaveBeenCalled();
  });

  it('SDK-path context-exceeded by message regex still triggers retry', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const trimSpy = vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockResolvedValue({
      newMessages: [{ role: 'user', content: 'trimmed' } as Message],
      archived: true,
      estimatedTokensAfter: 100,
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
    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);

    await runLegacyBatch(runtime);

    expect(runReactCalls).toBe(2);
    expect(trimSpy).toHaveBeenCalledTimes(1);
  });
});
