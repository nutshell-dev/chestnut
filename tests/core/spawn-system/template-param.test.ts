/**
 * spawn tool template param tests (phase 11)
 *
 * Coverage:
 * - caller 不传 template → default 'default' resolve → systemPrompt = DEFAULT_SUBAGENT_SYSTEM_PROMPT
 * - caller 传 template:'default' → 同上
 * - caller 传 unknown template + async → reject 'spawn_template_unknown' + TEMPLATE_UNKNOWN audit + 不调 schedule
 * - caller 传 unknown template + async=false → reject + 不调 runSubagent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createSpawnTool } from '../../../src/core/spawn-system/tools/spawn.js';
import { SPAWN_AUDIT_EVENTS } from '../../../src/core/spawn-system/audit-events.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../../src/templates/prompts/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
}));

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

describe('spawn tool template param (phase 11)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let baseCtx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;
  let taskSystem: ReturnType<typeof createMockTaskSystem>;
  let spawnToolWithTaskSystem: ReturnType<typeof createSpawnTool>;
  const testSpawnTool = createSpawnTool({ runSubagent: mockRunSubagent });

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

  describe('default template resolve', () => {
    it("caller 不传 template → schedule params.systemPrompt = DEFAULT_SUBAGENT_SYSTEM_PROMPT", async () => {
      mockSchedule.mockResolvedValue('task-aaa');

      const result = await spawnToolWithTaskSystem.execute({ intent: 'test task' }, baseCtx);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalledOnce();
      const [taskKind, params] = mockSchedule.mock.calls[0];
      expect(taskKind).toBe('subagent');
      expect(params.systemPrompt).toBe(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
    });

    it("caller 传 template:'default' → 行为同不传", async () => {
      mockSchedule.mockResolvedValue('task-bbb');

      const result = await spawnToolWithTaskSystem.execute(
        { intent: 'test task', template: 'default' },
        baseCtx,
      );

      expect(result.success).toBe(true);
      const [, params] = mockSchedule.mock.calls[0];
      expect(params.systemPrompt).toBe(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
    });

    it("sync 路径 default template 透传 systemPrompt 进 runSubagent", async () => {
      mockRunSubagent.mockResolvedValue({ text: 'sync ok' });

      const result = await testSpawnTool.execute(
        { intent: 'test', async: false, template: 'default' },
        baseCtx,
      );

      expect(result.success).toBe(true);
      const callArgs = mockRunSubagent.mock.calls[0][0];
      expect(callArgs.systemPrompt).toBe(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
    });
  });

  describe('unknown template reject', () => {
    it("async 模式 unknown template → reject + audit + 不调 schedule", async () => {
      const result = await spawnToolWithTaskSystem.execute(
        { intent: 'test', template: 'nonexistent' },
        baseCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn_template_unknown');
      expect(result.content).toContain("unknown template: 'nonexistent'");
      expect(result.content).toContain('Available: default');
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockRunSubagent).not.toHaveBeenCalled();

      const types = audit.events.map((e) => e[0]);
      expect(types).toContain(SPAWN_AUDIT_EVENTS.TEMPLATE_UNKNOWN);
      const templateUnknownEvent = audit.events.find(
        (e) => e[0] === SPAWN_AUDIT_EVENTS.TEMPLATE_UNKNOWN,
      );
      expect(templateUnknownEvent).toBeDefined();
      expect(templateUnknownEvent![1]).toBe('nonexistent');
      expect(templateUnknownEvent![2]).toBe('default');
    });

    it("sync 模式 unknown template → reject + 不调 runSubagent", async () => {
      const result = await testSpawnTool.execute(
        { intent: 'test', template: 'nonexistent', async: false },
        baseCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn_template_unknown');
      expect(mockRunSubagent).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();

      const types = audit.events.map((e) => e[0]);
      expect(types).toContain(SPAWN_AUDIT_EVENTS.TEMPLATE_UNKNOWN);
    });
  });

  describe('shadow defense order vs template', () => {
    it("restricted allowAsync=false + async=true reject 优先于 unknown template reject", async () => {
      const restrictedSpawnTool = createSpawnTool({ taskSystem, allowAsync: false });

      const result = await restrictedSpawnTool.execute(
        { intent: 'test', async: true, template: 'nonexistent' },
        baseCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_async_spawn_rejected');

      const types = audit.events.map((e) => e[0]);
      expect(types).not.toContain(SPAWN_AUDIT_EVENTS.TEMPLATE_UNKNOWN);
    });
  });
});
