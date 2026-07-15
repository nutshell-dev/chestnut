/**
 * Ready invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - ready-spawn-integration.test.ts
 *  - ready-stale-cleanup-narrow.test.ts
 *  - ready-cleanup-narrow.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

/**
 * ready marker — spawn poll predicate 切换 verify (phase 1114，phase 1317 升级 event-driven)
 *
 * 验证点：
 * 1. spawn poll 等 markReady 才返回（mock 慢 boot）
 * 2. isAlive 若干次后 false → fast-fail throw "died during boot"
 * 3. spawn 失败时 cleanup 路径走真 audit emit + 状态文件 0 残留
 */
describe('ready-spawn-integration', () => {
  describe('ready-spawn integration', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('ready-spawn-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('spawn poll 等 markReady 才返回（mock 慢 boot）', async () => {
      const { audit } = makeAudit();
      const clawId = 'test-claw';
      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
      };

      // 延迟写 ready marker，模拟 daemon 慢 boot
      setTimeout(async () => {
        const statusDir = path.join(tempDir, 'claws', clawId, 'status');
        await fs.mkdir(statusDir, { recursive: true });
        await fs.writeFile(path.join(statusDir, 'ready'), JSON.stringify({ pid: process.pid }), 'utf-8');
      }, 50);

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(process.pid);
    });

    it('isAlive 若干次后 false → fast-fail throw "died during boot"', async () => {
      const { audit } = makeAudit();
      const clawId = 'test-claw';
      let aliveCallCount = 0;
      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isAlive: () => {
          aliveCallCount++;
          if (aliveCallCount === 1) return false;
          return aliveCallCount < 5;
        },
        isReady: () => false,
      };

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);
    });

    it('spawn 失败时 cleanup 路径走真 audit emit + 状态文件 0 残留', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'cleanup-test-claw';
      let aliveCallCount = 0;
      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isAlive: () => {
          aliveCallCount++;
          if (aliveCallCount === 1) return false;
          return aliveCallCount < 5;
        },
        isReady: () => false,
      };

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);

      expect(events.some(e => e[0] === 'process_spawn_failed')).toBe(true);
      await expect(fs.access(path.join(tempDir, 'claws', clawId, 'status', 'ready')))
        .rejects.toThrow();
    });
  });
});

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
