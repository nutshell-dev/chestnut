/**
 * SummonTool verify parameter tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx() {
    const auditWriter = {
      write: () => {},
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as any;
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      // phase 1406: caller snapshot fixture (shadow path).
      getCallerSnapshot: async () => ({
        systemPrompt: 'mock system prompt',
        tools: [
          { name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } as any },
        ],
        messages: [],
      }),
    } as any);
    const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
    return { ctx, tool };
  }

  it('default verify=false: prompt does NOT contain verification section', async () => {
    const { ctx, tool } = makeCtx();
    const result = await tool.execute({ goal: 'test' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);

    const content = getTaskContent(tasks[0]);
    expect(content).not.toContain('prompt_file:');
    // verification: / escalation: 仅在禁令行出现（不出现 yaml 模板或 verification/.prompt.txt 格式段）
    const verificationMatches = content.match(/verification:/g);
    expect(verificationMatches?.length ?? 0).toBe(1);
    const escalationMatches = content.match(/escalation:/g);
    expect(escalationMatches?.length ?? 0).toBe(1);
  });

  it('explicit verify=true: prompt contains verification section', async () => {
    const { ctx, tool } = makeCtx();
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
    const { ctx, tool } = makeCtx();
    const result = await tool.execute({ goal: 'test', verify: false }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);

    const content = getTaskContent(tasks[0]);
    expect(content).not.toContain('prompt_file:');
    // verification: / escalation: 仅在禁令行出现（不出现 yaml 模板或 verification/.prompt.txt 格式段）
    const verificationMatches = content.match(/verification:/g);
    expect(verificationMatches?.length ?? 0).toBe(1);
    const escalationMatches = content.match(/escalation:/g);
    expect(escalationMatches?.length ?? 0).toBe(1);
  });
});
