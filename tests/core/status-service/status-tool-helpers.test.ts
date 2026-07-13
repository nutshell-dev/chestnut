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
import { describe, it, expect, vi } from 'vitest';
import { createStatusTool } from '../../../src/core/status-service/status-tool.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ContractSystem } from '../../../src/core/contract/index.js';

function makeMockCtx(fs: Partial<FileSystem>, auditWrite?: ReturnType<typeof vi.fn>) {
  const auditWriter = auditWrite ? ({ write: auditWrite } as unknown as never) : undefined;
  return new ExecContextImpl({
    clawId: 'test-claw',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
