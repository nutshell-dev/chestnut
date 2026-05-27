/**
 * Phase 1174 ExecContext 7-site dual-write eviction — reverse 3 项
 *
 * Coverage:
 * - reverse 1: summon throws when getCurrentMessages not injected
 * - reverse 2: ExecContext type does not have dual-write fields
 * - reverse 3: shadow getTurnSnapshot does not read ctx fields
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecContext } from '../../../src/foundation/tools/types.js';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { createShadowTool } from '../../../src/core/shadow-system/tools/shadow.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

describe('phase 1174 ExecContext 7-site dual-write eviction', () => {
  // reverse 1: summon defaults to [] when getCurrentMessages absent (shadow mode)
  it('summon defaults to empty messages when getCurrentMessages not injected', async () => {
    const tempDir = path.join(tmpdir(), `ec-ndw-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    const tool = new SummonTool(
      async () => 'mock system prompt',
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      // getCurrentMessages absent → undefined
    );
    const auditWriter = { write: vi.fn() };
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: mockFs,
      auditWriter: auditWriter as any,
      taskSystem: { schedule: vi.fn().mockResolvedValue('task-xxx') } as any,
    });

    const result = await tool.execute({ goal: 'test goal', mode: 'shadow' }, ctx);

    // shadow mode: empty messages → shadowMessages = [SHADOW INSTRUCTION], should succeed
    expect(result.success).toBe(true);
    // 空 messages 应触发 audit NO_DIALOG_CONTEXT
    expect(auditWriter.write).toHaveBeenCalledWith('summon_no_dialog_context');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // reverse 2: schema 反向 — type-level assert ExecContext 不含 dual-write fields
  it('ExecContext type does not have systemPromptForLLM / toolsForLLM / dialogMessages', () => {
    type AssertNoField<T, K> = K extends keyof T ? never : true;
    const _assert1: AssertNoField<ExecContext, 'systemPromptForLLM'> = true;
    const _assert2: AssertNoField<ExecContext, 'toolsForLLM'> = true;
    const _assert3: AssertNoField<ExecContext, 'dialogMessages'> = true;

    // compile-time only — runtime no-op
    expect(_assert1 && _assert2 && _assert3).toBe(true);
  });

  // reverse 3: boundary path — getTurnSnapshot factory does not read ctx fields
  it('shadow getTurnSnapshot returns values from factory injection, not ctx fields', async () => {
    const tempDir = path.join(tmpdir(), `ec-ndw-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    const injectedMessages = [{ role: 'user' as const, content: 'injected' }];
    const shadowTool = createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: 'injected-sp',
        tools: [],
        messages: injectedMessages,
      }),
    });

    // ctx 不含 dialogMessages / systemPromptForLLM / toolsForLLM (已 evicted)
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      taskSystem: { schedule: vi.fn().mockResolvedValue('task-xxx') } as any,
    });

    // execute with async=false triggers sync path; async path also calls getTurnSnapshot
    // but sync path validates turnSnapshot early
    const result = await shadowTool.execute({ task: 'test', async: false }, ctx);

    // Should fail with no_main_context because ctx lacks currentToolUseId,
    // but the error message should NOT mention missing systemPrompt/tools
    // because getTurnSnapshot injected them successfully.
    // Actually with currentToolUseId missing, runShadow returns no_main_context.
    // We verify that the tool reached runShadow (turnSnapshot was valid)
    // by checking the error is 'no_main_context' rather than TypeError.
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_main_context');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});
