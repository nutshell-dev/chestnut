/**
 * phase 1866 Step F（SU-D6）：scheduler capability 最小化专测。
 *
 * - Summon 源码不出现 ATS 宽接口 `SubAgentTaskScheduler`（capability 为 summon 自有声明）；
 * - 行为等价：capability 收到的调度载荷逐字段与既有契约一致（taskKind='subagent'）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

const repoRoot = process.cwd();

/** 剥注释：只锁真实代码（capability 文档注释里可提及被收窄的旧类型名）。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('phase 1866 Step F: summon scheduler capability', () => {
  it('summon 源码不穿透 ATS 宽接口（capability 自有声明）', () => {
    const files = collectFiles(path.join(repoRoot, 'src', 'core', 'summon-system'));
    const offenders = files
      .filter((f) => stripComments(fsSync.readFileSync(f, 'utf8')).includes('SubAgentTaskScheduler'))
      .map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
    const types = fsSync.readFileSync(path.join(repoRoot, 'src/core/summon-system/types.ts'), 'utf8');
    expect(types).toContain('export interface SummonSchedulerCapability');
    expect(types).toMatch(/schedule\(taskKind: 'subagent', payload: SummonExecutionRequest\): Promise<ShortTaskId>/);
    // 载荷用 owner 的 typed 形状（禁 ad-hoc Record；phase 1358 ratchet 同向）
    expect(types).toContain("Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>");
    // 注释里可提及被禁止的 ad-hoc 形状；真实代码不得出现
    expect(stripComments(types)).not.toContain('Record<string, unknown>');
  });

  describe('调度载荷逐字段等价（capability 消费面）', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('execute 经 capability 提交 subagent 请求且字段集不变', async () => {
      const calls: Array<{ taskKind: string; payload: Record<string, unknown> }> = [];
      const capability = {
        schedule: vi.fn(async (taskKind: 'subagent', payload: Record<string, unknown>) => {
          calls.push({ taskKind, payload });
          return 'abcdef12';
        }),
      };
      const auditWriter = { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as never;
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter,
        getCallerSnapshot: async () => ({ systemPrompt: 'sp', tools: [], messages: [] }),
      } as never);

      const tool = new SummonTool({ scheduler: capability as never, correlation: { originClawId: 'origin-claw' } });
      const result = await tool.execute({ goal: 'do something' }, ctx);

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].taskKind).toBe('subagent');
      expect(Object.keys(calls[0].payload).sort()).toEqual([
        'correlation',
        'executorPayload',
        'intent',
        'kind',
        'maxSteps',
        'originClawId',
        'parentClawId',
        'postProcessor',
        'timeoutMs',
        'toolProfile',
      ]);
      expect(calls[0].payload.originClawId).toBe('origin-claw');
      expect(calls[0].payload.postProcessor).toBe('summon-contract-extract');
    });
  });
});
