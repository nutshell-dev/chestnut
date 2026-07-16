import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  FileNotFoundError,
  type FileSystem,
} from '../../../src/foundation/fs/types.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import {
  isReady,
  markNotReady,
  markReady,
} from '../../../src/foundation/process-manager/ready.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { makeAudit } from '../../helpers/audit.js';
import {
  testClawDaemonDir,
  testMotionDaemonDir,
} from '../../helpers/daemon-dir.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import {
  cleanupTempDir,
  createTrackedTempDir,
} from '../../utils/temp.js';

/**
 * isReady stale marker self-cleanup（phase 1148 / C.1）
 *
 * 反向 3 项：
 * 1. STALE 分支触发 self-cleanup + marker 文件 0 残留
 * 2. ENOENT-on-delete 不致 isReady throw
 * 3. race-with-markReady：unlink 后 next markReady 重写 不丢 new marker
 */


describe('isReady stale marker self-cleanup（phase 1148 / C.1）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('ready-self-cleanup-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };
  }

  async function writePidFile(clawId: string, pid: number): Promise<void> {
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid }), 'utf-8');
  }

  it('反向 1：STALE 分支触发 self-cleanup + marker 文件 0 残留', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const nodeFsLocal = new NodeFileSystem({ baseDir: tempDir });
    const ctx: ProcessManagerContext = {
      fs: nodeFsLocal,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    // phase 1310 α-1: diagnostic dump on assertion fail (mirror phase 1307/1309 模板)
    const isReadyResult = isReady(ctx, testClawDaemonDir(tempDir, clawId));
    if (isReadyResult !== false) {
      const readyFileExists = await fs.access(readyFile).then(() => true).catch(() => false);
      const readyFileContent = readyFileExists
        ? await fs.readFile(readyFile, 'utf-8').catch(() => 'read-fail')
        : null;
      const pidFileContent = await fs.readFile(
        path.join(tempDir, 'claws', clawId, 'status', 'pid'),
        'utf-8',
      ).catch(() => 'read-fail');
      console.error('[phase1310-α-1] isReady returned true (expected false):', {
        isReadyResult,
        readyFileExists,
        readyFileContent,
        pidFileContent,
        eventsCount: events.length,
        allEvents: events,
      });
    }
    expect(isReadyResult).toBe(false);

    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
    );
    if (staleEvents.length !== 1) {
      console.error('[phase1310-α-1] staleEvents count mismatch:', {
        expected: 1,
        actual: staleEvents.length,
        allEvents: events,
      });
    }
    expect(staleEvents).toHaveLength(1);

    const markerStillExists = await fs.access(readyFile).then(() => true).catch(() => false);
    if (markerStillExists) {
      console.error('[phase1310-α-1] marker still exists after isReady (expected deleted):', {
        readyFile,
        eventsCount: events.length,
        allEvents: events,
      });
    }
    expect(markerStillExists).toBe(false);
  });

  it('反向 2：ENOENT-on-delete 不致 isReady throw', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const nodeFsLocal = new NodeFileSystem({ baseDir: tempDir });

    // mock deleteSync to throw ENOENT (simulating race where another cleanup already removed it)
    vi.spyOn(nodeFsLocal, 'deleteSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const ctx: ProcessManagerContext = {
      fs: nodeFsLocal,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    // should NOT throw despite delete rejecting ENOENT
    const result = isReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(result).toBe(false);

    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
    );
    expect(staleEvents).toHaveLength(1);
  });

  it('反向 3：race-with-markReady — unlink 后 next markReady 重写 不丢 new marker', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';

    await writePidFile(clawId, process.pid);

    // write stale marker
    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    // trigger self-cleanup via isReady
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);

    // immediately markReady with current process pid
    await markReady(ctx, testClawDaemonDir(tempDir, clawId));

    // next isReady should see fresh marker (not deleted by stale cleanup race)
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(true);
  });

  it('反向 4：happy path 不动', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);

    await markReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(true);

    await markNotReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);
  });
});

/**
 * Ready cleanup invariants
 *
 * Previously included ready-spawn integration tests; those were split out
 * to ready-spawn-integration.test.ts in Phase 1036.
 */

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
    deleteSync?: () => void;
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
      delete: vi.fn().mockResolvedValue(undefined),
      deleteSync: overrides?.deleteSync ?? vi.fn(),
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
        deleteSync: vi.fn(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

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
        deleteSync: vi.fn(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 3: delete succeeds → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        deleteSync: vi.fn(),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

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
    deleteSync?: () => void;
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
      delete: vi.fn().mockResolvedValue(undefined),
      deleteSync: overrides?.deleteSync ?? vi.fn(),
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

  describe('phase 1215: ready.ts stale deleteSync isFileNotFound narrow', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('reverse 1: delete throws FileNotFoundError → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        deleteSync: vi.fn(() => { throw new FileNotFoundError('/tmp/test-claw/ready'); }),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 2: delete throws raw ENOENT → 0 audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        deleteSync: vi.fn(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

      const staleCleanupFailedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
      );
      expect(staleCleanupFailedEvents).toHaveLength(0);
    });

    it('reverse 3: delete throws EACCES → audit emit READY_STALE_CLEANUP_FAILED', async () => {
      const { audit, events } = makeAudit();
      const mockFs = makeMockFs({
        deleteSync: vi.fn(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }),
      });
      const ctx: ProcessManagerContext = {
        fs: mockFs,
        audit,
        l1IsAlive: vi.fn().mockReturnValue(true),
      };

      expect(isReady(ctx, 'test-claw')).toBe(false);

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

/**
 * Phase 1132 D.1: ready.ts isReady 3 bare catch → narrow ENOENT + audit emit
 *
 * 反向测试：
 * 1. non-ENOENT read error → READY_CHECK_READ_FAILED audit + return false
 * 2. ENOENT read → silent return false + 0 audit emit
 * 3. corrupt JSON → READY_CHECK_PARSE_FAILED audit + return false
 * 4. l1IsAlive throw → READY_CHECK_ISALIVE_THROW audit + return false
 */


function makeMockFs(overrides?: {
  readSync?: (p: string) => string;
}): FileSystem {
  return {
    readSync: overrides?.readSync ?? vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    writeAtomicSync: vi.fn(),
    append: vi.fn(),
    appendSync: vi.fn(),
    delete: vi.fn(),
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

describe('phase 1132 D.1: isReady narrow catch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('反向 1: non-ENOENT read error → READY_CHECK_READ_FAILED audit + return false', () => {
    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const readFailedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
    );
    expect(readFailedEvents).toHaveLength(1);
    expect(readFailedEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
        expect.stringContaining(''),
        expect.stringContaining('reason='),
      ]),
    );
  });

  it('反向 2: ENOENT read → silent return false + 0 audit emit', () => {
    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('反向 3: corrupt JSON → READY_CHECK_PARSE_FAILED audit + return false', () => {
    const { audit, events } = makeAudit();
    let callCount = 0;
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 'not-json';
        return JSON.stringify({ pid: 12345 });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const parseFailedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
    );
    expect(parseFailedEvents).toHaveLength(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
        expect.stringContaining(''),
        expect.stringContaining('reason='),
      ]),
    );
  });

  it('反向 4: l1IsAlive throw → READY_CHECK_ISALIVE_THROW audit + return false', async () => {
    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation((p: string) => {
        if (p.includes('ready')) return JSON.stringify({ pid: 12345 });
        return JSON.stringify({ pid: 12345 });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };
    vi.mocked(ctx.l1IsAlive!).mockImplementation(() => {
      throw new Error('ps exec failed');
    });

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const isAliveThrowEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
    );
    expect(isAliveThrowEvents).toHaveLength(1);
    expect(isAliveThrowEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
        expect.stringContaining(''),
        expect.stringContaining('ready_pid=12345'),
        expect.stringContaining('reason='),
      ]),
    );
  });
});
