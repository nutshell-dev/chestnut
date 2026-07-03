/**
 * spawn-system sync path tests (phase 766)
 *
 * Coverage:
 * - spawn schema async field validation
 * - async default behavior (undefined → async path)
 * - async=true explicit (same as default)
 * - async=false → sync path via runSpawnSync
 * - shadow defense: restricted spawn instance allowAsync=false + async=true → reject
 * - shadow defense: restricted spawn instance allowAsync=false + async=false → passes to sync path
 * - sync path audit events (SYNC_STARTED, SYNC_FINISHED)
 * - sync path failure audit (SYNC_FAILED)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createSpawnTool } from '../../../src/core/spawn-system/tools/spawn.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createDoneTool, DONE_TOOL_NAME } from '../../../src/core/subagent/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
}));

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

describe('spawn tool sync path (phase 766)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let baseCtx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;
  let taskSystem: ReturnType<typeof createMockTaskSystem>;
  let spawnToolWithTaskSystem: ReturnType<typeof createSpawnTool>;
  const testSpawnTool = createSpawnTool({ runSubagent: mockRunSubagent });

  function makeRegistry(): ToolRegistryImpl {
    const registry = new ToolRegistryImpl();
    // register a minimal set so getForProfile('subagent') returns non-empty
    registry.register({
      name: 'read',
      description: 'read',
      schema: { type: 'object', properties: {} },
      readonly: true,
      idempotent: true,
      execute: vi.fn(),
    });
    registry.register({
      name: 'done',
      description: 'done',
      schema: { type: 'object', properties: {} },
      readonly: false,
      idempotent: false,
      execute: vi.fn(),
    });
    return registry;
  }

  function makeLLM(): LLMOrchestrator {
    return {
      call: vi.fn(),
      stream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as LLMOrchestrator;
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    taskSystem = createMockTaskSystem(fs, audit.audit);
    taskSystem.schedule = mockSchedule;
    spawnToolWithTaskSystem = createSpawnTool({ taskSystem });
    baseCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: audit.audit,
      llm: makeLLM(),
      registry: makeRegistry(),
    });
    mockSchedule.mockClear();
    mockRunSubagent.mockClear();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('async path (backward compat)', () => {
    it('default async=true when args.async is undefined', async () => {
      mockSchedule.mockResolvedValue('task-xxx');

      const result = await spawnToolWithTaskSystem.execute({ intent: 'test task' }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalledWith(
        'subagent', expect.objectContaining({ intent: 'test task' }),
      );
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });

    it('async=true explicit takes async path', async () => {
      mockSchedule.mockResolvedValue('task-yyy');

      const result = await spawnToolWithTaskSystem.execute({ intent: 'test task', async: true }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalledWith(
        'subagent', expect.objectContaining({ intent: 'test task' }),
      );
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });
  });

  describe('sync path', () => {
    it('async=false takes sync path via runSpawnSync', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'sync result' });

      const result = await testSpawnTool.execute({ intent: 'test task', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockRunSubagent).toHaveBeenCalledOnce();

      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.resultDir).toContain('tasks/sync/spawn');
      expect(callArgs.resultDir).toContain('spawn-');
      expect(callArgs.prompt).toBe('test task');
      expect(callArgs.systemPrompt).toBeTruthy();
    });

    it('sync path returns inline result', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'inline result from subagent' });

      const result = await testSpawnTool.execute({ intent: 'compute 1+1', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('inline result from subagent');
      expect(result.metadata).toMatchObject({ sync: true });
      expect(result.metadata?.spawnId).toMatch(/^spawn-/);
    });

    it('sync path audits SYNC_STARTED and SYNC_FINISHED', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'ok' });

      await testSpawnTool.execute({ intent: 'audit test', async: false }, baseCtx);

      const types = audit.events.map((e) => e[0]);
      expect(types).toContain('spawn_sync_started');
      expect(types).toContain('spawn_sync_finished');
    });

    it('sync path failure audits SYNC_FAILED', async () => {
      mockRunSubagent.mockRejectedValue(new Error('subagent crashed'));

      const result = await testSpawnTool.execute({ intent: 'fail test', async: false }, baseCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn_sync_failed');

      const types = audit.events.map((e) => e[0]);
      expect(types).toContain('spawn_sync_started');
      expect(types).toContain('spawn_sync_failed');
    });

    it('sync path rejects when registry missing', async () => {
      const ctxNoRegistry = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
      });

      const result = await testSpawnTool.execute({ intent: 'no registry', async: false }, ctxNoRegistry);

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn_sync_failed');
      expect(result.content).toContain('registry not available');
    });

    it('sync path rejects when llm missing', async () => {
      const ctxNoLlm = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        registry: makeRegistry(),
      });

      const result = await testSpawnTool.execute({ intent: 'no llm', async: false }, ctxNoLlm);

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn_sync_failed');
      expect(result.content).toContain('LLM not available');
    });
  });

  describe('shadow defense', () => {
    it('rejects spawn with async=true when restricted instance has allowAsync=false', async () => {
      const restrictedSpawnTool = createSpawnTool({ taskSystem, allowAsync: false });
      const result = await restrictedSpawnTool.execute({ intent: 'test', async: true }, baseCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_async_spawn_rejected');
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });

    it('allows spawn with async=false when restricted instance has allowAsync=false', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'shadow sync result' });

      const restrictedSpawnTool = createSpawnTool({ runSubagent: mockRunSubagent, allowAsync: false });
      const result = await restrictedSpawnTool.execute({ intent: 'test', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('shadow sync result');
      expect(mockRunSubagent).toHaveBeenCalledOnce();
    });

    it('allows normal spawn (non-shadow) with async=true', async () => {
      mockSchedule.mockResolvedValue('task-zzz');

      const result = await spawnToolWithTaskSystem.execute({ intent: 'test', async: true }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockSchedule).toHaveBeenCalledOnce();
    });
  });

  describe('done capturedResult isolation (phase 944)', () => {
    it('uses fresh done instance, isolated from main registry capturedResult', async () => {
      // 1. pre-set main registry done with stale capturedResult
      const mainDone = baseCtx.registry?.get(DONE_TOOL_NAME) as { capturedResult?: { result: string } } | undefined;
      if (!mainDone) throw new Error('test setup: main registry should have done tool');
      mainDone.capturedResult = { result: 'STALE_RESULT_FROM_PREVIOUS_SPAWN' };

      // 2. mock runSubagent to return text only (simulates LLM not calling done)
      mockRunSubagent.mockResolvedValue({ text: 'fresh spawn text result' });

      // 3. run spawn sync; internal subagentRegistry should have fresh done, not main stale
      const result = await testSpawnTool.execute({ intent: 'isolation test', async: false }, baseCtx);

      // 4. assert text fallback, not stale result
      expect(result.success).toBe(true);
      expect(result.content).toBe('fresh spawn text result');
      expect(result.content).not.toContain('STALE_RESULT_FROM_PREVIOUS_SPAWN');

      // 5. assert runSubagent received subagentRegistry with done as fresh instance
      const callArgs = mockRunSubagent.mock.calls[0][0];
      const spawnDone = callArgs.registry.get(DONE_TOOL_NAME);
      expect(spawnDone).toBeDefined();
      expect(spawnDone).not.toBe(mainDone); // fresh instance !== main instance
      expect((spawnDone as { capturedResult?: unknown }).capturedResult).toBeUndefined(); // fresh, no stale state
    });
  });
});
