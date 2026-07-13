/**
 * Phase 1411 (reframe of phase 1409) / phase 807 DI — summon REJECTED_SHADOW audit emit reverse.
 *
 * Verifies:
 * - SummonTool with allowFromShadow=false → emits `summon_rejected_shadow` + returns success:false
 * - SummonTool with allowFromShadow=true → no REJECTED_SHADOW emit
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
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const d = path.join(tmpdir(), `summon-rejected-shadow-${randomUUID()}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('Phase 1411 — summon_rejected_shadow audit emit', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx(opts: { allowFromShadow: boolean; toolUseId?: string }): any {
    const auditWriter = { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      currentToolUseId: opts.toolUseId ?? 'toolu_reject_test',
      getCallerSnapshot: async () => ({
        systemPrompt: 'p',
        tools: [],
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    const taskSystem = createMockTaskSystem(mockFs, auditWriter);
    const tool = new SummonTool(taskSystem, undefined, undefined, opts.allowFromShadow);
    return { ctx, tool };
  }

  it('reverse 1 — allowFromShadow=false emits REJECTED_SHADOW + returns success:false', async () => {
    const { ctx, tool } = makeCtx({ allowFromShadow: false });
    const result = await tool.execute({ goal: 'test' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('shadow_summon_rejected');

    const rejectedCalls = auditWrite.mock.calls.filter(
      (c) => c[0] === SUMMON_AUDIT_EVENTS.REJECTED_SHADOW,
    );
    expect(rejectedCalls).toHaveLength(1);

    const cols = rejectedCalls[0].slice(1);
    expect(cols).toContain('tool_use_id=toolu_reject_test');
    expect(cols).toContain('reason=shadow_call_orphan_async_routing');
  });

  it('reverse 2 — allowFromShadow=true → no REJECTED_SHADOW emit', async () => {
    const { ctx, tool } = makeCtx({ allowFromShadow: true });
    const result = await tool.execute({ goal: 'test' }, ctx);

    expect(result.success).toBe(true);

    const rejectedCalls = auditWrite.mock.calls.filter(
      (c) => c[0] === SUMMON_AUDIT_EVENTS.REJECTED_SHADOW,
    );
    expect(rejectedCalls).toHaveLength(0);
  });
});
