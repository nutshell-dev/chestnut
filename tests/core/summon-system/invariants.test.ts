/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - summon-rejected-shadow-audit.test.ts
 *  - summon-dispatched-audit.test.ts
 *  - summon-verify-param.test.ts
 *  - read-pending-retrospective.test.ts
 *  - summon-default-mode-shadow.test.ts
 *  - summon-decision-metadata.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/audit-events.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { readPendingRetrospective, InvalidJSONError, UnexpectedFormatError } from '../../../src/core/summon-system/pending-retrospective.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { SubAgentTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';

describe('summon-rejected-shadow-audit', () => {
  /**
   * Phase 1411 (reframe of phase 1409) / phase 807 DI — summon REJECTED_SHADOW audit emit reverse.
   *
   * Verifies:
   * - SummonTool with allowFromShadow=false → emits `summon_rejected_shadow` + returns success:false
   * - SummonTool with allowFromShadow=true → no REJECTED_SHADOW emit
   */

  async function createTempDir(): Promise<string> {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const d = path.join(tmpdir(), `summon-rejected-shadow-${randomUUID()}`);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  describe('Phase 1411 — summon_rejected_shadow audit emit', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let auditWrite: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      auditWrite = vi.fn();
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    function makeCtx(opts: { allowFromShadow: boolean; toolUseId?: string }): any {
      const auditWriter = { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        syncDir: path.join(tempDir, 'tasks', 'sync'),
        profile: 'full',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter,
        currentToolUseId: opts.toolUseId ?? 'toolu_reject_test',
        getCallerSnapshot: async () => ({
          systemPrompt: 'p',
          tools: [],
          messages: [{ role: 'user', content: 'test' }],
        }),
      });
      const taskSystem = createMockTaskSystem(mockFs, auditWriter);
      const tool = new SummonTool(taskSystem, undefined, undefined, opts.allowFromShadow);
      return { ctx, tool };
    }

    it('reverse 1 — allowFromShadow=false emits REJECTED_SHADOW + returns success:false', async () => {
      const { ctx, tool } = makeCtx({ allowFromShadow: false });
      const result = await tool.execute({ goal: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('shadow_summon_rejected');

      const rejectedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.REJECTED_SHADOW,
      );
      expect(rejectedCalls).toHaveLength(1);

      const cols = rejectedCalls[0].slice(1);
      expect(cols).toContain('tool_use_id=toolu_reject_test');
      expect(cols).toContain('reason=shadow_call_orphan_async_routing');
    });

    it('reverse 2 — allowFromShadow=true → no REJECTED_SHADOW emit', async () => {
      const { ctx, tool } = makeCtx({ allowFromShadow: true });
      const result = await tool.execute({ goal: 'test' }, ctx);

      expect(result.success).toBe(true);

      const rejectedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.REJECTED_SHADOW,
      );
      expect(rejectedCalls).toHaveLength(0);
    });
  });
});

describe('summon-dispatched-audit', () => {
  /**
   * Phase 1411 (reframe of phase 1409) — summon DISPATCHED audit emit reverse.
   *
   * Verifies:
   * - SUCCESS shadow mode → emits `summon_dispatched` with typed cols (mode/target_claw/verify/task_id/tool_use_id)
   * - SUCCESS mining mode → emits `summon_dispatched` mode=mining
   * - targetClaw absent → no `target_claw=` col
   * - NO `goal_preview` col in emit args (reframe: goal body 0 入 audit / dialog 全文权威)
   */

  async function createTempDir(): Promise<string> {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const d = path.join(tmpdir(), `summon-dispatched-audit-${randomUUID()}`);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  describe('Phase 1411 — summon_dispatched audit emit（phase 1396 Step C 收缩）', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let auditWrite: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      auditWrite = vi.fn();
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    function makeCtx(snapshotMessages: Message[] = [], toolUseId = 'toolu_test_abc'): any {
      const auditWriter = { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter,
        currentToolUseId: toolUseId,
        getCallerSnapshot: async () => ({
          systemPrompt: 'mock system prompt',
          tools: [],
          messages: snapshotMessages,
        }),
      } as any);
      const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
      return { ctx, tool };
    }

    it('reverse 1 — accepted dispatch emits summon_dispatched with typed cols（仅 tool_use_id + task_id）', async () => {
      const { ctx, tool } = makeCtx([{ role: 'user', content: 'test' }]);
      const result = await tool.execute({ goal: 'test goal text' }, ctx);

      expect(result.success).toBe(true);

      const dispatchedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
      );
      expect(dispatchedCalls).toHaveLength(1);

      const cols = dispatchedCalls[0].slice(1);
      expect(cols).toContain('tool_use_id=toolu_test_abc');
      expect(cols.some((c: string) => c.startsWith('task_id='))).toBe(true);

      // phase 1396 Step C: mode/targetClaw/verify 不再是 agent 决策，0 入 audit
      expect(cols.some((c: string) => c.startsWith('mode='))).toBe(false);
      expect(cols.some((c: string) => c.startsWith('target_claw='))).toBe(false);
      expect(cols.some((c: string) => c.startsWith('verify='))).toBe(false);

      // reframe (phase 1411): goal body 0 入 audit
      expect(cols.some((c: string) => c.startsWith('goal_preview='))).toBe(false);
      expect(cols.some((c: string) => c.includes('test goal text'))).toBe(false);
    });
  });

});

describe('summon-verify-param', () => {
  /**
   * SummonTool verify parameter tests
   */

  async function createTempDir(): Promise<string> {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

  describe('SummonTool 公开 schema 收缩（phase 1396 Step C）', () => {
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

    it('schema exact-key：只有必填 goal，additionalProperties=false', () => {
      const { tool } = makeCtx();
      expect(Object.keys(tool.schema.properties)).toEqual(['goal']);
      expect(tool.schema.required).toEqual(['goal']);
      expect((tool.schema as any).additionalProperties).toBe(false);
      expect((tool.schema.properties.goal as any).minLength).toBe(1);
    });

    it('内部固定 verify=false 默认：prompt 不含 verification 模板段', async () => {
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

    it('legacy verify/mode/targetClaw 入参被忽略（不再读 agent args）', async () => {
      const { ctx, tool } = makeCtx();
      const result = await tool.execute(
        { goal: 'test', verify: true, mode: 'mining', targetClaw: 'x-claw' } as any,
        ctx,
      );

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      // 内部固定 shadow 路径 + verify=false
      expect(tasks[0].callerType).toBe('shadow_subagent');
      expect(tasks[0].summonDecision).toMatchObject({
        schema_version: 1,
        mode: 'shadow',
        verify: false,
      });
      expect((tasks[0].summonDecision as Record<string, unknown>).targetClaw).toBeUndefined();
      const content = getTaskContent(tasks[0]);
      expect(content).not.toContain('prompt_file:');
    });
  });

});

describe('read-pending-retrospective', () => {
  /**
   * @module tests/core/summon-system/read-pending-retrospective
   * Phase 1349 sub-2: readPendingRetrospective split-API reverse tests
   */

  describe('readPendingRetrospective', () => {
    let testDir: string;
    let motionDir: string;

    beforeEach(async () => {
      testDir = path.join(
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        os.tmpdir(),
        `.test-read-pending-retro-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
      );
      motionDir = path.join(testDir, 'motion');
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(motionDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    it('throws InvalidJSONError on malformed JSON', async () => {
      const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'c1.json'), 'not-json{{{');

      const nodeFs = new NodeFileSystem({ baseDir: motionDir });
      await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'c1' })).rejects.toThrow(InvalidJSONError);
    });

    it('throws UnexpectedFormatError on non-object JSON', async () => {
      const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'c1.json'), '"just a string"');

      const nodeFs = new NodeFileSystem({ baseDir: motionDir });
      await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'c1' })).rejects.toThrow(UnexpectedFormatError);
    });

    it('propagates ENOENT when file missing', async () => {
      const nodeFs = new NodeFileSystem({ baseDir: motionDir });
      await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'missing' })).rejects.toThrow();
    });

    it('returns PendingRetroRef for valid object JSON', async () => {
      const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'c1.json'),
        JSON.stringify({ contractId: 'c1', targetClaw: 'claw-a', mode: 'mining', miningTaskId: 't1', createdAt: '2024-01-01T00:00:00Z' }),
      );

      const nodeFs = new NodeFileSystem({ baseDir: motionDir });
      const result = await readPendingRetrospective({ fs: nodeFs, contractId: 'c1' });

      expect(result.contractId).toBe('c1');
      expect(result.targetClaw).toBe('claw-a');
      expect(result.mode).toBe('mining');
      expect(result.miningTaskId).toBe('t1');
    });
  });
});

describe('summon-default-mode-shadow', () => {
  /**
   * Phase 1166 — summon tool default mode: mining → shadow
   */

  async function createTempDir(): Promise<string> {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const d = path.join(tmpdir(), `summon-default-test-${randomUUID()}`);
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

  describe('Phase 1166/1396C — 固定 shadow 路径（mode 不再是公开参数）', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let tool: SummonTool;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      const defaultAuditWriter = {
        write: vi.fn(),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      } as any;
      tool = new SummonTool(createMockTaskSystem(mockFs, defaultAuditWriter));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    function makeCtx(snapshotMessages: Message[] = []) {
      const auditWriter = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any;
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType: 'claw',
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter,
        getCallerSnapshot: async () => ({
          systemPrompt: 'mock system prompt',
          tools: [
            { name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } },
          ],
          messages: snapshotMessages,
        }),
      } as any);
      const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
      return { ctx, tool };
    }

    it('reverse 1 — 不传任何可选参数走 shadow 路径', async () => {
      const { ctx } = makeCtx([{ role: 'user', content: 'test' }]);
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));
      const result = await customTool.execute({ goal: 'test goal' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].callerType).toBe('shadow_subagent');
      expect(tasks[0].shadowMessages).toBeDefined();
      expect(tasks[0].systemPrompt).toBe('mock system prompt');
      expect(tasks[0].motionClawDir).toBeUndefined();
    });

    it('reverse 2 — agent-facing description 不含 mode/claw/内部实现教学', () => {
      for (const banned of ['targetClaw', 'mining', 'mode']) {
        expect(tool.description).not.toContain(banned);
      }
      expect(tool.description).toContain('异步');
      // schema 不含 mode 描述
      expect((tool.schema.properties as Record<string, unknown>).mode).toBeUndefined();
    });
  });

});

describe('summon-decision-metadata', () => {
  /**
   * phase 281 Step A: SummonDecision metadata embed tests.
   *
   * Verifies that shadow / mining summon schedule writes summonDecision metadata
   * directly into the async-task task file, eliminating the separate summon-state
   * write path while keeping the store for backwards compatibility in Step A.
   */

  async function createTempDir(): Promise<string> {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const d = path.join(tmpdir(), `summon-decision-metadata-test-${randomUUID()}`);
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

  describe('summon decision metadata embed (phase 281 Step A)', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let auditEvents: Array<{ type: string; args: unknown[] }>;
    let tool: SummonTool;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      auditEvents = [];
      const auditWriter = {
        write: (type: string, ...args: unknown[]) => { auditEvents.push({ type, args }); },
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      } as any;
      tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    function makeCtx(
      callerType: 'claw' | 'subagent' | 'dispatcher',
      options?: {
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
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        callerType,
        fs: mockFs,
        llm: {} as unknown as LLMOrchestrator,
        auditWriter,
        getCallerSnapshot: async () => ({
          systemPrompt: options?.snapshot?.systemPrompt ?? 'mock system prompt',
          tools: (options?.snapshot?.tools ?? [{ name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } }]) as any,
          messages: options?.snapshot?.messages ?? [],
        }),
      } as any);
      const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
      return { ctx, tool };
    }

    it('summon schedule → task file含 summonDecision metadata（phase 1396C：固定 shadow + verify=false）', async () => {
      const { ctx, tool } = makeCtx('claw');
      const result = await tool.execute({ goal: 'shadow task' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].summonDecision).toMatchObject({
        schema_version: 1,
        mode: 'shadow',
        verify: false,
      });
      expect((tasks[0].summonDecision as Record<string, unknown>).targetClaw).toBeUndefined();
      expect(typeof (tasks[0].summonDecision as Record<string, unknown>).dispatchedAt).toBe('string');
    });

    it('non-summon 场景不存在 summonDecision 时字段为 undefined（optional）', async () => {
      // 本测试文件聚焦 summon path；这里仅验证 schema 不强制 summonDecision
      const parsed = SubAgentTaskSchema.safeParse({
        kind: 'subagent',
        mode: 'standard',
        id: '550e8400-e29b-41d4-a716-446655440000',
        shortId: '550e8400',
        intent: 'plain subagent',
        timeoutMs: 1000,
        parentClawId: 'p1',
        createdAt: new Date().toISOString(),
      });
      expect(parsed.success).toBe(true);
      expect((parsed.data as Record<string, unknown>).summonDecision).toBeUndefined();
    });

    it('SubAgentTaskSchema validate summonDecision optional shape', () => {
      const valid = {
        kind: 'subagent',
        mode: 'shadow',
        id: '550e8401-e29b-41d4-a716-446655440000',
        shortId: '550e8401',
        intent: 'test',
        timeoutMs: 1000,
        parentClawId: 'p1',
        createdAt: new Date().toISOString(),
        shadowMessages: [{ role: 'user', content: 'hi' }],
        summonDecision: {
          schema_version: 1,
          mode: 'shadow',
          verify: true,
          targetClaw: 'tc',
          dispatchedAt: new Date().toISOString(),
        },
      };
      const parsed = SubAgentTaskSchema.safeParse(valid);
      expect(parsed.success).toBe(true);

      const invalid = {
        ...valid,
        summonDecision: {
          schema_version: 2,
          mode: 'invalid',
          verify: 'not-boolean',
          dispatchedAt: 123,
        },
      };
      const invalidParsed = SubAgentTaskSchema.safeParse(invalid);
      expect(invalidParsed.success).toBe(false);
    });

  });
});


describe('phase1396-creation-claim-boundary', () => {
  /**
   * Phase 1396 Step B: 0/1 创建 claim 归 SummonSystem 独占。
   *
   * 反向验收：
   * - ContractSystem 出现 summon-specific type/path → 失败
   * - CLI 仍有 `loadTask: async () => undefined` 的 summon 子进程路径 → 失败
   */
  const ROOT = path.resolve(process.cwd());

  function grepRecurse(args: string[]): string {
    try {
      return execFileSync('grep', ['-R', '-n', '--include=*.ts', ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
      });
    } catch (e) {
      // grep exits 1 when no matches — treat as empty
      if ((e as any)?.status === 1) return '';
      throw e;
    }
  }

  it('ContractSystem 不出现 summon 创建 claim 资源/类型（0/1 correlation 归 SummonSystem）', () => {
    const hits = grepRecurse([
      '-E',
      '(SummonCreationClaim|creation-claim|summons/)',
      'src/core/contract',
    ]);
    expect(hits.trim()).toBe('');
  });

  it('CLI 不再注入恒 undefined 的 summon loadTask loader', () => {
    const hits = grepRecurse([
      '-F',
      'loadTask: async () => undefined',
      'src/cli',
    ]);
    expect(hits.trim()).toBe('');
  });

  it('CLI 与 Assembly 经同一 factory 注入 claim store（不直接拼路径）', () => {
    for (const file of ['src/cli/index.ts', 'src/assembly/business-systems.ts']) {
      const hits = grepRecurse(['-F', 'createSummonCreationClaimStore', file]);
      expect(hits.trim()).not.toBe('');
    }
  });
});


describe('phase1396-summon-public-contract', () => {
  /**
   * Phase 1396 Step C: summon 公开契约 source-scan ratchet。
   * agent-facing schema/description/立即返回文案、motion 模板不得再出现
   * targetClaw/mode/mining/subagent 教学或"dispatched 即成功"语义。
   */
  const ROOT = path.resolve(process.cwd());

  it('summon 工具 agent-facing schema/description 不含 targetClaw/mode/mining 参数教学', () => {
    const src = fsRead('src/core/summon-system/tools/summon.ts');
    // schema 段（agent-facing）
    const schemaMatch = src.match(/schema = \{[\s\S]*?\n  \};/);
    expect(schemaMatch).not.toBeNull();
    const schema = schemaMatch![0];
    for (const banned of ['targetClaw', 'mining', 'mode', 'maxSteps', 'idleTimeoutMs', 'verify']) {
      expect(schema).not.toContain(banned);
    }
    // description 段（agent-facing）
    const descMatch = src.match(/readonly description = `([\s\S]*?)`;/);
    expect(descMatch).not.toBeNull();
    const desc = descMatch![1];
    for (const banned of ['targetClaw', 'shadow', 'mining', 'subagent', 'claw']) {
      expect(desc.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('summon 立即返回文案只表示 async accepted，不宣称创建成功', () => {
    const src = fsRead('src/core/summon-system/tools/summon.ts');
    expect(src).toContain('Summon accepted. Task ID:');
    expect(src).not.toContain('dispatched to create contract');
  });

  it('summon 最终结果来自 claim authority：成功 Contract created，失败统一 envelope', () => {
    const src = fsRead('src/core/summon-system/post-processors/contract-extract.ts');
    expect(src).toContain('Contract created: ');
    expect(src).toContain('summon_contract_creation_failed');
    // 不再含 motion 恢复处方教学（mining 重试）；内部 legacy callerType 字面允许保留
    expect(src).not.toContain('mining` 模式重试');
    expect(src).not.toContain('SUMMON_SHADOW_FAILED');
  });

  it('motion AGENTS.md summon 段只示例 goal，不教 targetClaw', () => {
    const src = fsRead('src/templates/motion/AGENTS.md');
    const section = src.match(/### summon 用法([\s\S]*?)(\n## |\n### [^s]|$)/);
    expect(section).not.toBeNull();
    expect(section![1]).not.toContain('targetClaw');
    expect(section![1]).toContain('"goal"');
    // 明确异步最终结果语义
    expect(section![1]).toContain('异步');
  });

  function fsRead(rel: string): string {
    return readFileSync(path.join(ROOT, rel), 'utf-8');
  }
});
