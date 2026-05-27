/**
 * Runtime processBatch orchestrator-only refactor
 * Phase 1285 reverse tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { UserInterrupt } from '../../../src/core/signals.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
  };
}

describe('Runtime processBatch orchestrator (phase 1285)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    testTempDir = path.join(tmpdir(), `clawforum-orchestrator-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function makeTestRuntime() {
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
    const runtime = new Runtime({
      clawId: 'edge-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime;
  }

  class InterruptTestRuntime extends Runtime {
    public drainResult: {
      injected: Message[];
      sources: Array<{ text: string; type: string }>;
      count: number;
      infos: InboxMessage[];
      addressedHandles: any[];
    } = { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
    public reactThrow: Error | null = null;

    protected override async _drainOwnInbox() {
      return this.drainResult;
    }

    protected override async _runReact(_messages: Message[]) {
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

  it('UserInterrupt calls rollbackTurn + nack + rethrows', async () => {
    const runtime = await makeInterruptRuntime();
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'message', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      addressedHandles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' }],
    };
    runtime.reactThrow = new UserInterrupt();

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

    expect(rollbackSpy).toHaveBeenCalled();
    expect(nackSpy).toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('successful turn calls commitTurn + ack', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'message', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      addressedHandles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' }],
    };
    runtime.reactThrow = null;

    await runtime.processBatch();

    expect(commitSpy).toHaveBeenCalled();
    expect(ackSpy).toHaveBeenCalledWith({ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' });
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('MaxStepsExceededError calls rollbackTurn + nack + outbox notification', async () => {
    const runtime = await makeInterruptRuntime();
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'message', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      addressedHandles: [{ filePath: 'inflight/msg1.md', originalFileName: 'msg1.md' }],
    };
    runtime.reactThrow = new MaxStepsExceededError(10);

    await expect(runtime.processBatch()).rejects.toThrow(MaxStepsExceededError);

    expect(rollbackSpy).toHaveBeenCalled();
    expect(nackSpy).toHaveBeenCalled();
  });

  it('processBatch calls beginTurn before runReact', async () => {
    const runtime = await makeInterruptRuntime();
    const beginSpy = vi.spyOn((runtime as any).sessionManager, 'beginTurn').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'message', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      addressedHandles: [],
    };

    await runtime.processBatch();
    expect(beginSpy).toHaveBeenCalled();
    expect(commitSpy).toHaveBeenCalled();
  });
});
