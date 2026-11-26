/**
 * shadow tool integration tests (phase 767)
 *
 * Coverage:
 * - missing task validation
 * - recursion rejection (restricted instance allowRecursion=false)
 * - missing main context (no in-memory dialog state)
 * - shadow path via runShadow
 * - spawn async=true rejected from within shadow (phase 766 defense)
 * - summon rejected from within shadow (phase 767 defense、phase 1119 renamed dispatch → summon)
 * - failure returns tool_result with error metadata
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool, SHADOW_DEFAULT_TIMEOUT_MS } from '../../../src/core/shadow-system/index.js';
import { runShadow } from '../../../src/core/shadow-system/system.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

import { SHADOW_AUDIT_EVENTS } from '../../../src/core/shadow-system/audit-events.js';
import { DONE_TOOL_NAME } from '../../../src/core/subagent/tools/done.js';
import { ToolTimeoutError } from '../../../src/foundation/tools/errors.js';  // phase 262: hoist
import type { SubagentFinalOutcome } from '../../../src/core/subagent/index.js';
import {
  completedOutcome,
  deferred,
  executionIdentity,
  executionRef,
  terminalFailure,
} from './execution-fixtures.js';

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
      it('rejects when restricted instance has allowRecursion=false', async () => {
        const restrictedShadowTool = createShadowTool({
          getTurnSnapshot: () => ({
            systemPrompt: 'sp',
            tools: [] as ToolDefinition[],
            messages: [],
          }),
          allowRecursion: false,
        });

        const result = await restrictedShadowTool.execute({ task: 'test' }, baseCtx);

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
        // phase 1858 Step J (SA-D9): SubAgentOptions.isShadow 已删——反向锁：不再传该字段
        expect(callArgs).not.toHaveProperty('isShadow');
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

    describe('execution reference consumption (phase 2248 H2)', () => {
      it('holds the reference and awaits completion before projecting the original final text', async () => {
        const completion = deferred<SubagentFinalOutcome>();
        const mockStart = vi.fn();
        let identity: ReturnType<typeof executionIdentity> | undefined;
        mockStart.mockImplementation(async request => {
          identity = executionIdentity(request);
          return executionRef(identity, completion.promise);
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({
            systemPrompt: 'sp',
            tools: [] as ToolDefinition[],
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
            ],
          }),
          subagentRunner: { start: mockStart },
          runSubagent: mockRunSubagent,
        });
        let settled = 0;
        const pending = tool.execute({ task: 'gated result', async: false }, baseCtx)
          .then(result => { settled += 1; return result; });

        await vi.waitFor(() => { expect(mockStart).toHaveBeenCalledOnce(); });
        const request = mockStart.mock.calls[0][0];
        expect(request.runId).toMatch(/^shadow-/);
        expect(request.resultDir).toBe(`tasks/sync/shadow/${request.runId}`);
        expect(request.input).toMatchObject({
          prompt: '',
          toolProfile: 'full',
          execution: {
            callerKind: 'shadow', allowDone: true, allowShadow: false,
            allowSummon: false, allowNotifyClaw: false,
          },
          resultCapture: { toolName: 'done' },
        });
        expect(settled).toBe(0);
        expect(mockRunSubagent).not.toHaveBeenCalled();
        expect(audit.events.map(e => e[0])).not.toContain(SHADOW_AUDIT_EVENTS.FINISHED);

        const degraded = [{ stage: 'artifact' as const, artifact: 'dialog:write', error: 'late EIO' }];
        completion.resolve(completedOutcome(identity!, 'fallback text', { result: 'captured final text' }, degraded));
        const result = await pending;

        expect(settled).toBe(1);
        expect(result.success).toBe(true);
        expect(result.content).toBe('captured final text');
        expect(result.metadata).toMatchObject({
          source: 'done', execution: identity, outcomeKind: 'completed', degraded,
        });
        expect(JSON.stringify(result)).not.toContain('completion');
        expect(JSON.stringify(result)).not.toContain('requestStop');
      });

      it('keeps the parent signal attached and does not turn a stop receipt into a terminal failure', async () => {
        const outerController = new AbortController();
        const completion = deferred<SubagentFinalOutcome>();
        const reason = { kind: 'user_stop' };
        const degraded = [{ stage: 'artifact' as const, artifact: 'dialog:write', error: 'late EIO' }];
        const mockStart = vi.fn();
        let identity: ReturnType<typeof executionIdentity> | undefined;
        let ref: ReturnType<typeof executionRef> | undefined;
        mockStart.mockImplementation(async request => {
          identity = executionIdentity(request);
          ref = executionRef(identity, completion.promise);
          vi.mocked(ref.requestStop).mockResolvedValue({
            identity,
            accepted: true,
            state: 'stopping',
            reason,
            persisted: true,
            durable: true,
            persistence: {
              path: `${identity.resultDir}/execution/attempts/1/stops/1.json`,
              kind: 'durable', persisted: true, durable: true,
            },
          });
          request.signal?.addEventListener(
            'abort',
            () => { void ref?.requestStop(request.signal?.reason); },
            { once: true },
          );
          return ref;
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({
            systemPrompt: 'sp', tools: [] as ToolDefinition[],
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
            ],
          }),
          subagentRunner: { start: mockStart },
        });
        const ctxWithSignal = new ExecContextImpl({
          clawId: 'test-claw', clawDir: tempDir, syncDir: path.join(tempDir, 'tasks', 'sync'),
          profile: 'full', fs, auditWriter: audit.audit, llm: makeLLM(), registry: makeRegistry(),
          currentToolUseId: 'tu-1', signal: outerController.signal,
        });
        let settled = 0;
        const pending = tool.execute({ task: 'gated cancellation', async: false }, ctxWithSignal)
          .then(result => { settled += 1; return result; });
        await vi.waitFor(() => { expect(mockStart).toHaveBeenCalledOnce(); });
        expect(mockStart.mock.calls[0][0].signal).toBe(outerController.signal);

        outerController.abort(reason);
        await vi.waitFor(() => { expect(ref?.requestStop).toHaveBeenCalledWith(reason); });
        expect(await ref?.requestStop(reason)).toMatchObject({ accepted: true, state: 'stopping' });
        expect(settled).toBe(0);
        expect(audit.events.map(e => e[0])).not.toContain(SHADOW_AUDIT_EVENTS.FAILED);
        expect(audit.events.map(e => e[0])).not.toContain(SHADOW_AUDIT_EVENTS.FINISHED);

        completion.resolve(terminalFailure(identity!, 'interrupted', reason, degraded));
        const result = await pending;
        expect(settled).toBe(1);
        expect(result.success).toBe(false);
        expect(result.error).toBe('abort');
        expect(result.content).toContain('execution interrupted');
        expect(result.metadata).toMatchObject({
          execution: identity, outcomeKind: 'interrupted', cause: reason, degraded,
        });
        expect(audit.events.filter(e => e[0] === SHADOW_AUDIT_EVENTS.FAILED)).toHaveLength(1);
        expect(audit.events.map(e => e[0])).not.toContain(SHADOW_AUDIT_EVENTS.FINISHED);
        expect(JSON.stringify(result)).not.toContain('completion');
      });

      it('keeps final business failure cause, identity and degraded evidence distinct from interruption', async () => {
        const cause = new Error('actual business execution failed');
        const degraded = [{ stage: 'outcome' as const, artifact: 'outcome.json', error: 'commit EIO' }];
        const mockStart = vi.fn().mockImplementation(async request => {
          const identity = executionIdentity(request);
          return executionRef(identity, Promise.resolve(terminalFailure(identity, 'failed', cause, degraded)));
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({
            systemPrompt: 'sp', tools: [] as ToolDefinition[],
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
            ],
          }),
          subagentRunner: { start: mockStart },
        });

        const result = await tool.execute({ task: 'failed outcome', async: false }, baseCtx);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Error');
        expect(result.content).toContain('execution failed: actual business execution failed');
        expect(result.content).not.toContain('interrupted');
        expect(result.metadata).toMatchObject({ outcomeKind: 'failed', cause, degraded });
        expect(result.metadata?.execution).toMatchObject({ attemptId: 'shadow-attempt-test' });
      });

      it('keeps timeout classification on an actual interrupted outcome', async () => {
        const cause = new ToolTimeoutError('read', 5000);
        const mockStart = vi.fn().mockImplementation(async request => {
          const identity = executionIdentity(request);
          return executionRef(identity, Promise.resolve(terminalFailure(identity, 'interrupted', cause)));
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({
            systemPrompt: 'sp', tools: [] as ToolDefinition[],
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
            ],
          }),
          subagentRunner: { start: mockStart },
        });

        const result = await tool.execute({ task: 'timeout outcome', async: false }, baseCtx);

        expect(result.success).toBe(false);
        expect(result.error).toBe('tool_timeout');
        expect(result.metadata).toMatchObject({ outcomeKind: 'interrupted', cause });
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

    describe('run failure typed outcomes (phase 1865 SH-D5)', () => {
      const failedRows = () => audit.events.filter(e => e[0] === SHADOW_AUDIT_EVENTS.FAILED);

      it('no_main_context（dialogMessages 缺失）→ FAILED 留痕 phase=main_context + missing 证据', async () => {
        const tool = createShadowTool({
          getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: undefined }),
          runSubagent: mockRunSubagent,
        });

        const result = await tool.execute({ task: 't', async: false }, baseCtx);

        expect(result.success).toBe(false);
        expect(result.error).toBe('no_main_context');
        expect(failedRows()).toHaveLength(1);
        expect(failedRows()[0]).toContain('phase=main_context');
        expect(failedRows()[0]).toContain('error=missing=dialogMessages');
        expect(mockRunSubagent).not.toHaveBeenCalled();
      });

      it('no_main_context（多字段缺失）→ missing 列全列', async () => {
        const ctxNoToolUse = new ExecContextImpl({
          clawId: 'test-claw',
          clawDir: tempDir,
          syncDir: path.join(tempDir, 'tasks', 'sync'),
          profile: 'full',
          fs,
          auditWriter: audit.audit,
          llm: makeLLM(),
          registry: makeRegistry(),
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({ tools: [], messages: [{ role: 'user', content: 'x' }] }),
        });

        const result = await tool.execute({ task: 't', async: false }, ctxNoToolUse);

        expect(result.error).toBe('no_main_context');
        expect(failedRows()[0]).toContain('error=missing=currentToolUseId,systemPrompt');
      });

      it('prefix_synthesis 失败 → FAILED 留痕 phase=prefix_restore + 原始 error 证据', async () => {
        // marker 查找仅在 mainMessages 缺省时执行（工具路径已预 strip）——直接调 runShadow 触发该路径。
        const result = await runShadow({
          task: 't',
          ctx: baseCtx,
          runSubagent: mockRunSubagent,
          turnSnapshot: { systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'no marker here' }] },
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('prefix_synthesis_failed');
        expect(failedRows()).toHaveLength(1);
        expect(failedRows()[0]).toContain('phase=prefix_restore');
        expect(failedRows()[0].join(' ')).toContain('marker not found');
        expect(mockRunSubagent).not.toHaveBeenCalled();
      });

      it('registry 缺失 → registry_unavailable + FAILED 留痕 phase=registry', async () => {
        const ctxNoRegistry = new ExecContextImpl({
          clawId: 'test-claw',
          clawDir: tempDir,
          syncDir: path.join(tempDir, 'tasks', 'sync'),
          profile: 'full',
          fs,
          auditWriter: audit.audit,
          llm: makeLLM(),
          currentToolUseId: 'tu-1',
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'hi' }] }),
          runSubagent: mockRunSubagent,
        });

        const result = await tool.execute({ task: 't', async: false }, ctxNoRegistry);

        expect(result.success).toBe(false);
        expect(result.error).toBe('registry_unavailable');
        expect(failedRows()[0]).toContain('phase=registry');
        expect(mockRunSubagent).not.toHaveBeenCalled();
      });

      it('llm 缺失 → llm_unavailable + FAILED 留痕 phase=llm', async () => {
        const ctxNoLlm = new ExecContextImpl({
          clawId: 'test-claw',
          clawDir: tempDir,
          syncDir: path.join(tempDir, 'tasks', 'sync'),
          profile: 'full',
          fs,
          auditWriter: audit.audit,
          registry: makeRegistry(),
          currentToolUseId: 'tu-1',
        });
        const tool = createShadowTool({
          getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'hi' }] }),
          runSubagent: mockRunSubagent,
        });

        const result = await tool.execute({ task: 't', async: false }, ctxNoLlm);

        expect(result.success).toBe(false);
        expect(result.error).toBe('llm_unavailable');
        expect(failedRows()[0]).toContain('phase=llm');
        expect(mockRunSubagent).not.toHaveBeenCalled();
      });
    });

    describe('policy injection (phase 1865 SH-D7)', () => {
      it('schema 不承诺默认值/步数策略', () => {
        const props = shadowTool.schema.properties as Record<string, { description?: string }>;
        expect(props.timeoutMs.description).toBe('Timeout in milliseconds.');
        expect(props.maxSteps.description).toBe('Maximum ReAct steps.');
      });

      it('注入的 defaultTimeoutMs/subagentMaxSteps 生效（args 缺省时）', async () => {
        mockRunSubagent.mockResolvedValue({ text: 'ok' });
        const injected = createShadowTool({
          getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'hi' }] }),
          runSubagent: mockRunSubagent,
          defaultTimeoutMs: 42_000,
          subagentMaxSteps: 11,
        });

        await injected.execute({ task: 't', async: false }, baseCtx);

        const callArgs = mockRunSubagent.mock.calls[0][0];
        expect(callArgs.timeoutMs).toBe(42_000);
        expect(callArgs.maxSteps).toBe(11);
      });

      it('显式 args 覆盖注入值；未注入时执行层 fallback=现行默认', async () => {
        mockRunSubagent.mockResolvedValue({ text: 'ok' });
        const injected = createShadowTool({
          getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'hi' }] }),
          runSubagent: mockRunSubagent,
          defaultTimeoutMs: 42_000,
        });

        await injected.execute({ task: 't', async: false, timeoutMs: 7_000 }, baseCtx); // time-fixture: configuration/payload round-trip input, not an independent wait budget
        expect(mockRunSubagent.mock.calls[0][0].timeoutMs).toBe(7_000);

        // shadowTool（beforeEach 构造，未注入 defaultTimeoutMs）→ 执行层 fallback
        await shadowTool.execute({ task: 't', async: false }, baseCtx);
        expect(mockRunSubagent.mock.calls[1][0].timeoutMs).toBe(SHADOW_DEFAULT_TIMEOUT_MS);
      });
    });

    describe('summon-from-shadow defense (phase 767)', () => {
      it('rejects summon when restricted instance has allowFromShadow=false', async () => {
        // Phase 1396 Step M: 三参数构造；注入完整 caller snapshot 并断言未被调用，
        // 确保拒绝真来自 allowFromShadow=false 分支而非 snapshot 缺失路径。
        const summonTool = new SummonTool({ allowFromShadow: false });
        const getCallerSnapshot = vi.fn();
        const ctx = Object.create(baseCtx, {
          getCallerSnapshot: { value: getCallerSnapshot },
        }) as typeof baseCtx;

        const result = await summonTool.execute({ goal: 'test' }, ctx);

        expect(result.success).toBe(false);
        expect(result.error).toBe('summon_unavailable');
        expect(result.content).toContain('unavailable');
        expect(getCallerSnapshot).not.toHaveBeenCalled();
      });
    });

    describe('callerType and profile alignment (phase 787 / phase 807)', () => {
      it('passes toolProfile=full to runSubagent and does not pass callerLabel', async () => {
        mockRunSubagent.mockResolvedValue({ text: 'shadow ok' });

        await shadowTool.execute({ task: 'profile alignment', async: false }, baseCtx);

        const callArgs = mockRunSubagent.mock.calls[0][0];
        expect(callArgs.callerLabel).toBeUndefined();
        expect(callArgs.toolProfile).toBe('full');
      });
    });

    describe('done instance isolation (phase 780; phase 1858 Step F reframe)', () => {
      it('uses fresh done instance, isolated from main registry instance', async () => {
        // 1. main registry 的共享 done 实例
        const mainDone = baseCtx.registry?.get(DONE_TOOL_NAME);
        if (!mainDone) throw new Error('test setup: main registry should have done tool');

        // 2. mock runSubagent 返回文本（模拟 LLM 未调 done）
        mockRunSubagent.mockResolvedValue({ text: 'fresh shadow text result' });

        // 3. run shadow
        const result = await shadowTool.execute({ task: 'isolation test', async: false }, baseCtx);

        // 4. 无捕获结果 → text fallback
        expect(result.success).toBe(true);
        expect(result.content).toBe('fresh shadow text result');
        expect(result.metadata?.source).toBe('text');

        // 5. runSubagent 收到的 registry 中 done 为 fresh 实例（≠ 主 registry 实例）。
        //    phase 1858 Step F：捕获状态改为 per-run 通道（实例不再持有可变字段），
        //    run 级「不读共享实例状态」由 run-capture-isolation.test.ts 覆盖。
        const callArgs = mockRunSubagent.mock.calls[0][0];
        const shadowDone = callArgs.registry.get(DONE_TOOL_NAME);
        expect(shadowDone).toBeDefined();
        expect(shadowDone).not.toBe(mainDone); // fresh instance !== main instance
      });
    });
  });
