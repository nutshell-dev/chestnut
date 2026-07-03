/**
 * spawn-shadow-subagent tests (phase 1185)
 * phase 800: V1/V2 参数化
 *
 * Coverage:
 * - 反向 1: 装配产 shadow task 含 mode='shadow' + intent 与 mode 对应
 * - 反向 2: shadowMessages 不含 task body 重复
 * - 反向 3: shadowIdPrefix 默认 'shadow' / summon 可定 'summon'
 * - 反向 4: postProcessor 透传
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { spawnShadowSubagent } from '../../../src/core/shadow-system/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { promises as fsp } from 'fs';  // phase 281: hoist 2 dyn fs imports
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function readPendingTasks(baseDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(baseDir, TASKS_QUEUES_PENDING_DIR);
  try {
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(async f => JSON.parse(await fsp.readFile(path.join(dir, f), 'utf-8'))));
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
  let taskSystem: ReturnType<typeof createMockTaskSystem>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    taskSystem = createMockTaskSystem(nodeFs, audit.audit);
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType: 'claw',
      fs: nodeFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-1',
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe.each([
    { mode: 'v1', useV1: true },
    { mode: 'v2', useV1: false },
  ])('($mode)', ({ useV1 }) => {
    beforeEach(() => {
      if (useV1) process.env.CHESTNUT_SHADOW_V1 = '1';
      else delete process.env.CHESTNUT_SHADOW_V1;
    });
    afterEach(() => { delete process.env.CHESTNUT_SHADOW_V1; });

    it('反向 1 — 装配产 shadow task 含 mode=shadow + intent 与 mode 对应', async () => {
      const mainMessages: Message[] = [{ role: 'user', content: 'prior' }];
      const toolsForLLM: ToolDefinition[] = [];

      const { taskId, shadowId } = await spawnShadowSubagent({
        task: 'do X',
        mainMessages,
        ctx,
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM,
        mode: useV1 ? 'v1' : 'v2',
      });

      expect(taskId).toBeDefined();
      expect(shadowId).toMatch(/^shadow-/);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.mode).toBe('shadow');
      expect(task.shadowMessages).toBeDefined();
      expect(task.intent).toBe(useV1 ? 'do X' : '');
      expect(task.intentPreview).toBeUndefined();
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
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM: [],
        mode: useV1 ? 'v1' : 'v2',
      });

      expect(taskId).toBeDefined();
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      const shadowMessages = tasks[0].shadowMessages as Array<{ role: string; content: unknown }>;
      expect(shadowMessages).toHaveLength(useV1 ? mainMessages.length + 1 : mainMessages.length);

      // task body 只出现 1 次（在 V1 SHADOW INSTRUCTION 内）/ 0 次（V2 无注入）
      const allContent = JSON.stringify(shadowMessages);
      const matches = allContent.split('unique-task-body-42').length - 1;
      expect(matches).toBe(useV1 ? 1 : 0);
    });

    it('反向 3 — shadowIdPrefix 默认 shadow / summon 可定 summon', async () => {
      const { shadowId: defaultId } = await spawnShadowSubagent({
        task: 't1',
        mainMessages: [],
        ctx,
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM: [],
        mode: useV1 ? 'v1' : 'v2',
      });
      expect(defaultId).toMatch(/^shadow-/);

      const { shadowId: summonId } = await spawnShadowSubagent({
        task: 't2',
        mainMessages: [],
        ctx,
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM: [],
        shadowIdPrefix: 'summon',
        mode: useV1 ? 'v1' : 'v2',
      });
      expect(summonId).toMatch(/^summon-/);
    });

    it('反向 4 — postProcessor 透传', async () => {
      await spawnShadowSubagent({
        task: 't3',
        mainMessages: [],
        ctx,
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM: [],
        postProcessor: 'summon-contract-extract',
        mode: useV1 ? 'v1' : 'v2',
      });

      const tasks = await readPendingTasks(tempDir);
      expect(tasks[0].postProcessor).toBe('summon-contract-extract');

      // 无 postProcessor → undefined
      await spawnShadowSubagent({
        task: 't4',
        mainMessages: [],
        ctx,
        taskSystem,
        systemPrompt: 'sp',
        toolsForLLM: [],
        mode: useV1 ? 'v1' : 'v2',
      });
      const tasks2 = await readPendingTasks(tempDir);
      const noPP = tasks2.find(t => (useV1 ? t.intent === 't4' : !t.intent && t.postProcessor === undefined));
      expect(noPP).toBeDefined();
      expect(noPP!.postProcessor).toBeUndefined();
    });
  });
});
