/**
 * Phase 1411 (reframe of phase 1409) — summon DISPATCHED audit emit reverse.
 *
 * Verifies:
 * - SUCCESS shadow mode → emits `summon_dispatched` with typed cols (mode/target_claw/verify/task_id/tool_use_id)
 * - SUCCESS mining mode → emits `summon_dispatched` mode=mining
 * - targetClaw absent → no `target_claw=` col
 * - NO `goal_preview` col in emit args (reframe: goal body 0 入 audit / dialog 全文权威)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/audit-events.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `summon-dispatched-audit-${randomUUID()}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('Phase 1411 — summon_dispatched audit emit', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let tool: SummonTool;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    tool = new SummonTool({ write: vi.fn().mockResolvedValue(undefined), read: vi.fn().mockResolvedValue(undefined) });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(snapshotMessages: Message[] = [], toolUseId = 'toolu_test_abc'): any {
    const auditWriter = { write: auditWrite } as any;
    return new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      currentToolUseId: toolUseId,
      taskSystem: createMockTaskSystem(mockFs, auditWriter),
      getCallerSnapshot: async () => ({
        systemPrompt: 'mock system prompt',
        tools: [],
        messages: snapshotMessages,
      }),
    } as any);
  }

  it('reverse 1 — shadow mode dispatch emits summon_dispatched with typed cols', async () => {
    const ctx = makeCtx([{ role: 'user', content: 'test' }]);
    const result = await tool.execute(
      { goal: 'test goal text', targetClaw: 'my-claw', verify: false },
      ctx,
    );

    expect(result.success).toBe(true);

    const dispatchedCalls = auditWrite.mock.calls.filter(
      (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
    );
    expect(dispatchedCalls).toHaveLength(1);

    const cols = dispatchedCalls[0].slice(1);
    expect(cols).toContain('tool_use_id=toolu_test_abc');
    expect(cols).toContain('mode=shadow');
    expect(cols).toContain('target_claw=my-claw');
    expect(cols).toContain('verify=false');
    expect(cols.some((c: string) => c.startsWith('task_id='))).toBe(true);

    // reframe (phase 1411): goal body 0 入 audit
    expect(cols.some((c: string) => c.startsWith('goal_preview='))).toBe(false);
    expect(cols.some((c: string) => c.includes('test goal text'))).toBe(false);
  });

  it('reverse 2 — mining mode dispatch emits summon_dispatched mode=mining', async () => {
    const ctx = makeCtx();
    const result = await tool.execute(
      { goal: 'mining goal', mode: 'mining', verify: true },
      ctx,
    );

    expect(result.success).toBe(true);

    const dispatchedCalls = auditWrite.mock.calls.filter(
      (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
    );
    expect(dispatchedCalls).toHaveLength(1);

    const cols = dispatchedCalls[0].slice(1);
    expect(cols).toContain('mode=mining');
    expect(cols).toContain('verify=true');
  });

  it('reverse 3 — targetClaw absent → no target_claw= col', async () => {
    const ctx = makeCtx([{ role: 'user', content: 'test' }]);
    const result = await tool.execute({ goal: 'test', verify: false }, ctx);

    expect(result.success).toBe(true);

    const dispatchedCalls = auditWrite.mock.calls.filter(
      (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
    );
    expect(dispatchedCalls).toHaveLength(1);

    const cols = dispatchedCalls[0].slice(1);
    expect(cols.some((c: string) => c.startsWith('target_claw='))).toBe(false);
  });
});
