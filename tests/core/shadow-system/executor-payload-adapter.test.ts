/**
 * phase 1863 (AT-D7)：executor payload 解释面（opaque payload → 执行参数）。
 *
 * Coverage:
 * - interpretShadowExecutorPayload：契约字段判别（命中/未命中）
 * - executeSubAgentTask + adapter：shadow payload 端到端解释（prompt ''/systemPrompt/
 *   messages/resultTool/受限工具覆盖）
 * - 无 payload（standard 路径）：prompt=intent、无 messages、无 resultTool 覆盖
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { interpretShadowExecutorPayload, buildShadowPayload } from '../../../src/core/shadow-system/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { SubAgentTask } from '../../../src/core/async-task-system/types.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

const { mockRunSubagent } = vi.hoisted(() => ({ mockRunSubagent: vi.fn() }));

function makeRestrictedTool(): Tool {
  return {
    name: 'summon',
    description: 'summon',
    schema: { type: 'object', properties: {} },
    readonly: false,
    idempotent: false,
    profiles: ['full'],
    restrictedOverrides: { allowFromShadow: false },
    execute: vi.fn(),
  } as unknown as Tool;
}

describe('executor payload adapter (phase 1863 AT-D7)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    mockRunSubagent.mockReset();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeTask(overrides?: Partial<SubAgentTask>): SubAgentTask {
    return {
      kind: 'subagent',
      id: makeFullTaskId('550e8400-e29b-41d4-a716-446655440001'),
      shortId: makeShortTaskId('550e8401'),
      intent: 'do the thing',
      timeoutMs: 300_000,
      maxSteps: 10,
      parentClawId: 'caller-claw',
      createdAt: new Date().toISOString(),
      toolProfile: 'full',
      ...overrides,
    };
  }

  function makeDeps(registry: ToolRegistryImpl) {
    return {
      fs: nodeFs,
      fsFactory: () => nodeFs,
      auditWriter: audit.audit,
      llm: {} as unknown as LLMOrchestrator,
      registry,
      clawDir: tempDir,
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      executorPayloadAdapter: interpretShadowExecutorPayload,
      runSubagent: mockRunSubagent,
      sendResult: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('interpretShadowExecutorPayload：契约形状命中，非契约形状（含 undefined）不命中', () => {
    const ctx = new ExecContextImpl({
      clawId: 'c1',
      clawDir: tempDir,
      profile: 'full',
      fs: nodeFs,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-1',
    });
    const payload = buildShadowPayload({
      task: 't',
      mainMessages: [{ role: 'user', content: 'hi' }],
      ctx,
      systemPrompt: 'shadow-sp',
      toolsForLLM: [],
    });

    const interpreted = interpretShadowExecutorPayload(payload);
    expect(interpreted).toEqual({
      prompt: '',
      systemPrompt: 'shadow-sp',
      messages: payload.messages,
      applyRestrictedOverrides: true,
      resultTool: 'done',
    });

    expect(interpretShadowExecutorPayload(undefined)).toBeUndefined();
    expect(interpretShadowExecutorPayload({ random: 'shape' })).toBeUndefined();
    expect(interpretShadowExecutorPayload({ ...payload, detached: false })).toBeUndefined();
  });

  it('shadow payload 端到端：runSubagent 收到 payload 解释出的执行参数 + 受限工具覆盖', async () => {
    const registry = new ToolRegistryImpl();
    const sourceTool = makeRestrictedTool();
    registry.register(sourceTool);

    const ctx = new ExecContextImpl({
      clawId: 'c1',
      clawDir: tempDir,
      profile: 'full',
      fs: nodeFs,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-1',
    });
    const payload = buildShadowPayload({
      task: 'shadow intent',
      mainMessages: [{ role: 'user', content: 'hi' }],
      ctx,
      systemPrompt: 'shadow-sp',
      toolsForLLM: [],
    });
    const task = makeTask({ executorPayload: payload });
    mockRunSubagent.mockResolvedValue({ text: 'shadow ok' });

    await executeSubAgentTask(task, new AbortController().signal, makeDeps(registry));

    const callArgs = mockRunSubagent.mock.calls[0][0];
    expect(callArgs.prompt).toBe('');
    expect(callArgs.systemPrompt).toBe('shadow-sp');
    expect(callArgs.messages).toEqual(payload.messages);
    expect(callArgs.resultTool).toBe('done');
    // 受限覆盖：registry 内 summon 被 clone 且 override 生效（≠ 源实例）
    const shadowSummon = callArgs.registry.get('summon') as { allowFromShadow?: boolean };
    expect(shadowSummon).toBeDefined();
    expect(shadowSummon).not.toBe(sourceTool);
    expect(shadowSummon.allowFromShadow).toBe(false);
  });

  it('standard 任务（无 payload）：prompt=intent、messages 缺省、resultTool 不覆盖', async () => {
    const registry = new ToolRegistryImpl();
    registry.register(makeRestrictedTool());
    const task = makeTask();
    mockRunSubagent.mockResolvedValue({ text: 'std ok' });

    await executeSubAgentTask(task, new AbortController().signal, makeDeps(registry));

    const callArgs = mockRunSubagent.mock.calls[0][0];
    expect(callArgs.prompt).toBe('do the thing');
    expect(callArgs.messages).toBeUndefined();
    expect(callArgs.resultTool).toBeUndefined();
    // 非 shadow 路径不应用受限覆盖（源实例原样）
    const summon = callArgs.registry.get('summon') as { allowFromShadow?: boolean };
    expect(summon.allowFromShadow).toBeUndefined();
  });
});
