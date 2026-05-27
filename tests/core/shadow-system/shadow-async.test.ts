/**
 * shadow async tests (phase 1087)
 *
 * Coverage:
 * - default async=true queues shadow task via AsyncTaskSystem.schedule
 * - async=true captures ctx snapshot (messages, systemPrompt, toolsForLLM)
 * - async=false takes sync path via runShadow (behavior unchanged)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool } from '../../../src/core/shadow-system/index.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
}));

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

vi.mock('../../../src/core/subagent/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/subagent/index.js')>();
  return {
    ...mod,
    runSubagent: mockRunSubagent,
  };
});

describe('shadow tool async (phase 1087)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let baseCtx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;
  let shadowTool: ReturnType<typeof createShadowTool>;

  function makeRegistry(): ToolRegistryImpl {
    const registry = new ToolRegistryImpl();
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

  function makeMockDialogStore(): DialogStore {
    return {
      restorePrefix: vi.fn().mockResolvedValue({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
        ],
        systemPrompt: 'sp',
        toolsForLLM: [],
        meta: { foundIn: 'current' },
      }),
    } as unknown as DialogStore;
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    const dialogMessages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
    ];
    baseCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: audit.audit,
      llm: makeLLM(),
      registry: makeRegistry(),
      mainDialogStore: makeMockDialogStore(),
      currentToolUseId: 'tu-1',
      taskSystem: createMockTaskSystem(fs, audit.audit),
    });
    shadowTool = createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: 'test-system-prompt',
        tools: [{ type: 'function', function: { name: 'read', description: 'read' } }] as ToolDefinition[],
        messages: dialogMessages,
      }),
    });
    baseCtx.taskSystem = createMockTaskSystem(fs, audit.audit);
    (baseCtx.taskSystem as any).schedule = mockSchedule;
    mockSchedule.mockClear();
    mockRunSubagent.mockClear();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('async path', () => {
    it('default async=true queues shadow task with snapshot fields', async () => {
      mockSchedule.mockResolvedValue('task-xxx');

      const result = await shadowTool.execute({ task: 'test task' }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalledOnce();
      expect(mockRunSubagent).not.toHaveBeenCalled();

      const callArgs = mockSchedule.mock.calls[0][1];
      expect(callArgs.kind).toBe('subagent');
      expect(callArgs.intentPreview).toBe('test task');
      expect(callArgs.isShadow).toBe(true);
      // synthesized by stripIncompleteToolUse + synthesizeFormB:
      // main messages stripped of trailing assistant (tool_use) → 1 user msg
      // + instruction = 2 messages (phase 1115: 3-turn reverted to 1-turn baseline)
      expect(callArgs.shadowMessages).toHaveLength(2);
      expect(callArgs.shadowMessages[0]).toEqual({ role: 'user', content: 'hi' });
      expect(callArgs.shadowMessages[1]).toMatchObject({ role: 'user' });
      expect((callArgs.shadowMessages[1] as { content: string }).content).toContain('SHADOW INSTRUCTION');
      expect(callArgs.shadowSystemPrompt).toBe('test-system-prompt');
      expect(callArgs.shadowToolsForLLM).toEqual([{ type: 'function', function: { name: 'read', description: 'read' } }]);
      expect(callArgs.parentClawId).toBe('test-claw');
      expect(callArgs.originClawId).toBe('test-claw');
      expect(callArgs.callerType).toBe('shadow');
    });

    it('async=true explicit takes async path', async () => {
      mockSchedule.mockResolvedValue('task-yyy');

      const result = await shadowTool.execute({ task: 'test task', async: true }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalledOnce();
      expect(mockRunSubagent).not.toHaveBeenCalled();
      expect(result.metadata).toMatchObject({ async: true, taskId: 'task-yyy' });
    });

    it('async path returns taskId and async metadata', async () => {
      mockSchedule.mockResolvedValue('task-zzz');

      const result = await shadowTool.execute({ task: 'test task' }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Shadow queued');
      expect(result.content).toContain('task-zzz');
      expect(result.metadata).toMatchObject({ async: true, taskId: 'task-zzz' });
    });
  });

  describe('sync path', () => {
    it('async=false takes sync path via runShadow', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'sync result' });

      const result = await shadowTool.execute({ task: 'test task', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockRunSubagent).toHaveBeenCalledOnce();

      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.isShadow).toBe(true);
      expect(callArgs.resultTool).toBe('done');
    });

    it('sync path returns inline result', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'inline shadow result' });

      const result = await shadowTool.execute({ task: 'compute 1+1', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('inline shadow result');
    });
  });

  describe('recursion defense', () => {
    it('rejects when ctx.isShadow is true even for async', async () => {
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        isShadow: true,
      });

      const result = await shadowTool.execute({ task: 'test' }, shadowCtx);
      // NOTE: recursion defense happens before getTurnSnapshot is called

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_recursion_rejected');
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });
  });
});
