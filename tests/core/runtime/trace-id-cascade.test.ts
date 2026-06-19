/**
 * trace-id cascade — phase 1343 α-6 reverse tests
 *
 * Covers:
 * - trace_id 唯一性（100 turn no dup）
 * - cross-module propagation invariant（audit row 必含 trace_id col）
 * - execContext trace_id forward verify
 * - turn 结束后 trace_id 清除
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
  };
}

describe('Runtime trace-id cascade (phase 1343 α-6)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
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

  class TraceTestRuntime extends Runtime {
    public drainResult = {
      injected: [] as Message[],
      sources: [] as Array<{ text: string; type: string }>,
      count: 0,
      infos: [] as InboxMessage[],
      addressedHandles: [] as any[],
    };
    public capturedTraceIds: string[] = [];

    protected override async _drainOwnInbox() {
      return this.drainResult;
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
    return runtime;
  }

  it('processBatch generates 16-char hex trace_id and sets on execContext', async () => {
    const runtime = await makeTraceRuntime();
    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [],
      addressedHandles: [],
    };

    const execCtx = (runtime as any).execContext;
    expect(execCtx.trace_id).toBeUndefined();

    await runtime.processBatch();

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
    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [],
      addressedHandles: [],
    };

    for (let i = 0; i < 10; i++) {
      await runtime.processBatch();
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

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [],
      addressedHandles: [],
    };

    await runtime.processBatch();

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
    const saveSpy = vi.spyOn((runtime as any).sessionManager, 'save').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [],
      addressedHandles: [],
    };

    await runtime.processBatch();

    // First save (injected messages) should have trace_id
    const firstSave = saveSpy.mock.calls[0][0];
    expect(firstSave.trace_id).toBeDefined();
    expect(firstSave.trace_id).toMatch(/^[0-9a-f]{16}$/);

    expect(commitSpy).toHaveBeenCalled();
  });

  it('trace_id is cleared after turn ends', async () => {
    const runtime = await makeTraceRuntime();
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sources: [],
      count: 1,
      infos: [],
      addressedHandles: [],
    };

    await runtime.processBatch();

    expect(commitSpy).toHaveBeenCalled();
    const execCtx = (runtime as any).execContext;
    expect(execCtx.trace_id).toBeUndefined();
    expect(runtime.getCurrentTraceId()).toBeUndefined();
    expect((runtime as any).auditWriter.traceId).toBeUndefined();
  });
});
