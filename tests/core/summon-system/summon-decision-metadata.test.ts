/**
 * phase 281 Step A: SummonDecision metadata embed tests.
 *
 * Verifies that shadow / mining summon schedule writes summonDecision metadata
 * directly into the async-task task file, eliminating the separate summon-state
 * write path while keeping the store for backwards compatibility in Step A.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { SubAgentTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `summon-decision-metadata-test-${randomUUID()}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

async function readPendingTasks(baseDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(baseDir, TASKS_QUEUES_PENDING_DIR);
  try {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(async f => JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return [];
  }
}

describe('summon decision metadata embed (phase 281 Step A)', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let auditEvents: Array<{ type: string; args: unknown[] }>;
  let tool: SummonTool;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditEvents = [];
    const auditWriter = {
      write: (type: string, ...args: unknown[]) => { auditEvents.push({ type, args }); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as any;
    tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx(
    callerType: 'claw' | 'subagent' | 'dispatcher',
    options?: {
      snapshot?: {
        systemPrompt?: string;
        tools?: Array<{ name: string; description: string; input_schema: unknown }>;
        messages?: Message[];
      };
    },
  ) {
    const auditWriter = {
      write: (type: string, ...args: unknown[]) => { auditEvents.push({ type, args }); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as any;
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType,
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      getCallerSnapshot: async () => ({
        systemPrompt: options?.snapshot?.systemPrompt ?? 'mock system prompt',
        tools: (options?.snapshot?.tools ?? [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }]) as any,
        messages: options?.snapshot?.messages ?? [],
      }),
    } as any);
    const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
    return { ctx, tool };
  }

  it('shadow summon schedule → task file含 summonDecision metadata', async () => {
    const { ctx, tool } = makeCtx('claw');
    const result = await tool.execute({ goal: 'shadow task', verify: true, targetClaw: 'target-claw' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].summonDecision).toMatchObject({
      schema_version: 1,
      mode: 'shadow',
      verify: true,
      targetClaw: 'target-claw',
    });
    expect(typeof (tasks[0].summonDecision as Record<string, unknown>).dispatchedAt).toBe('string');
  });

  it('mining summon schedule → task file含 summonDecision metadata', async () => {
    const { ctx, tool } = makeCtx('claw');
    const result = await tool.execute({ goal: 'mining task', mode: 'mining', verify: false, targetClaw: 'miner-claw' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].summonDecision).toMatchObject({
      schema_version: 1,
      mode: 'mining',
      verify: false,
      targetClaw: 'miner-claw',
    });
    expect(typeof (tasks[0].summonDecision as Record<string, unknown>).dispatchedAt).toBe('string');
  });

  it('non-summon 场景不存在 summonDecision 时字段为 undefined（optional）', async () => {
    // 本测试文件聚焦 summon path；这里仅验证 schema 不强制 summonDecision
    const parsed = SubAgentTaskSchema.safeParse({
      kind: 'subagent',
      mode: 'standard',
      id: 'task-1',
      intent: 'plain subagent',
      timeoutMs: 1000,
      parentClawId: 'p1',
      createdAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).summonDecision).toBeUndefined();
  });

  it('SubAgentTaskSchema validate summonDecision optional shape', () => {
    const valid = {
      kind: 'subagent',
      mode: 'shadow',
      id: 'task-1',
      intent: 'test',
      timeoutMs: 1000,
      parentClawId: 'p1',
      createdAt: new Date().toISOString(),
      shadowMessages: [{ role: 'user', content: 'hi' }],
      summonDecision: {
        schema_version: 1,
        mode: 'shadow',
        verify: true,
        targetClaw: 'tc',
        dispatchedAt: new Date().toISOString(),
      },
    };
    const parsed = SubAgentTaskSchema.safeParse(valid);
    expect(parsed.success).toBe(true);

    const invalid = {
      ...valid,
      summonDecision: {
        schema_version: 2,
        mode: 'invalid',
        verify: 'not-boolean',
        dispatchedAt: 123,
      },
    };
    const invalidParsed = SubAgentTaskSchema.safeParse(invalid);
    expect(invalidParsed.success).toBe(false);
  });


});
