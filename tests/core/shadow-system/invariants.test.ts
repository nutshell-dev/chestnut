/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - shadow-signal-propagation.test.ts
 *  - shadow-integration.test.ts
 *  - form-synthesis.test.ts
 *  - shadow-di-restrictions.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool, SHADOW_TOOL_NAME } from '../../../src/core/shadow-system/index.js';
import type { Message, ToolDefinition, LLMResponse, StreamChunk } from '../../../src/foundation/llm-provider/types.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createDoneTool, DONE_TOOL_NAME } from '../../../src/core/subagent/index.js';
import { NoopAuditWriter } from '../../../src/core/subagent/noop-writers.js';
import { synthesizeFormB } from '../../../src/core/shadow-system/_helpers.js';
import { SHADOW_INSTRUCTION_PREFIX } from '../../../src/templates/prompts/shadow.js';
import { createSpawnTool, SPAWN_TOOL_NAME } from '../../../src/core/spawn-system/index.js';
import { SummonTool, SUMMON_TOOL_NAME } from '../../../src/core/summon-system/tools/summon.js';
import { createNotifyClawTool, NOTIFY_CLAW_TOOL_NAME } from '../../../src/core/claw-topology/tools/notify-claw.js';
import { createExecTool, EXEC_TOOL_NAME } from '../../../src/foundation/command-tool/index.js';
import type { Tool, ToolRegistry } from '../../../src/foundation/tools/types.js';

describe('shadow-signal-propagation', () => {
  /**
   * shadow signal propagation tests (phase 874)
   *
   * Coverage:
   * - outer abort signal propagates to inner runSubagent (shadow-system/system.ts)
   * - pre-aborted signal boundary path
   */

  const { mockRunSubagent } = vi.hoisted(() => ({
    mockRunSubagent: vi.fn(),
  }));

  describe('shadow signal propagation (phase 874)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
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

    function makeBaseCtx(signal?: AbortSignal): ExecContextImpl {
      return new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: audit.audit,
        llm: makeLLM(),
        registry: makeRegistry(),
        currentToolUseId: 'tu-1',
        signal,
      });
    }

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      shadowTool = createShadowTool({
        getTurnSnapshot: () => ({
          systemPrompt: 'sp',
          tools: [] as ToolDefinition[],
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
          ],
        }),
        runSubagent: mockRunSubagent,
      });
      mockRunSubagent.mockClear();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('shadow runs with no signal coupling (phase 1162 honesty fix)', async () => {
      const outerController = new AbortController();
      mockRunSubagent.mockResolvedValue({ text: 'ok' });

      const ctxWithSignal = makeBaseCtx(outerController.signal);
      const result = await shadowTool.execute({ task: 'test signal', async: false }, ctxWithSignal);

      expect(result.success).toBe(true);
      expect(mockRunSubagent).toHaveBeenCalledOnce();
      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.signal).toBeUndefined();
    });

    it('pre-aborted parent signal does not propagate to shadow (β-independent honest)', async () => {
      const outerController = new AbortController();
      outerController.abort();
      mockRunSubagent.mockRejectedValue(new Error('aborted'));

      const ctxPreAborted = makeBaseCtx(outerController.signal);
      const result = await shadowTool.execute({ task: 'pre-aborted', async: false }, ctxPreAborted);

      expect(result.success).toBe(false);
      expect(mockRunSubagent).toHaveBeenCalledOnce();
      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.signal).toBeUndefined();
    });
  });
});

describe('shadow-integration', () => {
  /**
   * Convert LLMResponse to stream chunks for mock
   * (duplicate from tests/core/task.test.ts:30+49 per Step A decision Q4 YAGNI)
   */
  async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<StreamChunk> {
    for (const block of response.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', delta: (block as { text: string }).text };
      } else if (block.type === 'tool_use') {
        const toolBlock = block as { id: string; name: string; input: unknown };
        yield {
          type: 'tool_use_start',
          toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' },
        };
        yield {
          type: 'tool_use_delta',
          toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) },
        };
      }
    }
    yield { type: 'done' };
  }

  function createMockLLM(responses: LLMResponse[]): LLMOrchestrator {
    let index = 0;
    const callMock = vi.fn(async () => {
      const response = responses[index++] || responses[responses.length - 1];
      return response;
    });
    return {
      call: callMock,
      stream: vi.fn((...args: unknown[]) => {
        const result = callMock(...args);
        if (result instanceof Promise) {
          return (async function* () {
            const response = await result;
            yield* responseToStreamChunks(response as LLMResponse);
          })();
        }
        return responseToStreamChunks(result as LLMResponse);
      }),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
    } as unknown as LLMOrchestrator;
  }

  describe('shadow integration (phase 784, real SubAgent path)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let registry: ToolRegistryImpl;
    let shadowTool: ReturnType<typeof createShadowTool>;

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    beforeEach(async () => {
      tempDir = await createTempDir('phase784-shadow-');
      fs = new NodeFileSystem({ baseDir: tempDir });
      registry = new ToolRegistryImpl();
      registry.register(createDoneTool());
      shadowTool = createShadowTool({
        getTurnSnapshot: () => ({
          systemPrompt: 'sp',
          tools: [] as ToolDefinition[],
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-shadow-1', name: 'shadow', input: { task: 'X' } }] },
          ],
        }),
      });
    });

    function makeBaseCtx(mockLLM: LLMOrchestrator): ExecContextImpl {
      return new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs,
        auditWriter: new NoopAuditWriter(),
        llm: mockLLM,
        registry,
        currentToolUseId: 'tu-shadow-1',
        maxSteps: 10,
      });
    }

    it('done capture: shadow LLM calls done → finalResult is captured.result, source=done', async () => {
      const mockLLM = createMockLLM([
        {
          content: [
            { type: 'text', text: 'I will submit' },
            { type: 'tool_use', id: 'call-done-1', name: DONE_TOOL_NAME, input: { result: 'Task X completed' } },
          ],
          stop_reason: 'tool_use',
        },
      ]);
      const baseCtx = makeBaseCtx(mockLLM);

      const result = await shadowTool.execute({ task: 'Test done capture', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Task X completed');
      expect(result.metadata?.source).toBe('done');
    });

    it('text fallback: shadow LLM ends with text only (no done) → finalResult is text, source=text (phase 780 isolation regression)', async () => {
      const mockLLM = createMockLLM([
        {
          content: [{ type: 'text', text: 'Done without submit_subtask tool' }],
          stop_reason: 'end_turn',
        },
      ]);
      const baseCtx = makeBaseCtx(mockLLM);

      const result = await shadowTool.execute({ task: 'Test text fallback', async: false }, baseCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Done without submit_subtask tool');
      expect(result.metadata?.source).toBe('text');
    });
  });
});

describe('form-synthesis', () => {
  /**
   * shadow-system Form B synthesis tests (phase 767, phase 770 删 Form A)
   */

  describe('shadow form synthesis', () => {
    const baseInstructionArgs = {
      shadowId: 'shadow-abc123',
      spawnedAt: '2024-01-01T00:00:00Z',
      spawnedByClawId: 'main-claw',
      toolUseId: 'tu-xyz789',
      task: 'Compute 1+1',
    } as const;

    describe('synthesizeFormB', () => {
      it('appends fresh user message with instruction', () => {
        const mainMessagesBeforeMarker: Message[] = [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'reply' },
        ];

        const result = synthesizeFormB({
          mainMessagesBeforeMarker,
          instructionArgs: { ...baseInstructionArgs },
        });

        expect(result).toHaveLength(mainMessagesBeforeMarker.length + 1);
        const instructionMsg = result[mainMessagesBeforeMarker.length];
        expect(instructionMsg.role).toBe('user');
        expect(typeof instructionMsg.content).toBe('string');
        expect(instructionMsg.content).toContain(SHADOW_INSTRUCTION_PREFIX);
        expect(instructionMsg.content).toContain('shadow_id: shadow-abc123');
        expect(instructionMsg.content).toContain('Compute 1+1');
      });

      it('does not include marker assistant', () => {
        const mainMessagesBeforeMarker: Message[] = [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ];

        const result = synthesizeFormB({
          mainMessagesBeforeMarker,
          instructionArgs: { ...baseInstructionArgs },
        });

        expect(result).toHaveLength(3);
        expect(result[0]).toEqual(mainMessagesBeforeMarker[0]);
        expect(result[1]).toEqual(mainMessagesBeforeMarker[1]);
      });

      it('main messages prefix 不变（cache invariant）', () => {
        const main: Message[] = [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
        ];
        const result = synthesizeFormB({
          mainMessagesBeforeMarker: main,
          instructionArgs: { ...baseInstructionArgs, shadowId: 'test' },
        });
        expect(result.slice(0, 2)).toEqual(main); // prefix bit-identical
      });
    });
  });
});

describe('shadow-di-restrictions', () => {
  /**
   * Phase 807 DI restrictions for shadow registry tools.
   *
   * Verifies:
   * - createShadowTool({ allowRecursion: false }) rejects recursive shadow calls
   * - createSpawnTool({ allowAsync: false }) rejects async spawn
   * - Shadow registry clones preserve main registry tool definitions (name/description/schema)
   *   for shadow/spawn/summon/notify-claw/exec tools.
   */

  describe('shadow DI restrictions (phase 807)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let baseCtx: ExecContextImpl;

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
      });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('createShadowTool({ allowRecursion: false }) rejects recursive shadow calls', async () => {
      const restrictedShadowTool = createShadowTool({
        getTurnSnapshot: () => ({
          systemPrompt: 'sp',
          tools: [] as ToolDefinition[],
          messages: [] as Message[],
        }),
        allowRecursion: false,
      });

      const result = await restrictedShadowTool.execute({ task: 'recursive call' }, baseCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_recursion_rejected');
    });

    it('createSpawnTool({ allowAsync: false }) rejects async spawn', async () => {
      const restrictedSpawnTool = createSpawnTool({ allowAsync: false });

      const result = await restrictedSpawnTool.execute({ intent: 'async task', async: true }, baseCtx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_async_spawn_rejected');
    });

    it('shadow registry clones preserve main registry tool definitions', () => {
      const mainRegistry = new ToolRegistryImpl();
      mainRegistry.register(createShadowTool({
        getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [] as ToolDefinition[], messages: [] as Message[] }),
      }));
      mainRegistry.register(createSpawnTool());
      mainRegistry.register(new SummonTool());
      mainRegistry.register(createNotifyClawTool({
        fs,
        notifyClaw: vi.fn().mockResolvedValue(undefined),
        defaultSource: 'motion',
        authorized: true,
        audit: audit.audit,
        isClawAlive: () => true,
        formatClawStatusHint: () => undefined,
        clawExists: () => true,
        hasActiveContract: () => false,
      }));
      mainRegistry.register(createExecTool());

      const shadowRegistry = createRestrictedRegistry(mainRegistry, {
        [SHADOW_TOOL_NAME]: { allowRecursion: false },
        [SPAWN_TOOL_NAME]: { allowAsync: false },
        [SUMMON_TOOL_NAME]: { allowFromShadow: false },
        [NOTIFY_CLAW_TOOL_NAME]: { authorized: false },
        [EXEC_TOOL_NAME]: { callerType: 'shadow_subagent' },
      });

      for (const name of [SHADOW_TOOL_NAME, SPAWN_TOOL_NAME, SUMMON_TOOL_NAME, NOTIFY_CLAW_TOOL_NAME, EXEC_TOOL_NAME]) {
        const mainTool = mainRegistry.get(name);
        const shadowTool = shadowRegistry.get(name);
        expect(mainTool).toBeDefined();
        expect(shadowTool).toBeDefined();
        expect(shadowTool!.name).toBe(mainTool!.name);
        expect(shadowTool!.description).toBe(mainTool!.description);
        expect(shadowTool!.schema).toEqual(mainTool!.schema);
      }
    });
  });

  /**
   * Replicates the phase-807 shadow registry override logic: clone each base tool
   * into a fresh registry while overriding DI properties. Leaves ToolDefinition
   * (name/description/schema) unchanged so KV cache stays stable.
   */
  function createRestrictedRegistry(
    baseRegistry: ToolRegistry,
    overridesByName: Record<string, Record<string, unknown>>,
  ): ToolRegistry {
    const registry = new ToolRegistryImpl();
    for (const tool of baseRegistry.getAll()) {
      const overrides = overridesByName[tool.name] ?? {};
      const restricted = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, overrides) as Tool;
      registry.register(restricted);
    }
    return registry;
  }
});
