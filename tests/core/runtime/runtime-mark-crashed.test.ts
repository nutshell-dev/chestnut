/**
 * Phase 63 Step G: Runtime catch → markCrashed integration tests
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
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
  };
}

class CrashTestRuntime extends Runtime {
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

describe('Runtime catch → markCrashed (phase 63)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    testTempDir = path.join(tmpdir(), `chestnut-mark-crashed-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
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

  const errClasses = [
    { Cls: MaxStepsExceededError, args: [10] },
    { Cls: WallTimeExceededError, args: [1000, 2000] },
    { Cls: ConsecutiveParseErrorsExceededError, args: [3] },
    { Cls: ConsecutiveMaxTokensToolUseError, args: [5] },
    { Cls: LLMAllProvidersFailedError, args: [[{ provider: 'test', error: new Error('fail') }]] },
  ];

  for (const { Cls, args } of errClasses) {
    it(`${Cls.name} with contract_id → markCrashed call`, async () => {
      const runtime = await makeCrashRuntime();
      const markSpy = vi.spyOn((runtime as any).contractManager, 'markCrashed').mockResolvedValue(undefined);

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1', type: 'task_result', from: 'sender', to: 'edge-claw',
          content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
          metadata: { contract_id: 'test-contract' },
        } as InboxMessage],
        addressedHandles: [],
      };
      runtime.reactThrow = new (Cls as any)(...args);

      await expect(runtime.processBatch()).rejects.toBeInstanceOf(Cls);

      expect(markSpy).toHaveBeenCalledWith('test-contract', `system: ${Cls.name.toLowerCase()}`);
      markSpy.mockRestore();
    });
  }

  it('contract_id 缺失 → fallback writeErrorResponse, markCrashed NOT called', async () => {
    const runtime = await makeCrashRuntime();
    const markSpy = vi.spyOn((runtime as any).contractManager, 'markCrashed').mockResolvedValue(undefined);
    const outboxSpy = vi.spyOn((runtime as any).outboxWriter, 'write').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'task_result', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage],
      addressedHandles: [],
    };
    runtime.reactThrow = new MaxStepsExceededError(10);

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(MaxStepsExceededError);

    expect(markSpy).not.toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
    markSpy.mockRestore();
    outboxSpy.mockRestore();
  });

  it('markCrashed throw → fallback writeErrorResponse + MARK_CRASHED_FAILED audit', async () => {
    const runtime = await makeCrashRuntime();
    const markSpy = vi.spyOn((runtime as any).contractManager, 'markCrashed').mockRejectedValue(new Error('already archived'));
    const outboxSpy = vi.spyOn((runtime as any).outboxWriter, 'write').mockResolvedValue(undefined);
    const auditWrites: string[][] = [];
    vi.spyOn((runtime as any).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
      auditWrites.push([type, ...args]);
    });

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sources: [],
      count: 1,
      infos: [{
        id: 'msg1', type: 'task_result', from: 'sender', to: 'edge-claw',
        content: 'hi', priority: 'normal', timestamp: new Date().toISOString(),
        metadata: { contract_id: 'test-contract' },
      } as InboxMessage],
      addressedHandles: [],
    };
    runtime.reactThrow = new MaxStepsExceededError(10);

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(MaxStepsExceededError);

    expect(markSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
    expect(auditWrites.some(a => a[0] === 'mark_crashed_failed')).toBe(true);
    markSpy.mockRestore();
    outboxSpy.mockRestore();
  });
});
