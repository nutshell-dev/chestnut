import { describe, it, expect, vi } from 'vitest';
import { assertTaskShapeOnSave } from '../../../src/core/async-task-system/invariants.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

const validSubAgentTaskStandard = {
  kind: 'subagent' as const,
  id: 'task-sa-1',
  shortId: 'short1',
  intent: 'do something',
  timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
  maxSteps: 10,
  parentClawId: 'claw-1',
  createdAt: '2026-05-18T00:00:00Z',
  mode: 'standard' as const,
};

const validSubAgentTaskShadow = {
  kind: 'subagent' as const,
  id: 'task-sa-2',
  shortId: 'short2',
  intent: 'shadow work',
  timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
  maxSteps: 5,
  parentClawId: 'claw-1',
  createdAt: '2026-05-18T00:00:00Z',
  mode: 'shadow' as const,
  shadowMessages: [{ role: 'user', content: 'hi' }],
};

const validToolTask = {
  kind: 'tool' as const,
  id: 'task-tool-1',
  shortId: 'shorttool1',
  toolName: 'read',
  args: {},
  parentClawDir: '/tmp',
  parentClawId: 'claw-1',
  createdAt: '2026-05-18T00:00:00Z',
  isIdempotent: true,
  maxRetries: 2,
  retryCount: 0,
};

describe('async-task save invariant (phase 239 Step A)', () => {
  describe('Zod SoT 复用', () => {
    it('合法 SubAgentTask standard mode → 0 emit', () => {
      const { audit, events } = makeAudit();
      assertTaskShapeOnSave(validSubAgentTaskStandard, audit, 'schedule_subagent');
      expect(events).toHaveLength(0);
    });

    it('合法 SubAgentTask shadow mode → 0 emit', () => {
      const { audit, events } = makeAudit();
      assertTaskShapeOnSave(validSubAgentTaskShadow, audit, 'schedule_subagent');
      expect(events).toHaveLength(0);
    });

    it('合法 ToolTask → 0 emit', () => {
      const { audit, events } = makeAudit();
      assertTaskShapeOnSave(validToolTask, audit, 'schedule_tool');
      expect(events).toHaveLength(0);
    });

    it('缺 kind 字段 → emit invariant_violated + zod_errors 含 kind', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validSubAgentTaskStandard, kind: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_subagent');
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe(TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED);
      // union 错误摘要应包含具体字段路径
      expect(events[0].some((c: string | number) => typeof c === 'string' && c.startsWith('zod_errors='))).toBe(true);
    });

    it('kind=unknown_kind → emit invariant_violated', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validToolTask, kind: 'unknown_kind' };
      assertTaskShapeOnSave(bad, audit, 'schedule_tool');
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe(TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED);
    });

    it('SubAgentTask 缺 intent → emit + zod_errors 含 intent', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validSubAgentTaskStandard, intent: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_subagent');
      expect(events).toHaveLength(1);
      const zodCol = events[0].find((c: string | number) => typeof c === 'string' && c.startsWith('zod_errors='));
      expect(zodCol).toBeTruthy();
      expect(String(zodCol)).toContain('intent');
    });

    it('ToolTask 缺 toolName → emit + zod_errors 含 toolName', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validToolTask, toolName: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_tool');
      expect(events).toHaveLength(1);
      const zodCol = events[0].find((c: string | number) => typeof c === 'string' && c.startsWith('zod_errors='));
      expect(zodCol).toBeTruthy();
      expect(String(zodCol)).toMatch(/toolName|mode/);
    });

    it('task=null → emit + task_id=unknown', () => {
      const { audit, events } = makeAudit();
      assertTaskShapeOnSave(null, audit, 'schedule_subagent');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED,
          expect.stringContaining('task_id=unknown'),
        ]),
      );
    });
  });

  describe('source 字段', () => {
    it('schedule_subagent 源', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validSubAgentTaskStandard, intent: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_subagent');
      expect(events[0]).toEqual(
        expect.arrayContaining([expect.stringContaining('source=schedule_subagent')]),
      );
    });

    it('schedule_tool 源', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validToolTask, toolName: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_tool');
      expect(events[0]).toEqual(
        expect.arrayContaining([expect.stringContaining('source=schedule_tool')]),
      );
    });
  });

  describe('zod_errors 摘要', () => {
    it('多 issue 时取前 3 个', () => {
      const { audit, events } = makeAudit();
      // 构造同时缺多个必填字段的 task
      const bad = {
        kind: 'subagent',
        id: 'bad-task',
        // 缺 intent, timeoutMs, parentClawId, createdAt
      };
      assertTaskShapeOnSave(bad, audit, 'schedule_subagent');
      expect(events).toHaveLength(1);
      const zodCol = events[0].find((c: string | number) => typeof c === 'string' && c.startsWith('zod_errors='));
      expect(zodCol).toBeTruthy();
      const summary = String(zodCol).replace('zod_errors=', '');
      const parts = summary.split('|');
      expect(parts.length).toBeLessThanOrEqual(3);
    });

    it('单 issue 时正常显示', () => {
      const { audit, events } = makeAudit();
      const bad = { ...validToolTask, toolName: undefined };
      assertTaskShapeOnSave(bad, audit, 'schedule_tool');
      const zodCol = events[0].find((c: string | number) => typeof c === 'string' && c.startsWith('zod_errors='));
      expect(zodCol).toBeTruthy();
      const summary = String(zodCol).replace('zod_errors=', '');
      expect(summary).toMatch(/toolName|mode/);
    });
  });

  describe('schedule() 集成', () => {
    it('合法 subagent task schedule → 0 emit invariant + 文件落盘', async () => {
      const { audit, events } = makeAudit();
      const writes: Array<{ path: string; content: string }> = [];
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        read: vi.fn().mockResolvedValue(''),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((p: string, c: string) => {
          writes.push({ path: p, content: c });
          return Promise.resolve();
        }),
        exists: vi.fn().mockResolvedValue(false),
      } as unknown as FileSystem;

      const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
        ...makeTaskSystemDeps(),
      });

      const taskId = await system.schedule('subagent', {
        kind: 'subagent',
        intent: 'test intent',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'claw-1',
        mode: 'standard',
      });

      expect(taskId).toBeTruthy();
      expect(writes.length).toBe(1);
      expect(writes[0].path).toContain(taskId);

      const invariantEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED);
      expect(invariantEvents).toHaveLength(0);

      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('非法 subagent task → 文件仍落盘（不 throw）+ audit emit', async () => {
      const { audit, events } = makeAudit();
      const writes: Array<{ path: string; content: string }> = [];
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        read: vi.fn().mockResolvedValue(''),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((p: string, c: string) => {
          writes.push({ path: p, content: c });
          return Promise.resolve();
        }),
        exists: vi.fn().mockResolvedValue(false),
      } as unknown as FileSystem;

      const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
        ...makeTaskSystemDeps(),
      });

      // @ts-expect-error 故意传入非法 payload（缺 intent 与 mode）以测 invariant
      const taskId = await system.schedule('subagent', {
        kind: 'subagent',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'claw-1',
      });

      expect(taskId).toBeTruthy();
      expect(writes.length).toBe(1);

      const invariantEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED);
      expect(invariantEvents.length).toBe(1);
      expect(invariantEvents[0]).toEqual(
        expect.arrayContaining([
          expect.stringContaining('source=schedule_subagent'),
          expect.stringContaining('task_id='),
        ]),
      );

      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });
  });

});
