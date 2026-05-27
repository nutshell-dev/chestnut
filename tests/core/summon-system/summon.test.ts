/**
 * SummonTool tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { buildMinerSystemPrompt } from '../../../src/prompts/mining.js';
import { summonContractExtractPostProcessor } from '../../../src/core/summon-system/post-processors/contract-extract.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `summon-test-${randomUUID()}`);
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

describe('SummonTool', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let auditEvents: Array<{ type: string; args: unknown[] }>;
  let tool: SummonTool;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditEvents = [];
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

  function makeCtx(callerType: 'claw' | 'subagent' | 'dispatcher', options?: { originClawId?: string; clawId?: string }) {
    const auditWriter = {
      write: (type: string, ...args: unknown[]) => { auditEvents.push({ type, args }); },
    } as any;
    return new ExecContextImpl({
      clawId: options?.clawId ?? 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType,
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      originClawId: options?.originClawId,
      auditWriter,
      taskSystem: createMockTaskSystem(mockFs, auditWriter),
    });
  }

  it('should allow summon when callerType is claw', async () => {
    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'do something' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      intentPreview: expect.stringContaining('do something'),
      kind: 'subagent',
      mode: 'shadow',
    });
    expect(result.content).toContain(tasks[0].id);
    expect(auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toBeDefined();
  });

  it('should pass postProcessor field to scheduleSubAgent', async () => {
    const ctx = makeCtx('claw');
    await tool.execute({ goal: 'test postProcessor' }, ctx);

    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].postProcessor).toBe('summon-contract-extract');
    expect(auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toBeDefined();
  });

  it('should succeed when dispatch-skills directory exists', async () => {
    await fs.mkdir(path.join(tempDir, 'clawspace', 'dispatch-skills', 'gen-report'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'clawspace', 'dispatch-skills', 'gen-report', 'SKILL.md'),
      `---
name: gen-report
description: 生成分析报告
---
# Gen Report
Content.
`
    );

    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'generate report' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(result.content).toContain(tasks[0].id);
    expect(auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toBeDefined();
  });

  it('should succeed without dispatch-skills directory', async () => {
    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'some task' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(result.content).toContain(tasks[0].id);
  });

  describe('shadowMessages', () => {
    it('shadow mode: shadowMessages 含 SHADOW INSTRUCTION 锚 + contractTaskBody', async () => {
      const motionDialog: Message[] = [
        { role: 'user', content: '帮我审计 L1 FileSystem 模块' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好的、我来 summon' },
            { type: 'tool_use', id: 'tu-summon-1', name: 'summon', input: { goal: 'audit L1 FileSystem', mode: 'shadow' } },
          ] as unknown as string,
        },
      ];
      const ctx = makeCtx('claw');
      const customTool = new SummonTool(
        async () => 'mock system prompt',
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => motionDialog,
      );

      await customTool.execute({ goal: 'audit L1 FileSystem', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].shadowMessages).toBeDefined();
      // stripped motion dialog (1 msg) + SHADOW INSTRUCTION user msg = 2
      expect(tasks[0].shadowMessages.length).toBeGreaterThanOrEqual(2);
      const lastMsg = tasks[0].shadowMessages[tasks[0].shadowMessages.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('SHADOW INSTRUCTION');
      expect(lastMsg.content).toContain('shadow_id: summon-');
      expect(lastMsg.content).toContain('## 本次目标');
      expect(tasks[0].intentPreview).toContain('audit L1 FileSystem');
    });

    it('shadow mode: 末条 assistant tool_use 时 strip + SHADOW INSTRUCTION', async () => {
      const motionDialog: Message[] = [
        { role: 'user', content: '帮我创建 foo claw 的契约' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好的、我来 summon' },
            { type: 'tool_use', id: 'tu-summon-1', name: 'summon', input: { goal: 'create foo contract', mode: 'shadow' } },
          ] as unknown as string,
        },
      ];
      const ctx = makeCtx('claw');
      const customTool = new SummonTool(
        async () => 'mock system prompt',
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => motionDialog,
      );

      await customTool.execute({ goal: 'create foo contract', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].shadowMessages).toBeDefined();
      // strip 后 1 msg + SHADOW INSTRUCTION = 2
      expect(tasks[0].shadowMessages).toHaveLength(2);
      expect(tasks[0].shadowMessages[0]).toEqual({ role: 'user', content: '帮我创建 foo claw 的契约' });
      const lastMsg = tasks[0].shadowMessages[tasks[0].shadowMessages.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('SHADOW INSTRUCTION');
    });

    it('shadow mode: 末条不是 assistant tool_use 时不 strip', async () => {
      const motionDialog: Message[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ];
      const ctx = makeCtx('claw');
      const customTool = new SummonTool(
        async () => 'mock system prompt',
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => motionDialog,
      );

      await customTool.execute({ goal: 'follow up', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 2 msgs + SHADOW INSTRUCTION = 3
      expect(tasks[0].shadowMessages).toHaveLength(3);
      expect(tasks[0].shadowMessages[0]).toEqual({ role: 'user', content: 'hi' });
      expect(tasks[0].shadowMessages[1]).toEqual({ role: 'assistant', content: 'hello' });
      expect(tasks[0].shadowMessages[2].role).toBe('user');
      expect(tasks[0].shadowMessages[2].content).toContain('SHADOW INSTRUCTION');
    });

    it('shadow mode: dialogMessages 为空时 shadowMessages = [SHADOW INSTRUCTION]', async () => {
      const ctx = makeCtx('claw');

      await tool.execute({ goal: 'empty dialog', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].shadowMessages).toHaveLength(1);
      expect(tasks[0].shadowMessages[0].role).toBe('user');
      expect(tasks[0].shadowMessages[0].content).toContain('SHADOW INSTRUCTION');
    });

    it('mining mode: shadowMessages = undefined（保 mining 不动 + AskMotionTool 主导 context）', async () => {
      const ctx = makeCtx('claw');

      await tool.execute({ goal: 'mine intent', mode: 'mining' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].shadowMessages).toBeUndefined();
      expect(tasks[0].motionClawDir).toBeDefined();
    });

    it('design contract: shadow mode summon 子代理 ≡ shadow tool 子代理（继承 motion 快照 systemPrompt+tools+dialog）', async () => {
      const mockMotionPrompt = 'MOTION_SYSTEM_PROMPT_FIXTURE';
      const motionDialog: Message[] = [
        { role: 'user', content: 'test' },
      ];
      const customTool = new SummonTool(
        async () => mockMotionPrompt,
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => motionDialog,
      );
      const ctx = makeCtx('claw');

      await customTool.execute({ goal: 'describe intent', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].systemPrompt).toBe(mockMotionPrompt);
      expect(tasks[0].shadowMessages).toBeDefined();
      expect(tasks[0].callerType).toBe('shadow');
    });
  });

  describe('Phase 546 — summon systemPrompt 透传', () => {
    it('mining mode passes buildMinerSystemPrompt output to writePending', async () => {
      const ctx = makeCtx('claw');
      await tool.execute({ goal: 'mine intent', mode: 'mining' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].systemPrompt).toContain('意图挖掘');
    });

    it('shadow mode passes Motion getSystemPrompt output', async () => {
      const mockMotionPrompt = 'MOTION_SYSTEM_PROMPT_FIXTURE';
      const customTool = new SummonTool(
        async () => mockMotionPrompt,
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [],
      );
      const ctx = makeCtx('claw');
      await customTool.execute({ goal: 'describe intent', mode: 'shadow' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].systemPrompt).toBe(mockMotionPrompt);
    });
  });

  describe('originClawId propagation', () => {
    it('should pass originClawId=motion when Motion calls summon', async () => {
      // Motion 调用：clawId='motion', originClawId=undefined
      const ctx = makeCtx('claw', { clawId: 'motion' });

      await tool.execute({ goal: 'do something' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        originClawId: 'motion',
      });
    });

    it('should inherit originClawId when originClawId already set', async () => {
      // 模拟 subagent with full profile，已有 originClawId='motion'
      const ctx = makeCtx('claw', {
        clawId: 'task-uuid',
        originClawId: 'motion',
      });

      await tool.execute({ goal: 'nested summon' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 应该继承，不被覆盖
      expect(tasks[0]).toMatchObject({
        originClawId: 'motion',
      });
    });

    it('should use clawId as originClawId when originClawId not set', async () => {
      // claw 调用：clawId='claw1', originClawId=undefined
      const ctx = makeCtx('claw', { clawId: 'claw1' });

      await tool.execute({ goal: 'claw task' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 应该使用 clawId 作为 originClawId
      expect(tasks[0]).toMatchObject({
        originClawId: 'claw1',
      });
    });
  });

  describe('summon-contract-extract postProcessor', () => {
    function makeAuditWriter() {
      return { write: vi.fn() };
    }

    it('should audit when dispatcher finishes without [CONTRACT_DONE] block', async () => {
      const auditWriter = makeAuditWriter();
      const result = await summonContractExtractPostProcessor(
        'Dispatcher finished with no marker.',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_contract_done_not_found',
        'taskId=task-pp-test',
      );
      expect(result).toBe('Dispatcher finished with no marker.');
    });

    it('should audit when [CONTRACT_DONE] parsed but fields missing', async () => {
      const auditWriter = makeAuditWriter();
      const result = await summonContractExtractPostProcessor(
        'Done.\n[CONTRACT_DONE]{"targetClaw":"my-claw"}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'shadow' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_contract_done_missing_fields',
        'taskId=task-pp-test',
        'contractId=missing',
        'targetClaw=my-claw',
      );
      expect(result).toContain('[CONTRACT_DONE]');
    });

    it('should write by-contract file and return summary on valid [CONTRACT_DONE]', async () => {
      const auditWriter = makeAuditWriter();
      const resultText = 'Work done.\n[CONTRACT_DONE]{"contractId":"c-001","targetClaw":"my-claw"}[/CONTRACT_DONE]';
      const summary = await summonContractExtractPostProcessor(
        resultText,
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      // by-contract 文件写入
      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c-001.json',
      );
      const raw = JSON.parse(await fs.readFile(byContractPath, 'utf-8'));
      expect(raw.contractId).toBe('c-001');
      expect(raw.targetClaw).toBe('my-claw');
      expect(raw.mode).toBe('mining');
      expect(raw.miningTaskId).toBe('task-pp-test');

      // 摘要不含 CONTRACT_DONE 块
      expect(summary).not.toContain('[CONTRACT_DONE]');
      expect(summary).toContain('Work done.');

      // 无 dispatch audit 事件（全是正常路径）
      const dispatchCalls = auditWriter.write.mock.calls.filter(
        (c: any) => c[0]?.startsWith('summon_'),
      );
      expect(dispatchCalls).toHaveLength(0);
    });

    it('should derive mode=shadow from callerType=shadow', async () => {
      const auditWriter = makeAuditWriter();
      const resultText = '[CONTRACT_DONE]{"contractId":"c-desc","targetClaw":"claw-b"}[/CONTRACT_DONE]';
      await summonContractExtractPostProcessor(
        resultText,
        { id: 'task-desc', callerType: 'shadow' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c-desc.json',
      );
      const raw = JSON.parse(await fs.readFile(byContractPath, 'utf-8'));
      expect(raw.mode).toBe('shadow');
      expect(raw.shadowTaskId).toBe('task-desc');
      expect(raw.miningTaskId).toBeUndefined();
    });

    it('should audit when [CONTRACT_DONE] JSON parse fails', async () => {
      const auditWriter = makeAuditWriter();
      await summonContractExtractPostProcessor(
        'Done.\n[CONTRACT_DONE]{invalid json}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_contract_done_parse_failed',
        expect.stringContaining('raw='),
      );
    });

    it('should audit when writeByContract fails', async () => {
      const auditWriter = makeAuditWriter();
      const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockRejectedValue(new Error('disk full'));

      await summonContractExtractPostProcessor(
        '[CONTRACT_DONE]{"contractId":"c-002","targetClaw":"my-claw"}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_write_by_contract_failed',
        'contractId=c-002',
        'error=disk full',
      );

      writeSpy.mockRestore();
    });

    it('should return result unchanged on error path (isError=true)', async () => {
      const auditWriter = makeAuditWriter();
      const result = await summonContractExtractPostProcessor(
        'some error result',
        { id: 'task-err', callerType: 'miner' } as any,
        true,
        mockFs,
        auditWriter as any,
      );

      expect(result).toBe('some error result');
      expect(auditWriter.write).not.toHaveBeenCalled();
    });
  });



  describe('audit events', () => {
    it('should audit when loadSkills fails with non-ENOENT error', async () => {
      const auditWriter = { write: vi.fn() };
      const existsSpy = vi.spyOn(mockFs, 'exists').mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter: auditWriter as any,
        taskSystem: createMockTaskSystem(mockFs, auditWriter as any),
      });

      await tool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_load_skills_failed',
        'error=Error: permission denied',
      );

      existsSpy.mockRestore();
    });

    it('should audit when dialogMessages is empty', async () => {
      const auditWriter = { write: vi.fn() };
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter: auditWriter as any,
        taskSystem: createMockTaskSystem(mockFs, auditWriter as any),
      });

      await tool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_dialog_context',
      );
    });
  });
});
