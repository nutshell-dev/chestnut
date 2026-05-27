/**
 * SummonTool verify parameter tests
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
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `summon-verify-test-${randomUUID()}`);
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

function getTaskContent(task: Record<string, unknown>): string {
  if (Array.isArray(task.shadowMessages)) {
    const msgs = task.shadowMessages as Array<{ role: string; content: string }>;
    const lastMsg = msgs[msgs.length - 1];
    return lastMsg?.content ?? '';
  }
  if (typeof task.intent === 'string') {
    return task.intent;
  }
  return '';
}

describe('SummonTool verify parameter', () => {
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
    const auditWriter = {
      write: () => {},
    } as any;
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

  it('default verify=false: prompt does NOT contain verification section', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ goal: 'test' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);

    const content = getTaskContent(tasks[0]);
    expect(content).not.toContain('verification:');
    expect(content).not.toContain('escalation:');
    expect(content).not.toContain('prompt_file:');
  });

  it('explicit verify=true: prompt contains verification section', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ goal: 'test', verify: true }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);

    const content = getTaskContent(tasks[0]);
    expect(content).toContain('verification:');
    expect(content).toContain('escalation:');
    expect(content).toContain('prompt_file: verification/');
  });

  it('explicit verify=false behaves same as default', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ goal: 'test', verify: false }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);

    const content = getTaskContent(tasks[0]);
    expect(content).not.toContain('verification:');
    expect(content).not.toContain('escalation:');
    expect(content).not.toContain('prompt_file:');
  });
});
