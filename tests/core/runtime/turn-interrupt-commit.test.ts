/**
 * Turn interrupt graceful → commit reclassify
 * Phase 1375 reverse tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { UserInterrupt, IdleTimeoutSignal } from '../../../src/core/signals.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
  };
}

describe('turn interrupt: graceful → commit (phase 1375)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    testTempDir = path.join(tmpdir(), `clawforum-turn-interrupt-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
  });

  class InterruptTestRuntime extends Runtime {
    public drainResult: {
      injected: Message[];
      sources: Array<{ text: string; type: string }>;
      count: number;
      infos: InboxMessage[];
      addressedHandles: any[];
    } = { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
    public reactThrow: Error | null = null;
    public midTurnSaves = 0;

    protected override async _drainOwnInbox() {
      return this.drainResult;
    }

    protected override async _runReact(_messages: Message[]) {
      const sessionManager = (this as any).sessionManager;
      // Simulate mid-turn saves (mirrors onStepComplete incremental save)
      for (let i = 0; i < this.midTurnSaves; i++) {
        await sessionManager.save({
          systemPrompt: 'sp',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: `step-${i}` },
          ],
          toolsForLLM: [],
        });
      }
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

  it('UserInterrupt mid-turn: dialog retains partial messages + TURN_COMMIT reason=user_interrupt + ack (phase 1391)', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const origCommit = (runtime as any).sessionManager.commitTurn;
    const commitCallSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockImplementation(async (reason?: string) => {
      return origCommit.call((runtime as any).sessionManager, reason);
    });

    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

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
    runtime.midTurnSaves = 3;
    runtime.reactThrow = new UserInterrupt();

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

    expect(commitCallSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalled();
    expect(nackSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();

    // Verify dialog retained partial messages (mid-turn saves preserved)
    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toBe('step-2');

    // Verify audit TURN_COMMIT with reason
    const turnCommitCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT,
    );
    expect(turnCommitCalls.length).toBeGreaterThanOrEqual(1);
    const lastTurnCommit = turnCommitCalls[turnCommitCalls.length - 1];
    expect(lastTurnCommit.some((c: any) => String(c).includes('reason=user_interrupt'))).toBe(true);
  });

  it('IdleTimeoutSignal mid-turn: dialog retains + TURN_COMMIT reason=idle_timeout', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const rollbackSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockResolvedValue(undefined);
    const origCommit = (runtime as any).sessionManager.commitTurn;
    const commitCallSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockImplementation(async (reason?: string) => {
      return origCommit.call((runtime as any).sessionManager, reason);
    });
    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

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
    runtime.midTurnSaves = 2;
    runtime.reactThrow = new IdleTimeoutSignal(30000);

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(IdleTimeoutSignal);

    expect(commitCallSpy).toHaveBeenCalledWith('idle_timeout');
    expect(nackSpy).toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();

    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toBe('step-1');

    const turnCommitCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT,
    );
    expect(turnCommitCalls.length).toBeGreaterThanOrEqual(1);
    const lastTurnCommit = turnCommitCalls[turnCommitCalls.length - 1];
    expect(lastTurnCommit.some((c: any) => String(c).includes('reason=idle_timeout'))).toBe(true);
  });

  it('真错误（throw Error）: dialog rollback to begin snapshot + TURN_ROLLBACK', async () => {
    const runtime = await makeInterruptRuntime();
    // Pre-seed dialog so beginTurn snapshot is non-empty
    const sessionManager = (runtime as any).sessionManager;
    await sessionManager.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'pre-seed' }],
      toolsForLLM: [],
    });

    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);
    const origRollback = (runtime as any).sessionManager.rollbackTurn;
    const rollbackCallSpy = vi.spyOn((runtime as any).sessionManager, 'rollbackTurn').mockImplementation(async (reason?: string) => {
      return origRollback.call((runtime as any).sessionManager, reason);
    });
    const auditSpy = vi.spyOn((runtime as any).auditWriter, 'write');

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
    runtime.midTurnSaves = 2;
    runtime.reactThrow = new Error('tool crash');

    await expect(runtime.processBatch()).rejects.toThrow('tool crash');

    expect(rollbackCallSpy).toHaveBeenCalled();
    expect(nackSpy).toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();

    // Verify dialog rolled back to pre-turn state (pre-seed message only, mid-turn saves gone)
    const { session } = await sessionManager.load();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('pre-seed');

    // Verify audit TURN_ROLLBACK
    const rollbackCalls = auditSpy.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.TURN_ROLLBACK,
    );
    expect(rollbackCalls.length).toBe(1);
  });

  it('invariant: rollbackTurn ≤ 1 call site in runtime.ts (真错误 else 分支)', async () => {
    const runtimePath = path.join(__dirname, '../../../src/core/runtime/runtime.ts');
    const src = await fs.readFile(runtimePath, 'utf8');
    const matches = src.match(/rollbackTurn/g);
    // 1 reference in import/type + 1 actual call site in else branch
    expect(matches?.length ?? 0).toBeLessThanOrEqual(2);
  });
});
