/**
 * Phase 1166 — summon tool default mode: mining → shadow
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
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `summon-default-test-${randomUUID()}`);
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

describe('Phase 1166 — default mode shadow', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let tool: SummonTool;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    tool = new SummonTool(
      async () => 'mock system prompt',
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [],
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx() {
    const auditWriter = { write: vi.fn() } as any;
    return new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      taskSystem: createMockTaskSystem(mockFs, auditWriter),
    });
  }

  it('reverse 1 — 默认 mode 不传 mode 走 shadow 路径', async () => {
    const customTool = new SummonTool(
      async () => 'mock system prompt',
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ role: 'user', content: 'test' }],
    );
    const ctx = makeCtx();
    const result = await customTool.execute({ goal: 'test goal' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].callerType).toBe('shadow');
    expect(tasks[0].shadowMessages).toBeDefined();
    expect(tasks[0].systemPrompt).toBe('mock system prompt');
    expect(tasks[0].motionClawDir).toBeUndefined();
  });

  it('reverse 2 — 显式 mode: mining 仍走 mining 路径', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ goal: 'test goal', mode: 'mining' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].callerType).toBe('miner');
    expect(tasks[0].shadowMessages).toBeUndefined();
    expect(tasks[0].motionClawDir).toBeDefined();
  });

  it('reverse 3 — 显式 mode: shadow 仍走 shadow 路径', async () => {
    const customTool = new SummonTool(
      async () => 'mock system prompt',
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ role: 'user', content: 'test' }],
    );
    const ctx = makeCtx();
    const result = await customTool.execute({ goal: 'test goal', mode: 'shadow' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].callerType).toBe('shadow');
    expect(tasks[0].shadowMessages).toBeDefined();
    expect(tasks[0].systemPrompt).toBe('mock system prompt');
  });

  it('reverse 4 — description 含 shadow 默认字样、不含旧错误描述', () => {
    expect(tool.description).toContain('shadow（默认');
    expect(tool.schema.properties.mode.description).toContain("默认 'shadow'");
    expect(tool.description).not.toContain('mining（默认）');
    expect(tool.description).not.toContain('直接进入契约创建');
  });
});
