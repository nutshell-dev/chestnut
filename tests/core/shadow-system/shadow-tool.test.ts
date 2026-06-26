/**
 * shadow tool integration tests (phase 767)
 *
 * Coverage:
 * - missing task validation
 * - recursion rejection (ctx.callerLabel === 'shadow')
 * - missing main context (no mainDialogStore)
 * - shadow path via runShadow
 * - spawn async=true rejected from within shadow (phase 766 defense)
 * - summon rejected from within shadow (phase 767 defense、phase 1119 renamed dispatch → summon)
 * - failure returns tool_result with error metadata
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool } from '../../../src/core/shadow-system/index.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { SHADOW_AUDIT_EVENTS } from '../../../src/core/shadow-system/audit-events.js';
import { DONE_TOOL_NAME } from '../../../src/core/subagent/tools/done.js';
import { ToolTimeoutError } from '../../../src/foundation/tools/errors.js';  // phase 262: hoist

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

describe('shadow tool (phase 767)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let baseCtx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;
  let shadowTool: ReturnType<typeof createShadowTool>;
  let taskSystem: ReturnType<typeof createMockTaskSystem>;

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
    taskSystem = createMockTaskSystem(fs, audit.audit);
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
    });
    shadowTool = createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: 'sp',
        tools: [] as ToolDefinition[],
        messages: dialogMessages,
      }),
      runSubagent: mockRunSubagent,
      taskSystem,
    });
    mockRunSubagent.mockClear();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('input validation', () => {
    it('rejects when task is missing', async () => {
      const result = await shadowTool.execute({}, baseCtx);
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_task');
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });
  });

  describe('recursion defense', () => {
    it('rejects when ctx.callerLabel is shadow', async () => {
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        callerLabel: 'shadow',
      });

      const result = await shadowTool.execute({ task: 'test' }, shadowCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_recursion_rejected');
      expect(mockRunSubagent).not.toHaveBeenCalled();

      const auditEvents = audit.events.map(e => e[0]);
      expect(auditEvents).toContain(SHADOW_AUDIT_EVENTS.RECURSION_REJECTED);
    });
  });

  describe('missing main context', () => {
    it('rejects when in-memory dialog state is missing', async () => {
      const ctxNoState = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
        registry: makeRegistry(),
        currentToolUseId: 'tu-1',
      });
      const shadowToolNoState = createShadowTool({
        getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: undefined }),
      });

      const result = await shadowToolNoState.execute({ task: 'test', async: false }, ctxNoState);

      expect(result.success).toBe(false);
      expect(result.error).toBe('no_main_context');
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });

    it('rejects when currentToolUseId is missing', async () => {
      const ctxNoToolUseId = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
        registry: makeRegistry(),
        mainDialogStore: makeMockDialogStore(),
      });
      const shadowToolNoToolUseId = createShadowTool({
        getTurnSnapshot: () => ({
          systemPrompt: 'sp',
          tools: [] as ToolDefinition[],
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
          ],
        }),
      });

      const result = await shadowToolNoToolUseId.execute({ task: 'test', async: false }, ctxNoToolUseId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('no_main_context');
    });
  });

  describe('shadow path', () => {
    it('calls runSubagent with messages from synthesizeFormB', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'shadow result' });

      const result = await shadowTool.execute({ task: 'test task', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('shadow result');
      expect(mockRunSubagent).toHaveBeenCalledOnce();

      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.agentId).toMatch(/^shadow-/);
      expect(callArgs.resultDir).toContain('tasks/sync/shadow');
      expect(callArgs.messages).toBeDefined();
      expect(callArgs.messages.length).toBeGreaterThan(0);
      expect(callArgs.isShadow).toBe(true);
      expect(callArgs.resultTool).toBe('done');
      expect(callArgs.prompt).toBe('');
    });

    it('returns done capturedResult when available', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'fallback', capturedResult: { result: 'structured result' } });

      const result = await shadowTool.execute({ task: 'test', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('structured result');
      expect(result.metadata?.source).toBe('done');
    });
  });

  describe('failure handling', () => {
    it('returns tool_result with error metadata on runSubagent failure', async () => {
      mockRunSubagent.mockRejectedValue(new Error('subagent crashed'));

      const result = await shadowTool.execute({ task: 'fail test', async: false }, baseCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Error');
      expect(result.content).toContain('execution failed');
      expect(result.metadata?.shadowId).toMatch(/^shadow-/);
      expect(result.metadata?.shadowAuditPath).toContain('audit.tsv');

      const auditEvents = audit.events.map(e => e[0]);
      expect(auditEvents).toContain(SHADOW_AUDIT_EVENTS.STARTED);
      expect(auditEvents).toContain(SHADOW_AUDIT_EVENTS.FAILED);
    });

    it('classifies ToolTimeoutError as timeout', async () => {
      mockRunSubagent.mockRejectedValue(new ToolTimeoutError('read', 5000));

      const result = await shadowTool.execute({ task: 'timeout test', async: false }, baseCtx);

      expect(result.error).toBe('tool_timeout');
    });
  });

  describe('summon-from-shadow defense (phase 767)', () => {
    it('rejects summon when ctx.callerLabel is shadow', async () => {
      const summonTool = new SummonTool();
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        callerLabel: 'shadow',
      });

      const result = await summonTool.execute({ goal: 'test' }, shadowCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_summon_rejected');
      expect(result.content).toContain('not callable from within shadow');
    });
  });

  describe('callerType and profile alignment (phase 782)', () => {
    it('passes callerType=shadow to runSubagent so executorProfile derives to full', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'shadow ok' });

      await shadowTool.execute({ task: 'profile alignment', async: false }, baseCtx);

      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.callerType).toBe('shadow');
    });
  });

  describe('done capturedResult isolation (phase 780)', () => {
    it('uses fresh done instance, isolated from main registry capturedResult', async () => {
      // 1. pre-set main registry done with stale capturedResult
      const mainDone = baseCtx.registry?.get(DONE_TOOL_NAME) as { capturedResult?: { result: string } } | undefined;
      if (!mainDone) throw new Error('test setup: main registry should have done tool');
      mainDone.capturedResult = { result: 'STALE_RESULT_FROM_PREVIOUS_SHADOW' };

      // 2. mock runSubagent to not write capturedResult (simulates LLM not calling done)
      mockRunSubagent.mockResolvedValue({ text: 'fresh shadow text result' });

      // 3. run shadow; internal shadowRegistry should have fresh done, not read main stale
      const result = await shadowTool.execute({ task: 'isolation test', async: false }, baseCtx);

      // 4. assert text fallback, not stale result
      expect(result.success).toBe(true);
      expect(result.content).toBe('fresh shadow text result');
      expect(result.content).not.toContain('STALE_RESULT_FROM_PREVIOUS_SHADOW');
      expect(result.metadata?.source).toBe('text');

      // 5. assert runSubagent received shadowRegistry with done as fresh instance
      const callArgs = mockRunSubagent.mock.calls[0][0];
      const shadowDone = callArgs.registry.get(DONE_TOOL_NAME);
      expect(shadowDone).toBeDefined();
      expect(shadowDone).not.toBe(mainDone); // fresh instance !== main instance
      expect((shadowDone as { capturedResult?: unknown }).capturedResult).toBeUndefined(); // fresh, no stale state
    });
  });
});
