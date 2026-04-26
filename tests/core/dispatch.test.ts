/**
 * DispatchTool tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { DispatchTool } from '../../src/core/runtime/dispatch.js';
import { ExecContextImpl } from '../../src/core/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { Message } from '../../src/types/message.js';

const { mockWriteFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
}));

vi.mock('../../src/core/task/tools/_pending-task-writer.js', () => ({
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
    mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
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
    const taskSystem = {
      addTaskResultHandler: vi.fn().mockReturnValue(() => {}),
    };
    tool.taskSystem = taskSystem as any;
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
      // describing 模式继承 dialog history
      expect(call.messages).toBeDefined();
      expect(call.messages.length).toBe(2);
      expect(call.messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(call.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
      expect(call.prompt).toContain('follow up');
    });

    it('should send single user message when ctx.dialogMessages is undefined (mining mode)', async () => {
      mockWriteFile.mockResolvedValue('task-single');
      const ctx = makeCtx('claw');

      await tool.execute({ goal: 'standalone task' }, ctx);

      expect(mockWriteFile).toHaveBeenCalled();
      const call = mockWriteFile.mock.calls[0][2];
      // mining mode: single user message with goal, no conversation history
      expect(call.messages).toBeDefined();
      expect(call.messages.length).toBe(1);
      expect(call.messages[0].role).toBe('user');
      expect(call.messages[0].content).toContain('standalone task');
      expect(call.prompt).toBe('');
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

  describe('CONTRACT_DONE handler', () => {
    function makeCtxWithAuditWriter(options?: { dialogMessages?: Message[] }) {
      mockWriteFile.mockResolvedValue('task-handler-test');
      let capturedHandler: ((taskId: string, callerType: string, result: string, isError: boolean) => Promise<string>) | null = null;
      const taskSystem = {
        addTaskResultHandler: vi.fn().mockImplementation((handler: any) => {
          capturedHandler = handler;
          return () => {};
        }),
      };
      tool.taskSystem = taskSystem as any;
      const auditWriter = { write: vi.fn() };
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as any,
        auditWriter: auditWriter as any,
        dialogMessages: options?.dialogMessages ?? [{ role: 'user' as const, content: 'test' }],
      });
      return { ctx, taskSystem, auditWriter, getHandler: () => capturedHandler };
    }

    it('should audit when dispatcher finishes without [CONTRACT_DONE] block', async () => {
      const { ctx, auditWriter, getHandler } = makeCtxWithAuditWriter();

      await tool.execute({ goal: 'test task' }, ctx);

      const handler = getHandler();
      expect(handler).not.toBeNull();

      await handler!('task-handler-test', 'dispatcher', 'Dispatcher finished with no marker.', false);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_not_found',
        'taskId=task-handler-test',
      );
    });

    it('should audit when [CONTRACT_DONE] parsed but fields missing', async () => {
      const { ctx, auditWriter, getHandler } = makeCtxWithAuditWriter();

      await tool.execute({ goal: 'test task' }, ctx);

      const handler = getHandler();
      await handler!(
        'task-handler-test',
        'dispatcher',
        'Done.\n[CONTRACT_DONE]{"targetClaw":"my-claw"}[/CONTRACT_DONE]',
        false,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_missing_fields',
        'taskId=task-handler-test',
        'contractId=missing',
        'targetClaw=my-claw',
      );
    });

    it('should write by-contract file and return summary on valid [CONTRACT_DONE]', async () => {
      const { ctx, auditWriter, getHandler } = makeCtxWithAuditWriter({ dialogMessages: [{ role: 'user' as const, content: 'test' }] });

      await tool.execute({ goal: 'test task' }, ctx);

      const handler = getHandler();
      const resultText = 'Work done.\n[CONTRACT_DONE]{"contractId":"c-001","targetClaw":"my-claw"}[/CONTRACT_DONE]';
      const summary = await handler!('task-handler-test', 'dispatcher', resultText, false);

      // by-contract 文件写入
      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c-001.json',
      );
      const raw = JSON.parse(await fs.readFile(byContractPath, 'utf-8'));
      expect(raw.contractId).toBe('c-001');
      expect(raw.targetClaw).toBe('my-claw');
      expect(raw.mode).toBe('mining');
      expect(raw.miningTaskId).toBe('task-handler-test');

      // 摘要不含 CONTRACT_DONE 块
      expect(summary).not.toContain('[CONTRACT_DONE]');
      expect(summary).toContain('Work done.');

      // 无 dispatch audit 事件（全是正常路径）
      const dispatchCalls = auditWriter.write.mock.calls.filter(
        (c: any) => c[0]?.startsWith('dispatch_'),
      );
      expect(dispatchCalls).toHaveLength(0);
    });

    it('should audit when [CONTRACT_DONE] JSON parse fails', async () => {
      const { ctx, auditWriter, getHandler } = makeCtxWithAuditWriter({ dialogMessages: [{ role: 'user' as const, content: 'test' }] });

      await tool.execute({ goal: 'test task' }, ctx);

      const handler = getHandler();
      await handler!(
        'task-handler-test',
        'dispatcher',
        'Done.\n[CONTRACT_DONE]{invalid json}[/CONTRACT_DONE]',
        false,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_contract_done_parse_failed',
        expect.stringContaining('raw='),
      );
    });

    it('should audit when writeByContract fails', async () => {
      const { ctx, auditWriter, getHandler } = makeCtxWithAuditWriter();

      // Mock fs.writeAtomic to throw
      const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockRejectedValue(new Error('disk full'));

      await tool.execute({ goal: 'test task' }, ctx);

      const handler = getHandler();
      await handler!(
        'task-handler-test',
        'dispatcher',
        '[CONTRACT_DONE]{"contractId":"c-002","targetClaw":"my-claw"}[/CONTRACT_DONE]',
        false,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'dispatch_write_by_contract_failed',
        'contractId=c-002',
        'error=disk full',
      );

      writeSpy.mockRestore();
    });

    it('should audit when loadSkills fails with non-ENOENT error', async () => {
      const auditWriter = { write: vi.fn() };
      const taskSystem = {
        addTaskResultHandler: vi.fn().mockReturnValue(() => {}),
      };
      tool.taskSystem = taskSystem as any;
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
      const taskSystem = {
        addTaskResultHandler: vi.fn().mockReturnValue(() => {}),
      };
      tool.taskSystem = taskSystem as any;
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
