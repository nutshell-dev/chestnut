/**
 * spawn-shadow-subagent tests (phase 1185)
 *
 * Coverage:
 * - 反向 1: 装配产 shadow task 含 mode='shadow' + 无 intent 字段
 * - 反向 2: shadowMessages 不含 task body 重复
 * - 反向 3: shadowIdPrefix 默认 'shadow' / summon 可定 'summon'
 * - 反向 4: postProcessor 透传
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { spawnShadowSubagent } from '../../../src/core/shadow-system/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function readPendingTasks(baseDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(baseDir, TASKS_QUEUES_PENDING_DIR);
  try {
    const files = (await import('fs').then(m => m.promises.readdir(dir))).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(async f => JSON.parse(await import('fs').then(m => m.promises.readFile(path.join(dir, f), 'utf-8')))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return [];
  }
}

describe('spawnShadowSubagent (phase 1185)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: nodeFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-1',
      originClawId: 'motion',
      taskSystem: createMockTaskSystem(nodeFs, audit.audit),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('反向 1 — 装配产 shadow task 含 mode=shadow + 无 intent 字段', async () => {
    const mainMessages: Message[] = [{ role: 'user', content: 'prior' }];
    const toolsForLLM: ToolDefinition[] = [];

    const { taskId, shadowId } = await spawnShadowSubagent({
      task: 'do X',
      mainMessages,
      ctx,
      systemPrompt: 'sp',
      toolsForLLM,
    });

    expect(taskId).toBeDefined();
    expect(shadowId).toMatch(/^shadow-/);

    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.mode).toBe('shadow');
    expect(task.shadowMessages).toBeDefined();
    expect(task.intentPreview).toBe('do X');
    expect(task.intent).toBeUndefined();
  });

  it('反向 2 — shadowMessages 不含 task body 重复', async () => {
    const mainMessages: Message[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
    ];

    const { taskId } = await spawnShadowSubagent({
      task: 'unique-task-body-42',
      mainMessages,
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
    });

    expect(taskId).toBeDefined();
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    const shadowMessages = tasks[0].shadowMessages as Array<{ role: string; content: unknown }>;
    expect(shadowMessages).toHaveLength(mainMessages.length + 1); // +1 SHADOW INSTRUCTION

    // task body 只出现 1 次（在 SHADOW INSTRUCTION 内）
    const allContent = JSON.stringify(shadowMessages);
    const matches = allContent.split('unique-task-body-42').length - 1;
    expect(matches).toBe(1);
  });

  it('反向 3 — shadowIdPrefix 默认 shadow / summon 可定 summon', async () => {
    const { shadowId: defaultId } = await spawnShadowSubagent({
      task: 't1',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
    });
    expect(defaultId).toMatch(/^shadow-/);

    const { shadowId: summonId } = await spawnShadowSubagent({
      task: 't2',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
      shadowIdPrefix: 'summon',
    });
    expect(summonId).toMatch(/^summon-/);
  });

  it('反向 4 — postProcessor 透传', async () => {
    await spawnShadowSubagent({
      task: 't3',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
      postProcessor: 'summon-contract-extract',
    });

    const tasks = await readPendingTasks(tempDir);
    expect(tasks[0].postProcessor).toBe('summon-contract-extract');

    // 无 postProcessor → undefined
    await spawnShadowSubagent({
      task: 't4',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
    });
    const tasks2 = await readPendingTasks(tempDir);
    const noPP = tasks2.find(t => t.intentPreview === 't4');
    expect(noPP).toBeDefined();
    expect(noPP!.postProcessor).toBeUndefined();
  });
});
