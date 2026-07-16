/**
 * Ready cleanup invariants
 *
 * Previously included ready-spawn integration tests; those were split out
 * to ready-spawn-integration.test.ts in Phase 1036.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';

/**
 * Phase 1161 r128 C fork C.1: ready.ts:99 stale cleanup narrow ENOENT
 *
 * 反向测试：
 * 1. delete throws non-ENOENT (EACCES) → READY_STALE_CLEANUP_FAILED audit + isReady returns false
 * 2. delete throws ENOENT → 0 audit emit + isReady returns false (benign race)
 * 3. delete succeeds → 0 audit emit + isReady returns false
 */
describe('ready-stale-cleanup-narrow', () => {
  function makeMockFs(overrides?: {
    delete?: () => Promise<void>;
  }): FileSystem {
    return {
      readSync: vi.fn().mockImplementation((p: string) => {
        if (p.includes('ready')) return JSON.stringify({ pid: 11111 });
        return JSON.stringify({ pid: 22222 });
      }),
      read: vi.fn(),
      writeAtomic: vi.fn(),
      writeAtomicSync: vi.fn(),
      append: vi.fn(),
      appendSync: vi.fn(),
      delete: overrides?.delete ?? vi.fn().mockResolvedValue(undefined),
      move: vi.fn(),
      ensureDir: vi.fn(),
      removeDir: vi.fn(),
      list: vi.fn(),
      realpath: vi.fn(),
      exists: vi.fn(),
      isDirectory: vi.fn(),
      stat: vi.fn(),
      writeExclusiveSync: vi.fn(),
      readBytesSync: vi.fn(),
      statSync: vi.fn(),
    } as unknown as FileSystem;
  }

  describe('phase 1161 r128 C fork: ready stale cleanup narrow ENOENT', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('reverse 1: delete throws non-ENOENT (EACCES) → audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      // wait for the fire-and-forget catch handler to execute
      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(1);
      expect(staleCleanupFailedEvents[0]).toEqual(
        expect.arrayContaining([
          PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
          expect.stringContaining(''),
          expect.stringContaining('reason='),
        ]),
      );
    });

    it('reverse 2: delete throws ENOENT → 0 audit emit READY_STALE_CLEANUP_FAILED (benign race)', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' })),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 3: delete succeeds → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockResolvedValue(undefined),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });
  });
});

/**
 * Phase 1215: ready.ts:98 isReady stale cleanup isFileNotFound dual-code narrow
 *
 * 反向测试：
 * 1. FileNotFoundError (FileSystem abstract layer FS_NOT_FOUND) → 0 audit emit
 * 2. raw ENOENT → 0 audit emit
 * 3. EACCES → emit READY_STALE_CLEANUP_FAILED
 */
describe('ready-cleanup-narrow', () => {
  function makeMockFs(overrides?: {
    delete?: () => Promise<void>;
  }): FileSystem {
    return {
      readSync: vi.fn().mockImplementation((p: string) => {
        if (p.includes('ready')) return JSON.stringify({ pid: 11111 });
        return JSON.stringify({ pid: 22222 });
      }),
      read: vi.fn(),
      writeAtomic: vi.fn(),
      writeAtomicSync: vi.fn(),
      append: vi.fn(),
      appendSync: vi.fn(),
      delete: overrides?.delete ?? vi.fn().mockResolvedValue(undefined),
      move: vi.fn(),
      ensureDir: vi.fn(),
      removeDir: vi.fn(),
      list: vi.fn(),
      realpath: vi.fn(),
      exists: vi.fn(),
      isDirectory: vi.fn(),
      stat: vi.fn(),
      writeExclusiveSync: vi.fn(),
      readBytesSync: vi.fn(),
      statSync: vi.fn(),
      listSync: vi.fn(),
    } as unknown as FileSystem;
  }

  describe('phase 1215: ready.ts:98 fire-and-forget delete isFileNotFound narrow', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('reverse 1: delete throws FileNotFoundError → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockRejectedValue(new FileNotFoundError('/tmp/test-claw/ready')),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 2: delete throws raw ENOENT → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' })),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 3: delete throws EACCES → audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        delete: vi.fn().mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(1);
      expect(staleCleanupFailedEvents[0]).toEqual(
        expect.arrayContaining([
          PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
          expect.stringContaining(''),
          expect.stringContaining('reason='),
        ]),
      );
    });
  });
});
