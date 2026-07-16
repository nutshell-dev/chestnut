import { describe, expect, it, vi } from 'vitest';
import { composeStatusMotionGuidance } from '../../../src/assembly/motion-guidance-composer.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import type { ContractSystem } from '../../../src/core/contract/index.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import { createStatusTool } from '../../../src/core/status-service/status-tool.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';

/**
 * status-service status-tool integration tests
 *
 * 历史：phase 1468 — F9 partial 续治 from audit-2026-05-30。原 18 case 针对 status-tool.ts
 * 3 内联 async helper（getContractStatus / getTaskStatus / getStorageStatus）经 `__test_*`
 * test-only export 测试面。
 *
 * phase 1472 Step A refactor 把 3 helper 抽成 `aggregators.ts` 中 pure function +
 * format helper、`__test_*` 退役。原 case 拆两层：
 *   - 计算逻辑（view shape、format、ENOENT/FS_NOT_FOUND silent）→ `aggregators.test.ts` 14 case
 *   - audit-emission 路径（CONTRACT_ERROR / TASK_PENDING_ERROR / TASK_RUNNING_ERROR
 *     这 3 条 STATUS_AUDIT_EVENTS 由 wrapper layer 写）→ 本文件 integration test
 *
 * 本文件聚焦后者：调 `createStatusTool().execute()` 真走 wrapper、断 auditWriter.write
 * 收到对应 event name + error 消息片段。复用 phase 1468 audit-emit case 三条 + ENOENT
 * silent 对照、保证 F9 audit-emit cov 不漏。
 */

function makeMockCtx(fs: Partial<FileSystem>, auditWrite?: ReturnType<typeof vi.fn>) {
  const auditWriter = auditWrite ? ({ write: auditWrite } as unknown as never) : undefined;
  return new ExecContextImpl({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    profile: 'full',
    fs: fs as FileSystem,
    auditWriter,
  });
}

function makeMockContractSystem(loadActive: () => Promise<unknown>): ContractSystem {
  return { loadActive: vi.fn(loadActive) } as unknown as ContractSystem;
}

describe('status-tool integration (audit emission paths — phase 1468 F9 cov preserved)', () => {
  // ── Contract audit emission ────────────────────────────────────────────────

  it('contract loadActive throws → STATUS_AUDIT_EVENTS.CONTRACT_ERROR emitted with error msg', async () => {
    const auditWrite = vi.fn();
    const fs: Partial<FileSystem> = {
      list: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const cs = makeMockContractSystem(async () => {
      throw new Error('database connection lost');
    });
    const tool = createStatusTool(cs);
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Contract: Error loading');
    const contractCall = auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.CONTRACT_ERROR);
    expect(contractCall).toBeDefined();
    expect(contractCall!.some((s: unknown) => typeof s === 'string' && s.includes('database connection lost'))).toBe(true);
  });

  // ── Task audit emission ────────────────────────────────────────────────────

  it('pending EACCES → STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR emitted with error msg', async () => {
    const auditWrite = vi.fn();
    const eacces: any = new Error('EACCES: permission denied');
    eacces.code = 'EACCES';
    const fs: Partial<FileSystem> = {
      list: vi.fn()
        .mockRejectedValueOnce(eacces)  // pending
        .mockResolvedValueOnce([]),     // running
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const cs = makeMockContractSystem(async () => null);
    const tool = createStatusTool(cs);
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('pending error: [EACCES]');
    const pendingCall = auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR);
    expect(pendingCall).toBeDefined();
    expect(pendingCall!.some((s: unknown) => typeof s === 'string' && s.includes('EACCES'))).toBe(true);
  });

  it('running EIO → STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR emitted with error msg', async () => {
    const auditWrite = vi.fn();
    const ioerr: any = new Error('EIO: I/O error');
    ioerr.code = 'EIO';
    const fs: Partial<FileSystem> = {
      list: vi.fn()
        .mockResolvedValueOnce([])      // pending
        .mockRejectedValueOnce(ioerr),  // running
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const cs = makeMockContractSystem(async () => null);
    const tool = createStatusTool(cs);
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('running error: [EIO]');
    const runningCall = auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR);
    expect(runningCall).toBeDefined();
    expect(runningCall!.some((s: unknown) => typeof s === 'string' && s.includes('EIO'))).toBe(true);
  });

  // ── Silent paths (no audit emission) ───────────────────────────────────────

  it('pending ENOENT (NodeJS code) silent → no TASK_PENDING_ERROR audit', async () => {
    const auditWrite = vi.fn();
    const enoent: any = new Error('ENOENT');
    enoent.code = 'ENOENT';
    const fs: Partial<FileSystem> = {
      list: vi.fn()
        .mockRejectedValueOnce(enoent)
        .mockResolvedValueOnce([]),
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const tool = createStatusTool(makeMockContractSystem(async () => null));
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR)).toBeUndefined();
  });

  it('pending FS_NOT_FOUND (L1 abstraction code) silent → no TASK_PENDING_ERROR audit', async () => {
    const auditWrite = vi.fn();
    const fs: Partial<FileSystem> = {
      list: vi.fn()
        .mockRejectedValueOnce(new FileNotFoundError('/tasks/queues/pending'))
        .mockResolvedValueOnce([]),
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const tool = createStatusTool(makeMockContractSystem(async () => null));
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR)).toBeUndefined();
  });

  // ── Reverse 1：no audit when all clean ─────────────────────────────────────

  it('happy path (no errors) → 0 audit write across the run', async () => {
    const auditWrite = vi.fn();
    const fs: Partial<FileSystem> = {
      list: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(false),
    };
    const ctx = makeMockCtx(fs, auditWrite);
    const tool = createStatusTool(makeMockContractSystem(async () => null));
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(auditWrite).not.toHaveBeenCalled();
  });
});

/**
 * status-tool motion guidance injection — phase 1472 Step D.
 *
 * Covers:
 * - motion claw + composer 注入 → 输出尾段含 [CLI hints for motion] + note + verb 行
 * - 非 motion claw + composer 注入 → 0 尾段（guidance 被 motion-only guard 过滤）
 * - motion claw + 0 composer → 0 尾段（assembly 未注入时不崩 / 不写假 hint）
 *
 * 反向 1：composer 输出含 `chestnut` binary 字面（确认 composer 物理拼装）
 * 反向 2：StatusMotionGuidance.commands[0].invocation 含 `claw <name> status` verb 片段
 *        （确认业主 fact → composer 拼接链路）
 */


function mkCtx(clawId: string) {
  const mockFs = {
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
  } as unknown as NodeFileSystem;
  return new ExecContextImpl({
    clawId,
    clawDir: '/tmp/test-claw',
    profile: 'full',
    fs: mockFs,
  });
}

const mockContractSystem = { loadActive: vi.fn().mockResolvedValue(null) } as any;

describe('status-tool motion guidance injection (phase 1472 Step D)', () => {
  it('motion claw + composer 注入 → 尾段含 CLI hints', async () => {
    const tool = createStatusTool(mockContractSystem, composeStatusMotionGuidance());
    const result = await tool.execute({}, mkCtx(MOTION_CLAW_ID));
    expect(result.success).toBe(true);
    expect(result.content).toContain('[CLI hints for motion]');
    expect(result.content).toContain('chestnut claw <name> status');
    expect(result.content).toContain('chestnut claw list');
  });

  it('non-motion claw + composer 注入 → 0 尾段（guard 过滤）', async () => {
    const tool = createStatusTool(mockContractSystem, composeStatusMotionGuidance());
    const result = await tool.execute({}, mkCtx('worker-claw'));
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('[CLI hints for motion]');
  });

  it('motion claw + 0 composer → 0 尾段（无 crash）', async () => {
    const tool = createStatusTool(mockContractSystem /* no guidance */);
    const result = await tool.execute({}, mkCtx(MOTION_CLAW_ID));
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('[CLI hints for motion]');
  });

  it('reverse: composer 物理拼 binary `chestnut`', () => {
    const g = composeStatusMotionGuidance();
    expect(g.commands.length).toBeGreaterThan(0);
    for (const c of g.commands) {
      expect(c.invocation.startsWith('chestnut ')).toBe(true);
    }
  });

  it('reverse: composer 含 `claw <name> status` verb fragment', () => {
    const g = composeStatusMotionGuidance();
    const statusCmd = g.commands.find((c) => c.invocation.includes('claw <name> status'));
    expect(statusCmd).toBeDefined();
    expect(statusCmd!.purpose).toContain('contract');
  });
});

