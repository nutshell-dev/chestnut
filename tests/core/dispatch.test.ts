/**
 * DispatchTool tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { DispatchTool } from '../../src/core/async-task-system/tools/dispatch.js';
import { buildMinerSystemPrompt } from '../../src/prompts/mining.js';
import { dispatchContractExtractPostProcessor } from '../../src/core/async-task-system/post-processors/dispatch-contract-extract.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { Message } from '../../src/types/message.js';

const { mockWriteFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
}));

vi.mock('../../src/core/async-task-system/tools/_pending-task-writer.js', () => ({
  writePendingSubagentTaskFile: mockWriteFile,
}));

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `dispatch-test-${randomUUID()}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('DispatchTool', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let tool: DispatchTool;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    tool = new DispatchTool(
      async () => 'mock system prompt',
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
    );
  });

  beforeEach(() => {
    mockWriteFile.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(callerType: 'claw' | 'subagent' | 'dispatcher', options?: { originClawId?: string; clawId?: string; dialogMessages?: Message[] }) {
    return new ExecContextImpl({
      clawId: options?.clawId ?? 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType,
      fs: mockFs,
      llm: {} as any,
      originClawId: options?.originClawId,
      dialogMessages: options?.dialogMessages,
    });
  }

  it('should allow dispatch when callerType is claw', async () => {
    mockWriteFile.mockResolvedValue('task-123');
    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'do something' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('task-123');
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('should pass postProcessor field to scheduleSubAgent', async () => {
    mockWriteFile.mockResolvedValue('task-pp');
    const ctx = makeCtx('claw');
    await tool.execute({ goal: 'test postProcessor' }, ctx);

    const call = mockWriteFile.mock.calls[0][2];
    expect(call.postProcessor).toBe('dispatch-contract-extract');
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

    mockWriteFile.mockResolvedValue('task-abc');
    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'generate report' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('task-abc');
  });

  it('should succeed without dispatch-skills directory', async () => {
    mockWriteFile.mockResolvedValue('task-xyz');
    const ctx = makeCtx('claw');
    const result = await tool.execute({ goal: 'some task' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('task-xyz');
  });

  describe('dialogMessages', () => {
    it('should include dialogMessages in dispatcherMessages when ctx.dialogMessages is set (describing mode)', async () => {
      const dialogMessages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      mockWriteFile.mockResolvedValue('task-dialog');
      const ctx = makeCtx('claw', { dialogMessages });

      await tool.execute({ goal: 'follow up', mode: 'describing' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      const call = mockWriteFile.mock.calls[0][2];
      expect(call.intent).toContain('follow up');
    });

    it('should capture dispatchToolUseId when dispatch is not the last tool_use block (multi tool_use)', async () => {
      const dialogMessages: Message[] = [
        { role: 'user', content: 'parallel call' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Dispatching and reading' },
            { type: 'tool_use', id: 'tu_dispatch_1', name: 'dispatch', input: { goal: 'x' } },
            { type: 'tool_use', id: 'tu_read_1', name: 'read_file', input: { path: 'a' } },
          ],
        },
      ];
      mockWriteFile.mockResolvedValue('task-multi');
      const ctx = makeCtx('claw', { dialogMessages });

      await tool.execute({ goal: 'follow up', mode: 'describing' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      const call = mockWriteFile.mock.calls[0][2];
      expect(call.intent).toContain('follow up');
    });

    it('should still capture dispatchToolUseId when dispatch is the last tool_use block (backward-compat)', async () => {
      const dialogMessages: Message[] = [
        { role: 'user', content: 'single call' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Dispatching' },
            { type: 'tool_use', id: 'tu_dispatch_2', name: 'dispatch', input: { goal: 'y' } },
          ],
        },
      ];
      mockWriteFile.mockResolvedValue('task-last');
      const ctx = makeCtx('claw', { dialogMessages });

      await tool.execute({ goal: 'follow up', mode: 'describing' }, ctx);

      const call = mockWriteFile.mock.calls[0][2];
      expect(call.intent).toContain('follow up');
    });

    it('should fallback to prompt when no dispatch tool_use exists in last assistant content (multi non-dispatch)', async () => {
      const dialogMessages: Message[] = [
        { role: 'user', content: 'no dispatch' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_read', name: 'read_file', input: { path: 'a' } },
          ],
        },
      ];
      mockWriteFile.mockResolvedValue('task-fallback');
      const ctx = makeCtx('claw', { dialogMessages });

      await tool.execute({ goal: 'follow up', mode: 'describing' }, ctx);

      const call = mockWriteFile.mock.calls[0][2];
      expect(call.intent).toContain('follow up');
    });

    it('should send single user message when ctx.dialogMessages is undefined (mining mode)', async () => {
      mockWriteFile.mockResolvedValue('task-single');
      const ctx = makeCtx('claw');

      await tool.execute({ goal: 'standalone task' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      const call = mockWriteFile.mock.calls[0][2];
      expect(call.intent).toContain('standalone task');
    });
  });

  describe('Phase 546 — dispatch systemPrompt 透传', () => {
    it('mining mode passes buildMinerSystemPrompt output to writePending', async () => {
      mockWriteFile.mockResolvedValue('task-mining');
      const ctx = makeCtx('claw');
      await tool.execute({ goal: 'mine intent', mode: 'mining' }, ctx);

      const call = mockWriteFile.mock.calls[0][2];
      expect(call.systemPrompt).toContain('意图挖掘');
    });

    it('describing mode passes Motion getSystemPrompt output', async () => {
      const mockMotionPrompt = 'MOTION_SYSTEM_PROMPT_FIXTURE';
      const customTool = new DispatchTool(
        async () => mockMotionPrompt,
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
        () => [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }],
      );
      mockWriteFile.mockResolvedValue('task-describing');
      const ctx = makeCtx('claw');
      await customTool.execute({ goal: 'describe intent', mode: 'describing' }, ctx);

      const call = mockWriteFile.mock.calls[0][2];
      expect(call.systemPrompt).toBe(mockMotionPrompt);
    });
  });

  describe('originClawId propagation', () => {
    it('should pass originClawId=motion when Motion calls dispatch', async () => {
      mockWriteFile.mockResolvedValue('task-motion');
      // Motion 调用：clawId='motion', originClawId=undefined
      const ctx = makeCtx('claw', { clawId: 'motion' });

      await tool.execute({ goal: 'do something' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockWriteFile.mock.calls[0][2].originClawId).toBe('motion');
    });

    it('should inherit originClawId when originClawId already set', async () => {
      mockWriteFile.mockResolvedValue('task-inherit');
      // 模拟 subagent with full profile，已有 originClawId='motion'
      const ctx = makeCtx('claw', {
        clawId: 'task-uuid',
        originClawId: 'motion',
      });

      await tool.execute({ goal: 'nested dispatch' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      // 应该继承，不被覆盖
      expect(mockWriteFile.mock.calls[0][2].originClawId).toBe('motion');
    });

    it('should use clawId as originClawId when originClawId not set', async () => {
      mockWriteFile.mockResolvedValue('task-claw');
      // claw 调用：clawId='claw1', originClawId=undefined
      const ctx = makeCtx('claw', { clawId: 'claw1' });

      await tool.execute({ goal: 'claw task' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      // 应该使用 clawId 作为 originClawId
      expect(mockWriteFile.mock.calls[0][2].originClawId).toBe('claw1');
    });
  });

  describe('dispatch-contract-extract postProcessor', () => {
    function makeAuditWriter() {
      return { write: vi.fn() };
    }

    it('should audit when dispatcher finishes without [CONTRACT_DONE] block', async () => {
      const auditWriter = makeAuditWriter();
      const result = await dispatchContractExtractPostProcessor(
        'Dispatcher finished with no marker.',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_not_found',
        'taskId=task-pp-test',
      );
      expect(result).toBe('Dispatcher finished with no marker.');
    });

    it('should audit when [CONTRACT_DONE] parsed but fields missing', async () => {
      const auditWriter = makeAuditWriter();
      const result = await dispatchContractExtractPostProcessor(
        'Done.\n[CONTRACT_DONE]{"targetClaw":"my-claw"}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'describer' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_missing_fields',
        'taskId=task-pp-test',
        'contractId=missing',
        'targetClaw=my-claw',
      );
      expect(result).toContain('[CONTRACT_DONE]');
    });

    it('should write by-contract file and return summary on valid [CONTRACT_DONE]', async () => {
      const auditWriter = makeAuditWriter();
      const resultText = 'Work done.\n[CONTRACT_DONE]{"contractId":"c-001","targetClaw":"my-claw"}[/CONTRACT_DONE]';
      const summary = await dispatchContractExtractPostProcessor(
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
        (c: any) => c[0]?.startsWith('dispatch_'),
      );
      expect(dispatchCalls).toHaveLength(0);
    });

    it('should derive mode=describing from callerType=describer', async () => {
      const auditWriter = makeAuditWriter();
      const resultText = '[CONTRACT_DONE]{"contractId":"c-desc","targetClaw":"claw-b"}[/CONTRACT_DONE]';
      await dispatchContractExtractPostProcessor(
        resultText,
        { id: 'task-desc', callerType: 'describer' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c-desc.json',
      );
      const raw = JSON.parse(await fs.readFile(byContractPath, 'utf-8'));
      expect(raw.mode).toBe('describing');
      expect(raw.describingTaskId).toBe('task-desc');
      expect(raw.miningTaskId).toBeUndefined();
    });

    it('should audit when [CONTRACT_DONE] JSON parse fails', async () => {
      const auditWriter = makeAuditWriter();
      await dispatchContractExtractPostProcessor(
        'Done.\n[CONTRACT_DONE]{invalid json}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_parse_failed',
        expect.stringContaining('raw='),
      );
    });

    it('should audit when writeByContract fails', async () => {
      const auditWriter = makeAuditWriter();
      const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockRejectedValue(new Error('disk full'));

      await dispatchContractExtractPostProcessor(
        '[CONTRACT_DONE]{"contractId":"c-002","targetClaw":"my-claw"}[/CONTRACT_DONE]',
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_write_by_contract_failed',
        'contractId=c-002',
        'error=disk full',
      );

      writeSpy.mockRestore();
    });

    it('should return result unchanged on error path (isError=true)', async () => {
      const auditWriter = makeAuditWriter();
      const result = await dispatchContractExtractPostProcessor(
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
        llm: {} as any,
        auditWriter: auditWriter as any,
        dialogMessages: [{ role: 'user' as const, content: 'test' }],
      });
      mockWriteFile.mockResolvedValue('task-skill-fail');

      await tool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_load_skills_failed',
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
        llm: {} as any,
        auditWriter: auditWriter as any,
        dialogMessages: [],
      });
      mockWriteFile.mockResolvedValue('task-empty-dialog');

      await tool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_no_dialog_context',
      );
    });
  });
});
