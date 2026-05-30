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
    tool = new SummonTool();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(
    callerType: 'claw' | 'subagent' | 'dispatcher',
    options?: {
      originClawId?: string;
      clawId?: string;
      /** phase 1406: shadow snapshot fixture (caller deep state). */
      snapshot?: {
        systemPrompt?: string;
        tools?: Array<{ name: string; description: string; input_schema: unknown }>;
        messages?: Message[];
      };
    },
  ) {
    const auditWriter = {
      write: (type: string, ...args: unknown[]) => { auditEvents.push({ type, args }); },
    } as any;
    const ctx = new ExecContextImpl({
      clawId: options?.clawId ?? 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType,
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      originClawId: options?.originClawId,
      auditWriter,
      taskSystem: createMockTaskSystem(mockFs, auditWriter),
      getCallerSnapshot: async () => ({
        systemPrompt: options?.snapshot?.systemPrompt ?? 'mock system prompt',
        tools: (options?.snapshot?.tools ?? [
          { name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } },
        ]) as any,
        messages: options?.snapshot?.messages ?? [],
      }),
    } as any);
    return ctx;
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
      const ctx = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool();

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
      const ctx = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool();

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
      const ctx = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool();

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
      const customTool = new SummonTool();
      const ctx = makeCtx('claw', { snapshot: { systemPrompt: mockMotionPrompt, messages: motionDialog } });

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
      const customTool = new SummonTool();
      const ctx = makeCtx('claw', { snapshot: { systemPrompt: mockMotionPrompt } });
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

    async function writeSubAudit(taskId: string, rows: string[]): Promise<void> {
      const auditDir = path.join(tempDir, 'tasks', 'queues', 'results', taskId);
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(path.join(auditDir, 'audit.tsv'), rows.join('\n') + '\n');
    }

    function execOkRow(seq: number, summary: string): string {
      // mimic ToolExecutor audit row format (executor.ts:222-228 + escapeForLog)
      const escaped = summary.replace(/\n/g, '\\n').slice(0, 120);
      return `2026-05-30T06:00:00.000Z\tseq=${seq}\ttool_exec\texec\tok\telapsed_ms=100\tsummary=${escaped}`;
    }

    it('phase1466: 1 contract evidence → success summary + by-contract trigger written + no failure audit', async () => {
      const auditWriter = makeAuditWriter();
      await writeSubAudit('task-pp-test', [
        execOkRow(1, 'Contract created: 1780122465165-bcf86856 for claw filetool-auditor'),
      ]);
      const resultText = 'wj，已派出 filetool-auditor 去审查 L2c FileTool 模块！';
      const summary = await summonContractExtractPostProcessor(
        resultText,
        { id: 'task-pp-test', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', '1780122465165-bcf86856.json',
      );
      const raw = JSON.parse(await fs.readFile(byContractPath, 'utf-8'));
      expect(raw.contractId).toBe('1780122465165-bcf86856');
      expect(raw.targetClaw).toBe('filetool-auditor');
      expect(raw.mode).toBe('mining');
      expect(raw.miningTaskId).toBe('task-pp-test');

      expect(summary).toContain('wj，已派出 filetool-auditor');
      expect(summary).toContain('[CONTRACTS_CREATED]');
      expect(summary).toContain('1780122465165-bcf86856 (claw=filetool-auditor)');
      expect(summary).not.toContain('[SUMMON_SHADOW_FAILED');

      const failCalls = auditWriter.write.mock.calls.filter(
        (c: any) => c[0]?.startsWith('summon_'),
      );
      expect(failCalls).toHaveLength(0);
    });

    it('phase1466: N contracts evidence → N by-contract triggers, all independent', async () => {
      const auditWriter = makeAuditWriter();
      await writeSubAudit('task-multi', [
        execOkRow(1, 'Contract created: c1-aaa for claw claw-alpha'),
        execOkRow(5, 'Contract created: c2-bbb for claw claw-beta'),
      ]);

      const summary = await summonContractExtractPostProcessor(
        'Done.',
        { id: 'task-multi', callerType: 'shadow' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      const aPath = path.join(tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c1-aaa.json');
      const bPath = path.join(tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c2-bbb.json');
      const a = JSON.parse(await fs.readFile(aPath, 'utf-8'));
      const b = JSON.parse(await fs.readFile(bPath, 'utf-8'));
      expect(a.targetClaw).toBe('claw-alpha');
      expect(b.targetClaw).toBe('claw-beta');
      expect(a.mode).toBe('shadow');
      expect(a.shadowTaskId).toBe('task-multi');
      expect(summary).toContain('c1-aaa (claw=claw-alpha)');
      expect(summary).toContain('c2-bbb (claw=claw-beta)');
    });

    it('phase1466: subAudit file missing → fallthrough to failure wrap', async () => {
      const auditWriter = makeAuditWriter();
      // no writeSubAudit call → audit.tsv doesn't exist

      const result = await summonContractExtractPostProcessor(
        'Result text.',
        { id: 'task-no-audit', callerType: 'shadow' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_contract_created',
        'taskId=task-no-audit',
      );
      expect(result).toContain('[SUMMON_SHADOW_FAILED:no_contract_created]');
    });

    it('phase1466: malformed audit rows are skipped, valid rows still extracted', async () => {
      const auditWriter = makeAuditWriter();
      await writeSubAudit('task-mixed', [
        'malformed line with no tabs',
        '\t\t\t\t\t\t',  // empty cols
        execOkRow(1, 'Contract created: c-good for claw real-claw'),
        '2026-05-30T06:00:00.000Z\tseq=2\ttool_exec\texec\terr\telapsed_ms=10\tsummary=Some error',  // err status filtered
        '2026-05-30T06:00:00.000Z\tseq=3\ttool_exec\twrite\tok\telapsed_ms=5\tsummary=Contract created: fake for claw should-not-match',  // wrong tool name
      ]);

      const summary = await summonContractExtractPostProcessor(
        'Done.',
        { id: 'task-mixed', callerType: 'shadow' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      const goodPath = path.join(tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'c-good.json');
      const good = JSON.parse(await fs.readFile(goodPath, 'utf-8'));
      expect(good.contractId).toBe('c-good');

      const fakePath = path.join(tempDir, 'clawspace', 'pending-retrospective', 'by-contract', 'fake.json');
      await expect(fs.access(fakePath)).rejects.toThrow();  // not written

      expect(summary).toContain('c-good (claw=real-claw)');
      expect(summary).not.toContain('fake');
    });

    it('phase1466: writeByContract fail → audit WRITE_BY_CONTRACT_FAILED, evidence still drives success summary', async () => {
      const auditWriter = makeAuditWriter();
      await writeSubAudit('task-w-fail', [
        execOkRow(1, 'Contract created: c-failwrite for claw my-claw'),
      ]);
      const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockRejectedValue(new Error('disk full'));

      const summary = await summonContractExtractPostProcessor(
        'Done.',
        { id: 'task-w-fail', callerType: 'miner' } as any,
        false,
        mockFs,
        auditWriter as any,
      );

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_write_by_contract_failed',
        'contractId=c-failwrite',
        'error=disk full',
      );
      // evidence existed → still success summary (retro 失败不改判定 / 契约已真创建)
      expect(summary).toContain('[CONTRACTS_CREATED]');
      expect(summary).toContain('c-failwrite');

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
        // phase 1406: caller snapshot fixture with empty messages — verify
        // shadow path still emits no-dialog-context audit when caller messages=[].
        getCallerSnapshot: async () => ({
          systemPrompt: 'mock system prompt',
          tools: [],
          messages: [],
        }),
      } as any);

      await tool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_dialog_context',
      );
    });
  });
});
