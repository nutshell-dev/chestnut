/**
 * shadow tool integration tests (phase 767)
 *
 * Coverage:
 * - missing task validation
 * - recursion rejection (ctx.isShadow)
 * - missing main context (no mainDialogStore)
 * - shadow path via runShadow
 * - spawn async=true rejected from within shadow (phase 766 defense)
 * - dispatch rejected from within shadow (phase 767 defense)
 * - failure returns tool_result with error metadata
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { shadowTool } from '../../../src/core/shadow-system/index.js';
import { spawnTool } from '../../../src/core/spawn-system/index.js';
import { DispatchTool } from '../../../src/core/async-task-system/tools/dispatch.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { SHADOW_AUDIT_EVENTS } from '../../../src/core/shadow-system/audit-events.js';
import { DONE_TOOL_NAME } from '../../../src/foundation/tools/tool-names.js';

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

describe('shadow tool (phase 767)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let baseCtx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;

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
      dialogMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
      ],
      systemPromptForLLM: 'sp',
      toolsForLLM: [],
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
    it('rejects when ctx.isShadow is true', async () => {
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

      const result = await shadowTool.execute({ task: 'test', async: false }, ctxNoState);

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
        dialogMessages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
        ],
        systemPromptForLLM: 'sp',
        toolsForLLM: [],
      });

      const result = await shadowTool.execute({ task: 'test', async: false }, ctxNoToolUseId);

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
      const { ToolTimeoutError } = await import('../../../src/types/errors.js');
      mockRunSubagent.mockRejectedValue(new ToolTimeoutError('read', 5000));

      const result = await shadowTool.execute({ task: 'timeout test', async: false }, baseCtx);

      expect(result.error).toBe('tool_timeout');
    });
  });

  describe('spawn-from-shadow defense (phase 766)', () => {
    it('rejects spawn with async=true when ctx.isShadow', async () => {
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
        registry: makeRegistry(),
        isShadow: true,
      });

      const result = await spawnTool.execute({ intent: 'test', async: true }, shadowCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_async_spawn_rejected');
    });

    it('allows spawn with async=false when ctx.isShadow', async () => {
      mockRunSubagent.mockResolvedValue({ text: 'shadow sync result' });
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
        registry: makeRegistry(),
        isShadow: true,
      });

      const result = await spawnTool.execute({ intent: 'test', async: false }, shadowCtx);

      expect(result.success).toBe(true);
    });
  });

  describe('dispatch-from-shadow defense (phase 767)', () => {
    it('rejects dispatch when ctx.isShadow', async () => {
      const dispatchTool = new DispatchTool(
        async () => 'system prompt',
        () => [],
        () => [],
      );
      const shadowCtx = new ExecContextImpl({
        clawId: 'shadow-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        isShadow: true,
      });

      const result = await dispatchTool.execute({ goal: 'test' }, shadowCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_dispatch_rejected');
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
