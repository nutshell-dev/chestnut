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
import * as path from 'path';
import { promises as fs } from 'fs';
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
import { readPendingRetrospective, InvalidJSONError, UnexpectedFormatError } from '../../../src/core/summon-system/index.js';
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

  describe('Phase 1411 — summon_dispatched audit emit', () => {
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

    it('reverse 1 — shadow mode dispatch emits summon_dispatched with typed cols', async () => {
      const { ctx, tool } = makeCtx([{ role: 'user', content: 'test' }]);
      const result = await tool.execute(
        { goal: 'test goal text', targetClaw: 'my-claw', verify: false },
        ctx,
      );

      expect(result.success).toBe(true);

      const dispatchedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
      );
      expect(dispatchedCalls).toHaveLength(1);

      const cols = dispatchedCalls[0].slice(1);
      expect(cols).toContain('tool_use_id=toolu_test_abc');
      expect(cols).toContain('mode=shadow');
      expect(cols).toContain('target_claw=my-claw');
      expect(cols).toContain('verify=false');
      expect(cols.some((c: string) => c.startsWith('task_id='))).toBe(true);

      // reframe (phase 1411): goal body 0 入 audit
      expect(cols.some((c: string) => c.startsWith('goal_preview='))).toBe(false);
      expect(cols.some((c: string) => c.includes('test goal text'))).toBe(false);
    });

    it('reverse 2 — mining mode dispatch emits summon_dispatched mode=mining', async () => {
      const { ctx, tool } = makeCtx();
      const result = await tool.execute(
        { goal: 'mining goal', mode: 'mining', verify: true },
        ctx,
      );

      expect(result.success).toBe(true);

      const dispatchedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
      );
      expect(dispatchedCalls).toHaveLength(1);

      const cols = dispatchedCalls[0].slice(1);
      expect(cols).toContain('mode=mining');
      expect(cols).toContain('verify=true');
    });

    it('reverse 3 — targetClaw absent → no target_claw= col', async () => {
      const { ctx, tool } = makeCtx([{ role: 'user', content: 'test' }]);
      const result = await tool.execute({ goal: 'test', verify: false }, ctx);

      expect(result.success).toBe(true);

      const dispatchedCalls = auditWrite.mock.calls.filter(
        (c) => c[0] === SUMMON_AUDIT_EVENTS.DISPATCHED,
      );
      expect(dispatchedCalls).toHaveLength(1);

      const cols = dispatchedCalls[0].slice(1);
      expect(cols.some((c: string) => c.startsWith('target_claw='))).toBe(false);
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

  describe('Phase 1166 — default mode shadow', () => {
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
            { name: 'mock_tool', description: 'Mock tool', input_schema: { type: 'object' } as any },
          ],
          messages: snapshotMessages,
        }),
      } as any);
      const tool = new SummonTool(createMockTaskSystem(mockFs, auditWriter));
      return { ctx, tool };
    }

    it('reverse 1 — 默认 mode 不传 mode 走 shadow 路径', async () => {
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

    it('reverse 2 — 显式 mode: mining 仍走 mining 路径', async () => {
      const { ctx, tool: testTool } = makeCtx();
      const result = await testTool.execute({ goal: 'test goal', mode: 'mining' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].callerType).toBe('miner_subagent');
      expect(tasks[0].shadowMessages).toBeUndefined();
      expect(tasks[0].motionClawDir).toBeDefined();
    });

    it('reverse 3 — 显式 mode: shadow 仍走 shadow 路径', async () => {
      const { ctx } = makeCtx([{ role: 'user', content: 'test' }]);
      const customTool = new SummonTool(createMockTaskSystem(mockFs, (ctx as any).auditWriter));
      const result = await customTool.execute({ goal: 'test goal', mode: 'shadow' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].callerType).toBe('shadow_subagent');
      expect(tasks[0].shadowMessages).toBeDefined();
      expect(tasks[0].systemPrompt).toBe('mock system prompt');
    });

    it('reverse 4 — description 含 shadow 默认字样、不含旧错误描述', () => {
      expect(tool.description).toContain('shadow（默认');
      expect(tool.schema.properties.mode.description).toContain("默认 'shadow'");
      expect(tool.description).not.toContain('mining（默认）');
      expect(tool.description).not.toContain('直接进入契约创建');
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

    it('shadow summon schedule → task file含 summonDecision metadata', async () => {
      const { ctx, tool } = makeCtx('claw');
      const result = await tool.execute({ goal: 'shadow task', verify: true, targetClaw: 'target-claw' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].summonDecision).toMatchObject({
        schema_version: 1,
        mode: 'shadow',
        verify: true,
        targetClaw: 'target-claw',
      });
      expect(typeof (tasks[0].summonDecision as Record<string, unknown>).dispatchedAt).toBe('string');
    });

    it('mining summon schedule → task file含 summonDecision metadata', async () => {
      const { ctx, tool } = makeCtx('claw');
      const result = await tool.execute({ goal: 'mining task', mode: 'mining', verify: false, targetClaw: 'miner-claw' }, ctx);

      expect(result.success).toBe(true);
      const tasks = await readPendingTasks(tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].summonDecision).toMatchObject({
        schema_version: 1,
        mode: 'mining',
        verify: false,
        targetClaw: 'miner-claw',
      });
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
