/**
 * phase 1468 — status-service test cov 补强 (F9 partial 续治 from audit-2026-05-30)
 *
 * 覆盖 status-tool.ts 3 internal async helpers:
 * - getContractStatus / getTaskStatus / getStorageStatus
 *
 * scope 严守：仅 helper unit tests / 不动 createStatusTool public API surface
 * mirror phase 1467 form (memory-system tests). Tier 1 feedback_test_magic_treatment_kit
 * 应用：audit event 名走 STATUS_AUDIT_EVENTS const、不写 magic string.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_getContractStatus,
  __test_getTaskStatus,
  __test_getStorageStatus,
} from '../../../src/core/status-service/status-tool.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { ContractSystem } from '../../../src/core/contract/index.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';

function makeMockCtx(fs: Partial<FileSystem>, auditWrite?: ReturnType<typeof vi.fn>): ExecContext {
  const auditWriter = auditWrite ? { write: auditWrite } : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fs, auditWriter } as any;
}

function makeMockContractSystem(loadActive: () => Promise<unknown>): ContractSystem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { loadActive: vi.fn(loadActive) } as any;
}

function makeEntry(name: string, isDir = false): FileEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { name, isDirectory: isDir } as any;
}

describe('status-service helpers (phase 1468)', () => {
  describe('getContractStatus', () => {
    it('no active contract returns "No active contract"', async () => {
      const ctx = makeMockCtx({});
      const cs = makeMockContractSystem(async () => null);
      const out = await __test_getContractStatus(ctx, cs);
      expect(out).toBe('Contract: No active contract');
    });

    it('active contract with all pending shows 0/N + subtasks list with ○', async () => {
      const ctx = makeMockCtx({});
      const cs = makeMockContractSystem(async () => ({
        title: 'Test Contract',
        subtasks: [
          { id: 't1', status: 'todo', description: 'first task' },
          { id: 't2', status: 'todo', description: 'second task' },
        ],
      }));
      const out = await __test_getContractStatus(ctx, cs);
      expect(out).toContain('Contract: "Test Contract" (0/2 subtasks done)');
      expect(out).toContain('  ○ t1: first task');
      expect(out).toContain('  ○ t2: second task');
    });

    it('active contract with partial completion shows correct count + mixed icons', async () => {
      const ctx = makeMockCtx({});
      const cs = makeMockContractSystem(async () => ({
        title: 'Partial',
        subtasks: [
          { id: 't1', status: 'completed', description: 'done' },
          { id: 't2', status: 'todo', description: 'pending' },
          { id: 't3', status: 'completed', description: 'also done' },
        ],
      }));
      const out = await __test_getContractStatus(ctx, cs);
      expect(out).toContain('(2/3 subtasks done)');
      expect(out).toContain('  ✓ t1: done');
      expect(out).toContain('  ○ t2: pending');
      expect(out).toContain('  ✓ t3: also done');
    });

    it('loadActive throws emits CONTRACT_ERROR audit + returns "Error loading"', async () => {
      const auditWrite = vi.fn();
      const ctx = makeMockCtx({}, auditWrite);
      const cs = makeMockContractSystem(async () => {
        throw new Error('database connection lost');
      });
      const out = await __test_getContractStatus(ctx, cs);
      expect(out).toBe('Contract: Error loading');
      expect(auditWrite).toHaveBeenCalledTimes(1);
      const call = auditWrite.mock.calls[0];
      expect(call[0]).toBe(STATUS_AUDIT_EVENTS.CONTRACT_ERROR);
      expect(call.some((s: unknown) => typeof s === 'string' && s.includes('database connection lost'))).toBe(true);
    });
  });

  describe('getTaskStatus', () => {
    it('both empty returns "idle"', async () => {
      const fs: Partial<FileSystem> = {
        list: vi.fn().mockResolvedValue([]),
      };
      const ctx = makeMockCtx(fs);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: idle');
    });

    it('running > 0 reports both running + pending counts', async () => {
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockResolvedValueOnce([makeEntry('t1.json'), makeEntry('t2.json')])  // pending
          .mockResolvedValueOnce([makeEntry('t3.json')]),                       // running
      };
      const ctx = makeMockCtx(fs);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: 1 running, 2 pending');
    });

    it('only pending (running empty) reports pending count', async () => {
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockResolvedValueOnce([makeEntry('p1.json'), makeEntry('p2.json'), makeEntry('p3.json')])
          .mockResolvedValueOnce([]),
      };
      const ctx = makeMockCtx(fs);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: 3 pending');
    });

    it('pending ENOENT silent (no audit) — first-startup case', async () => {
      const auditWrite = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockRejectedValueOnce(enoent)
          .mockResolvedValueOnce([]),
      };
      const ctx = makeMockCtx(fs, auditWrite);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: idle');
      // no TASK_PENDING_ERROR audit
      expect(auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR)).toBeUndefined();
    });

    it('pending non-ENOENT (EACCES) emits TASK_PENDING_ERROR audit', async () => {
      const auditWrite = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eacces: any = new Error('EACCES: permission denied');
      eacces.code = 'EACCES';
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockRejectedValueOnce(eacces)
          .mockResolvedValueOnce([]),
      };
      const ctx = makeMockCtx(fs, auditWrite);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: idle');
      expect(auditWrite).toHaveBeenCalledTimes(1);
      const call = auditWrite.mock.calls[0];
      expect(call[0]).toBe(STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR);
      expect(call.some((s: unknown) => typeof s === 'string' && s.includes('EACCES'))).toBe(true);
    });

    it('running non-ENOENT emits TASK_RUNNING_ERROR audit', async () => {
      const auditWrite = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ioerr: any = new Error('EIO: I/O error');
      ioerr.code = 'EIO';
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(ioerr),
      };
      const ctx = makeMockCtx(fs, auditWrite);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: idle');
      expect(auditWrite).toHaveBeenCalledTimes(1);
      const call = auditWrite.mock.calls[0];
      expect(call[0]).toBe(STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR);
      expect(call.some((s: unknown) => typeof s === 'string' && s.includes('EIO'))).toBe(true);
    });

    it('FS_NOT_FOUND code treated as ENOENT silent (sister handling for L1 FileNotFoundError)', async () => {
      const auditWrite = vi.fn();
      const fnf = new FileNotFoundError('/missing/dir');
      const fs: Partial<FileSystem> = {
        list: vi.fn()
          .mockRejectedValueOnce(fnf)
          .mockResolvedValueOnce([]),
      };
      const ctx = makeMockCtx(fs, auditWrite);
      const out = await __test_getTaskStatus(ctx);
      expect(out).toBe('Tasks: idle');
      expect(auditWrite.mock.calls.find(c => c[0] === STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR)).toBeUndefined();
    });
  });

  describe('getStorageStatus', () => {
    it('MEMORY.md exists returns size in KB', async () => {
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue('x'.repeat(2048)),  // 2KB
        list: vi.fn().mockResolvedValue([]),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines).toEqual(expect.arrayContaining([
        'MEMORY.md: 2.0KB',
        'Clawspace: 0 files',
      ]));
    });

    it('MEMORY.md missing reports "Not found"', async () => {
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockResolvedValue([]),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[0]).toBe('MEMORY.md: Not found');
    });

    it('MEMORY.md read fail returns "Error (...)" with message', async () => {
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockRejectedValue(new Error('permission denied')),
        list: vi.fn().mockResolvedValue([]),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[0]).toBe('MEMORY.md: Error (permission denied)');
    });

    it('clawspace populated reports correct count', async () => {
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockResolvedValue([
          makeEntry('a.md'), makeEntry('b.md'), makeEntry('c.md'),
        ]),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[1]).toBe('Clawspace: 3 files');
    });

    it('clawspace ENOENT treated as 0 files (silent)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockRejectedValue(enoent),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[1]).toBe('Clawspace: 0 files');
    });

    it('clawspace FS_NOT_FOUND treated as 0 files (silent sister code)', async () => {
      const fnf = new FileNotFoundError('/clawspace');
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockRejectedValue(fnf),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[1]).toBe('Clawspace: 0 files');
    });

    it('clawspace other error reports "Error (msg)"', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ioerr: any = new Error('EIO: bad');
      ioerr.code = 'EIO';
      const fs: Partial<FileSystem> = {
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockRejectedValue(ioerr),
      };
      const ctx = makeMockCtx(fs);
      const lines = await __test_getStorageStatus(ctx);
      expect(lines[1]).toBe('Clawspace: Error (EIO: bad)');
    });
  });
});
