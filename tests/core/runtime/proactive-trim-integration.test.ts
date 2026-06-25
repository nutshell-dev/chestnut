import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import * as maybeTrimModule from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';

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

class ProactiveTrimTestRuntime extends Runtime {
  public drainResult = makeDrainResult([]);
  public runReactMessages?: Message[];
  /** 为测试 4 开启：调用真实 _runReact 以触发 onLLMResult callback */
  public callSuperRunReact = false;

  protected override async _drainOwnInbox() {
    return this.drainResult;
  }

  protected override async _runReact(messages: Message[], callbacks?: any) {
    this.runReactMessages = messages;
    if (this.callSuperRunReact) {
      return super._runReact(messages, callbacks);
    }
    // 默认：不调用真实 runReact，避免测试需要完整 LLM 装配
  }
}

describe('runtime proactive trim integration', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
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

  async function makeRuntime(contextManagerConfig?: { filterSubtypes: ReadonlySet<string> }) {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
    const runtime = new ProactiveTrimTestRuntime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
      ...(contextManagerConfig ? { contextManagerConfig } : {}),
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime as ProactiveTrimTestRuntime;
  }

  it('1. first turn calls maybeTrimProactive with lastLLMCallAt = 0', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    const msg = { role: 'user', content: 'hi' } as Message;
    runtime.drainResult = makeDrainResult([msg]);

    await runtime.processBatch();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ lastLLMCallAt: 0 }));
    expect(runtime.runReactMessages).toEqual([msg]);
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
    runtime.drainResult = makeDrainResult([original]);

    await runtime.processBatch();

    expect(runtime.runReactMessages).toEqual([trimmed]);
  });

  it('3. processWithMessage calls maybeTrimProactive and replaces messages', async () => {
    const original = { role: 'user', content: 'original' } as Message;
    const trimmed = { role: 'assistant', content: 'trimmed' } as Message;
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue({
      newMessages: [trimmed],
      archived: true,
      estimatedTokensAfter: 5,
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });

    await runtime.processWithMessage(original);

    expect(runtime.runReactMessages).toEqual([trimmed]);
  });

  it('4. _runReact onLLMResult callback updates lastLLMCallAt', async () => {
    vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runReactSpy = vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      options.onLLMResult?.({ model: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 });
      return { finalText: '', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    runtime.callSuperRunReact = true;
    expect((runtime as any).lastLLMCallAt).toBe(0);

    await runtime.processWithMessage({ role: 'user', content: 'hi' } as Message);

    expect(runReactSpy).toHaveBeenCalled();
    expect((runtime as any).lastLLMCallAt).toBeGreaterThan(0);
  });

  it('5. retryLastTurn does not call maybeTrimProactive', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime({ filterSubtypes: new Set() });
    await (runtime as any).sessionManager.save({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'retry me' } as Message],
      toolsForLLM: [],
    });

    await runtime.retryLastTurn();

    expect(spy).not.toHaveBeenCalled();
  });

  it('6. does not call maybeTrimProactive when contextManagerConfig is absent', async () => {
    const spy = vi.spyOn(maybeTrimModule, 'maybeTrimProactive').mockResolvedValue(null);
    const runtime = await makeRuntime();
    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);

    await runtime.processBatch();

    expect(spy).not.toHaveBeenCalled();
  });
});
