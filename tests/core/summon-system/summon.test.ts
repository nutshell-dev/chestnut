/**
 * SummonTool tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';

import { createSummonContractExtractPostProcessor } from '../../../src/core/summon-system/post-processors/contract-extract.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';

async function createTempDir(): Promise<string> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

/** phase 1863 (AT-D7)：shadow 语义在 owner payload（executorPayload）内，ATS 侧无顶层 shadow 字段。 */
function payloadOf(task: Record<string, unknown>): Record<string, unknown> {
  return task.executorPayload as Record<string, unknown>;
}
function payloadMessages(task: Record<string, unknown>): Array<{ role: string; content: string }> {
  return payloadOf(task).messages as Array<{ role: string; content: string }>;
}

describe('SummonTool', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let auditEvents: Array<{ type: string; args: unknown[] }>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CHESTNUT_SHADOW_V1;  // ensure summon always V1 regardless of env
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditEvents = [];
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx(
    callerType: 'claw' | 'subagent' | 'dispatcher',
    options?: {
      clawId?: string;
      /** phase 761: SummonTool originClawId DI */
      toolOriginClawId?: string;
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
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as any;
    const ctx = new ExecContextImpl({
      clawId: options?.clawId ?? 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      callerType,
      fs: mockFs,
      llm: {} as unknown as LLMOrchestrator,
      auditWriter,
      getCallerSnapshot: async () => ({
        systemPrompt: options?.snapshot?.systemPrompt ?? 'mock system prompt',
        tools: (options?.snapshot?.tools ?? [
          { name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } },
        ]) as any,
        messages: options?.snapshot?.messages ?? [],
      }),
    } as any);
    const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter), options?.toolOriginClawId);
    return { ctx, tool };
  }

  it('should allow summon when callerType is claw', async () => {
    const { ctx, tool } = makeCtx('claw');
    const result = await tool.execute({ goal: 'do something' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      intent: expect.stringContaining('do something'),
      kind: 'subagent',
    });
    expect(payloadOf(tasks[0])).toBeDefined();
    expect(result.content).toContain(tasks[0].id);
    expect(auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toBeDefined();
  });

  it('phase 1396 Step C: accepted content 只表示 async accepted，不宣称创建成功', async () => {
    const { ctx, tool } = makeCtx('claw');
    const result = await tool.execute({ goal: 'do something' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Summon accepted. Task ID:');
    expect(result.content).not.toContain('dispatched');
    expect(result.content).not.toContain('to create contract');
    expect(result.content).not.toContain('Summon subagent started');
  });

  it('should pass postProcessor field to scheduleSubAgent', async () => {
    const { ctx, tool } = makeCtx('claw');
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

    const { ctx, tool } = makeCtx('claw');
    const result = await tool.execute({ goal: 'generate report' }, ctx);

    expect(result.success).toBe(true);
    const tasks = await readPendingTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(result.content).toContain(tasks[0].id);
    expect(auditEvents.find(e => e.type === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toBeDefined();
  });

  it('should succeed without dispatch-skills directory', async () => {
    const { ctx, tool } = makeCtx('claw');
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
            { type: 'tool_use', id: 'tu-summon-1', name: 'summon', input: { goal: 'audit L1 FileSystem' } },
          ] as unknown as string,
        },
      ];
      const { ctx, tool } = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));

      await customTool.execute({ goal: 'audit L1 FileSystem' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadMessages(tasks[0])).toBeDefined();
      // stripped motion dialog (1 msg) + SHADOW INSTRUCTION user msg = 2
      expect(payloadMessages(tasks[0]).length).toBeGreaterThanOrEqual(2);
      const lastMsg = payloadMessages(tasks[0])[payloadMessages(tasks[0]).length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('SHADOW INSTRUCTION');
      expect(lastMsg.content).toContain('shadow_id: summon-');
      expect(lastMsg.content).toContain('## 本次目标');
      expect(tasks[0].intent).toContain('audit L1 FileSystem');
    });

    it('shadow mode: 末条 assistant tool_use 时 strip + SHADOW INSTRUCTION', async () => {
      const motionDialog: Message[] = [
        { role: 'user', content: '帮我创建 foo claw 的契约' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好的、我来 summon' },
            { type: 'tool_use', id: 'tu-summon-1', name: 'summon', input: { goal: 'create foo contract' } },
          ] as unknown as string,
        },
      ];
      const { ctx, tool } = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));

      await customTool.execute({ goal: 'create foo contract' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadMessages(tasks[0])).toBeDefined();
      // strip 后 1 msg + SHADOW INSTRUCTION = 2
      expect(payloadMessages(tasks[0])).toHaveLength(2);
      expect(payloadMessages(tasks[0])[0]).toEqual({ role: 'user', content: '帮我创建 foo claw 的契约' });
      const lastMsg = payloadMessages(tasks[0])[payloadMessages(tasks[0]).length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('SHADOW INSTRUCTION');
    });

    it('shadow mode: 末条不是 assistant tool_use 时不 strip', async () => {
      const motionDialog: Message[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ];
      const { ctx, tool } = makeCtx('claw', { snapshot: { messages: motionDialog } });
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));

      await customTool.execute({ goal: 'follow up' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 2 msgs + SHADOW INSTRUCTION = 3
      expect(payloadMessages(tasks[0])).toHaveLength(3);
      expect(payloadMessages(tasks[0])[0]).toEqual({ role: 'user', content: 'hi' });
      expect(payloadMessages(tasks[0])[1]).toEqual({ role: 'assistant', content: 'hello' });
      expect(payloadMessages(tasks[0])[2].role).toBe('user');
      expect(payloadMessages(tasks[0])[2].content).toContain('SHADOW INSTRUCTION');
    });

    it('shadow mode: dialogMessages 为空时 shadowMessages = [SHADOW INSTRUCTION]', async () => {
      const { ctx, tool } = makeCtx('claw');

      await tool.execute({ goal: 'empty dialog' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadMessages(tasks[0])).toHaveLength(1);
      expect(payloadMessages(tasks[0])[0].role).toBe('user');
      expect(payloadMessages(tasks[0])[0].content).toContain('SHADOW INSTRUCTION');
    });

    it('phase 1396 Step C: mining 模式不再是公开路径，execute 始终走 shadow', async () => {
      const { ctx, tool } = makeCtx('claw');

      // 即使传入 legacy mode 参数也被忽略（schema additionalProperties=false 由 LLM 侧拦截）
      await tool.execute({ goal: 'mine intent' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadMessages(tasks[0])).toBeDefined();
      expect(tasks[0].callerType).toBe('shadow_subagent');
      expect(tasks[0].motionClawDir).toBeUndefined();
    });

    it('design contract: shadow mode summon 子代理 ≡ shadow tool 子代理（继承 motion 快照 systemPrompt+tools+dialog）', async () => {
      const mockMotionPrompt = 'MOTION_SYSTEM_PROMPT_FIXTURE';
      const motionDialog: Message[] = [
        { role: 'user', content: 'test' },
      ];
      const { ctx, tool } = makeCtx('claw', { snapshot: { systemPrompt: mockMotionPrompt, messages: motionDialog } });
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));

      await customTool.execute({ goal: 'describe intent' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadOf(tasks[0]).systemPrompt).toBe(mockMotionPrompt);
      expect(payloadMessages(tasks[0])).toBeDefined();
      expect(tasks[0].callerType).toBe('shadow_subagent');
    });
  });

  describe('Phase 546 — summon systemPrompt 透传', () => {
    it('shadow mode passes Motion getSystemPrompt output', async () => {
      const mockMotionPrompt = 'MOTION_SYSTEM_PROMPT_FIXTURE';
      const { ctx, tool } = makeCtx('claw', { snapshot: { systemPrompt: mockMotionPrompt } });
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));
      await customTool.execute({ goal: 'describe intent' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(payloadOf(tasks[0]).systemPrompt).toBe(mockMotionPrompt);
    });
  });

  describe('originClawId propagation (phase 761: via SummonTool DI)', () => {
    it('should pass originClawId=motion when Motion calls summon', async () => {
      // Motion 调用：clawId='motion'，SummonTool DI 注入 originClawId='motion'
      const { ctx, tool } = makeCtx('claw', { clawId: 'motion', toolOriginClawId: 'motion' });

      await tool.execute({ goal: 'do something' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        originClawId: 'motion',
      });
    });

    it('should use DI originClawId even when clawId differs', async () => {
      // 模拟子代理 clawId='task-uuid'，但 SummonTool DI 指定源头为 'motion'
      const { ctx, tool } = makeCtx('claw', {
        clawId: 'task-uuid',
        toolOriginClawId: 'motion',
      });

      await tool.execute({ goal: 'nested summon' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // DI 指定的 originClawId 优先，不被 clawId 覆盖
      expect(tasks[0]).toMatchObject({
        originClawId: 'motion',
      });
    });

    it('should use clawId as originClawId when DI originClawId not set', async () => {
      // claw 调用：clawId='claw1'，SummonTool 未注入 originClawId
      const { ctx, tool } = makeCtx('claw', { clawId: 'claw1' });

      await tool.execute({ goal: 'claw task' }, ctx);

      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 无 DI 时回退到 ctx.clawId
      expect(tasks[0]).toMatchObject({
        originClawId: 'claw1',
      });
    });
  });

  describe('summon-contract-extract postProcessor (phase 1396 Step B: claim authority)', () => {
    function makeAuditWriter() {
      return { write: vi.fn() };
    }

    async function writeSubAudit(taskId: string, rows: string[]): Promise<void> {
      const auditDir = path.join(tempDir, 'tasks', 'queues', 'results', taskId);
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(path.join(auditDir, 'audit.tsv'), rows.join('\n') + '\n');
    }

    function execOkRow(seq: number, summary: string): string {
      // mimic ToolExecutor audit row format (executor.ts:222-228 + audit.message)
      const escaped = summary.replace(/\n/g, '\\n').slice(0, 120);
      return `2026-05-30T06:00:00.000Z\tseq=${seq}\ttool_exec\texec\tok\telapsed_ms=100\tsummary=${escaped}`;
    }

    function makeClaimStore() {
      return createSummonCreationClaimStore({ fs: new NodeFileSystem({ baseDir: tempDir }) });
    }

    async function seedClaim(summonId: string, targetExecutorId: string, contractId: string) {
      const store = makeClaimStore();
      await store.claim({ summonId, targetExecutorId, contractId });
      return store;
    }

    function makePostProcessor(opts: {
      exists?: boolean;
      claimStore?: ReturnType<typeof makeClaimStore>;
    }) {
      // Phase 1396 Step M: post-processor 只接 claimStore + contractQuery；
      // 不再接受任何 Evolution 回调 —— contract 创建确认即 SummonSystem 终点。
      const existsSpy = vi.fn(async () => opts.exists ?? true);
      const postProcessor = createSummonContractExtractPostProcessor({
        claimStore: opts.claimStore ?? makeClaimStore(),
        contractQuery: { exists: existsSpy },
      });
      return { postProcessor, existsSpy };
    }

    it('claim + contract 已提交 + evidence 一致 → success envelope 立即返回、无 failure audit、无 Evolution 回调', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-pp-test', 'filetool-auditor', '1780122465165-bcf86856');
      const { postProcessor, existsSpy } = makePostProcessor({
        exists: true,
        claimStore,
      });

      await writeSubAudit('task-pp-test', [
        execOkRow(1, 'Contract created: 1780122465165-bcf86856 for claw filetool-auditor'),
      ]);
      const resultText = 'wj，已派出 filetool-auditor 去审查 L2c FileTool 模块！';
      const summary = await postProcessor({
        content: resultText,
        sourceIsError: false,
      }, { id: 'task-pp-test', callerType: 'miner_subagent' } as any, mockFs, auditWriter as any);

      expect(existsSpy).toHaveBeenCalledWith('filetool-auditor', '1780122465165-bcf86856');
      // Phase 1396 Step M: factory 不再接受 retrospective 回调参数（编译期收缩）。
      expect(createSummonContractExtractPostProcessor.length).toBe(1);

      // legacy by-contract file must NOT be written
      const byContractPath = path.join(
        tempDir, 'clawspace', 'pending-retrospective', 'by-contract', '1780122465165-bcf86856.json',
      );
      await expect(fs.access(byContractPath)).rejects.toThrow();

      // Phase 1396 Step C: 成功结果精确返回 contractId，不含 executor/raw 输出
      expect(summary.content).toBe('Contract created: 1780122465165-bcf86856');
      expect(summary.content).not.toContain('filetool-auditor');
      expect(summary.content).not.toContain('wj，已派出');

      const failCalls = auditWriter.write.mock.calls.filter(
        (c: any) => typeof c[0] === 'string' && c[0].startsWith('summon_'),
      );
      expect(failCalls).toHaveLength(0);
    });

    it('error envelope + claim 指向的 contract 已提交 → 恢复为成功（重建回执）', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-recover', 'claw-a', 'c-recovered');
      const { postProcessor } = makePostProcessor({
        exists: true,
        claimStore,
      });

      const summary = await postProcessor({
        content: 'subagent crashed after create',
        sourceIsError: true,
      }, { id: 'task-recover', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(summary.content).toBe('Contract created: c-recovered');
      expect(summary.isError).toBe(false);
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_creation_recovered',
        'taskId=task-recover',
        'contractId=c-recovered',
        'targetExecutorId=claw-a',
      );
    });

    it('claim 存在但 contract 不存在（success envelope）→ 保持失败 wrap', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-missing', 'claw-a', 'c-missing');
      const { postProcessor } = makePostProcessor({ exists: false, claimStore });

      const result = await postProcessor({
        content: 'Done.',
        sourceIsError: false,
      }, { id: 'task-missing', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(result.content).toContain('summon_contract_creation_failed');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_claim_contract_missing',
        'taskId=task-missing',
        'contractId=c-missing',
        'targetExecutorId=claw-a',
      );
    });

    it('claim 存在但 contract 不存在 → 稳定失败 envelope', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-missing-err', 'claw-a', 'c-missing');
      const { postProcessor } = makePostProcessor({ exists: false, claimStore });

      const result = await postProcessor({
        content: 'some error result',
        sourceIsError: true,
      }, { id: 'task-missing-err', callerType: 'miner_subagent' } as any, mockFs, auditWriter as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('summon_contract_creation_failed');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_claim_contract_missing',
        'taskId=task-missing-err',
        'contractId=c-missing',
        'targetExecutorId=claw-a',
      );
    });

    it('无 claim + success envelope + 0 evidence → NO_CONTRACT_CREATED + failure wrap', async () => {
      const auditWriter = makeAuditWriter();
      const { postProcessor, existsSpy } = makePostProcessor({});
      // no writeSubAudit call → audit.tsv doesn't exist

      const result = await postProcessor({
        content: 'Result text.',
        sourceIsError: false,
      }, { id: 'task-no-audit', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(existsSpy).not.toHaveBeenCalled();
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_contract_created',
        'taskId=task-no-audit',
      );
      expect(result.content).toContain('summon_contract_creation_failed');
    });

    it('无 claim + error envelope → 稳定失败 envelope（不返回 raw）', async () => {
      const auditWriter = makeAuditWriter();
      const { postProcessor, existsSpy } = makePostProcessor({});
      const result = await postProcessor({
        content: 'some error result',
        sourceIsError: true,
      }, { id: 'task-err', callerType: 'miner_subagent' } as any, mockFs, auditWriter as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('summon_contract_creation_failed');
      expect(result.content).not.toContain('some error result');
      expect(existsSpy).not.toHaveBeenCalled();
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_contract_created',
        'taskId=task-err',
      );
    });

    it('无 claim 但 evidence 存在 → evidence 不再授权：failure wrap + invariant violation audit', async () => {
      const auditWriter = makeAuditWriter();
      const { postProcessor } = makePostProcessor({
        exists: true,
      });

      await writeSubAudit('task-no-claim-evidence', [
        execOkRow(1, 'Contract created: c-orphan for claw claw-x'),
      ]);

      const result = await postProcessor({
        content: 'Done.',
        sourceIsError: false,
      }, { id: 'task-no-claim-evidence', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(result.content).toContain('summon_contract_creation_failed');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_creation_evidence_mismatch',
        'taskId=task-no-claim-evidence',
        'claimContractId=(none)',
        'evidenceContractIds=c-orphan',
      );
    });

    it('第二个不同 contract evidence → invariant violation audit（claim authority 不变）', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-multi', 'claw-alpha', 'c1-aaa');
      const { postProcessor } = makePostProcessor({ exists: true, claimStore });

      await writeSubAudit('task-multi', [
        execOkRow(1, 'Contract created: c1-aaa for claw claw-alpha'),
        execOkRow(5, 'Contract created: c2-bbb for claw claw-beta'),
      ]);

      const summary = await postProcessor({
        content: 'Done.',
        sourceIsError: false,
      }, { id: 'task-multi', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      // claim 是唯一 authority：summary 只含 claim 指向的 contract
      expect(summary.content).toBe('Contract created: c1-aaa');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_creation_evidence_mismatch',
        'taskId=task-multi',
        'claimContractId=c1-aaa',
        'evidenceContractIds=c1-aaa,c2-bbb',
      );
    });

    it('evidence 与 claim 指向不同 contract → invariant violation audit', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-mismatch', 'claw-a', 'c-claimed');
      const { postProcessor } = makePostProcessor({ exists: true, claimStore });

      await writeSubAudit('task-mismatch', [
        execOkRow(1, 'Contract created: c-other for claw claw-a'),
      ]);

      const summary = await postProcessor({
        content: 'Done.',
        sourceIsError: false,
      }, { id: 'task-mismatch', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(summary.content).toBe('Contract created: c-claimed');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_creation_evidence_mismatch',
        'taskId=task-mismatch',
        'claimContractId=c-claimed',
        'evidenceContractIds=c-other',
      );
    });

    it('contract query true 后 processor 立即返回 success envelope（无 Evolution 副作用位）', async () => {
      // Phase 1396 Step M: retrospective 注册已从 summon finalizer 移除；
      // 创建确认后不得有任何外部调用 —— 此处锁定成功路径 0 额外依赖调用。
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-reg-gone', 'my-claw', 'c-noreg');
      const { postProcessor, existsSpy } = makePostProcessor({
        exists: true,
        claimStore,
      });

      await writeSubAudit('task-reg-gone', [
        execOkRow(1, 'Contract created: c-noreg for claw my-claw'),
      ]);

      const summary = await postProcessor({
        content: 'Done.',
        sourceIsError: false,
      }, { id: 'task-reg-gone', callerType: 'miner_subagent' } as any, mockFs, auditWriter as any);

      expect(summary).toMatchObject({
        content: 'Contract created: c-noreg',
        isError: false,
      });
      expect(existsSpy).toHaveBeenCalledTimes(1);
      // 成功路径只允许 claim 读 + contract query，无其他 audit 副作用。
      expect(auditWriter.write).not.toHaveBeenCalledWith(
        expect.stringContaining('retrospective'),
        expect.anything(),
      );
    });

    it('subAudit 非 FNF 读失败 → SUB_AUDIT_READ_FAILED audit，claim authority 判定不变', async () => {
      const auditWriter = makeAuditWriter();
      const claimStore = await seedClaim('task-io-err', 'claw-a', 'c-io');
      const { postProcessor } = makePostProcessor({ exists: true, claimStore });
      const readSpy = vi.spyOn(mockFs, 'read').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );

      const summary = await postProcessor({
        content: 'Result text.',
        sourceIsError: false,
      }, { id: 'task-io-err', callerType: 'shadow_subagent' } as any, mockFs, auditWriter as any);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_sub_audit_read_failed',
        'taskId=task-io-err',
        expect.stringContaining('path=tasks/queues/results/task-io-err/audit.tsv'),
        expect.stringContaining('error=[EACCES]'),
      );
      // evidence 不再是 authority：claim + 已提交 → 成功
      expect(summary.content).toBe('Contract created: c-io');

      readSpy.mockRestore();
    });
  });



  describe('audit events', () => {
    it('should audit when loadSkills fails with non-ENOENT error', async () => {
      const auditWriter = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
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
      });
      const testTool = new SummonTool(createMockTaskSystem(mockFs, auditWriter as any));

      await testTool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'skill_rescan_aborted',
        'op=list_dir',
        'dir=clawspace/dispatch-skills',
        'reason=[EACCES] permission denied',
      );

      existsSpy.mockRestore();
    });

    it('should audit when dialogMessages is empty', async () => {
      const auditWriter = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter: auditWriter as any,
        // phase 1406: caller snapshot fixture with empty messages — verify
        // shadow path still emits no-dialog-context audit when caller messages=[].
        getCallerSnapshot: async () => ({
          systemPrompt: 'mock system prompt',
          tools: [],
          messages: [],
        }),
      } as any);

      const testTool = new SummonTool(createMockTaskSystem(mockFs, auditWriter as any));
      await testTool.execute({ goal: 'test task' }, ctx);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'summon_no_dialog_context',
      );
    });
  });
});
