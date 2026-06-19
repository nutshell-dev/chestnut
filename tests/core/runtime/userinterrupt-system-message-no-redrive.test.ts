/**
 * phase 1415 invariant: UserInterrupt → inbox 文件一律 ack（不退回 pending）。
 *
 * Reframe phase 1403 — 不再按 isUserTypedInbox 分流。
 * 守不再退化为 phase 1403 死循环（系统通知反复注入 dialog）。
 *
 * 覆盖：
 *   - type=message（contract-new 等通用系统通知）
 *   - type=crash_notification（watchdog 投递）
 *   - type=heartbeat（heartbeat 投递）
 *   - 混合批（user_chat + 系统）— 全 ack、0 nack
 *   - 反向：保 UserInterrupt 路径不再产生 nack（捕回归）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
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

describe('phase 1415: UserInterrupt → system-typed inbox no-redrive invariant', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    testTempDir = path.join(tmpdir(), `chestnut-1415-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

  function makeInfo(type: InboxMessage['type'], id: string, from = 'system'): InboxMessage {
    return {
      id, type, from, to: 'edge-claw',
      content: `body for ${id}`, priority: 'high',
      timestamp: new Date().toISOString(),
    } as InboxMessage;
  }

  const systemTypedCases: Array<{ type: InboxMessage['type']; from: string; desc: string }> = [
    { type: 'message', from: 'system', desc: 'contract-new (CLI-injected via notifyContractCreated)' },
    { type: 'crash_notification', from: 'watchdog', desc: 'watchdog crash notification' },
    { type: 'heartbeat', from: 'heartbeat', desc: 'heartbeat tick' },
  ];

  for (const c of systemTypedCases) {
    it(`UserInterrupt + system-typed (type=${c.type}, from=${c.from}, ${c.desc}): ack (no nack, no redrive)`, async () => {
      const runtime = await makeInterruptRuntime();
      const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
      const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
      const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: c.desc }] }],
        sources: [],
        count: 1,
        infos: [makeInfo(c.type, 'msg-x', c.from)],
        addressedHandles: [{ filePath: 'inflight/msg-x.md', originalFileName: 'msg-x.md' }],
      };
      runtime.reactThrow = new UserInterrupt();

      await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

      expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
      expect(ackSpy).toHaveBeenCalledTimes(1);
      expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'inflight/msg-x.md' }));
      expect(nackSpy).not.toHaveBeenCalled();
    });
  }

  it('UserInterrupt + mixed batch (3 messages: user_chat + message + crash_notification): all ack, 0 nack', async () => {
    const runtime = await makeInterruptRuntime();
    const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'contract done' }] },
        { role: 'user', content: [{ type: 'text', text: 'crash detected' }] },
      ],
      sources: [],
      count: 3,
      infos: [
        makeInfo('user_chat', 'u1', 'user'),
        makeInfo('message', 'm2', 'auditor'),
        makeInfo('crash_notification', 'c3', 'watchdog'),
      ],
      addressedHandles: [
        { filePath: 'inflight/u1.md', originalFileName: 'u1.md' },
        { filePath: 'inflight/m2.md', originalFileName: 'm2.md' },
        { filePath: 'inflight/c3.md', originalFileName: 'c3.md' },
      ],
    };
    runtime.reactThrow = new UserInterrupt();

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

    expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
    expect(ackSpy).toHaveBeenCalledTimes(3);
    expect(nackSpy).not.toHaveBeenCalled();
  });

  it('UserInterrupt path 0 nack invariant: nack call count must be 0（守 phase 1415 不退化）', async () => {
    const runtime = await makeInterruptRuntime();
    const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
    vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
    vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

    runtime.drainResult = {
      injected: [{ role: 'user', content: [{ type: 'text', text: 'sys' }] }],
      sources: [],
      count: 1,
      infos: [makeInfo('message', 'm1', 'system')],
      addressedHandles: [{ filePath: 'inflight/m1.md', originalFileName: 'm1.md' }],
    };
    runtime.reactThrow = new UserInterrupt();

    await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

    // 反向守：若 UserInterrupt 分支被回退到 phase 1403 形态、nack 会被调用 → 本测 fail
    expect(nackSpy).toHaveBeenCalledTimes(0);
  });
});
