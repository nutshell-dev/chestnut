/**
 * isReady stale marker self-cleanup（phase 1148 / C.1）
 *
 * 反向 3 项：
 * 1. STALE 分支触发 self-cleanup + marker 文件 0 残留
 * 2. ENOENT-on-delete 不致 isReady throw
 * 3. race-with-markReady：unlink 后 next markReady 重写 不丢 new marker
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { markReady, markNotReady, isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn().mockReturnValue(true),
  };
});

describe('isReady stale marker self-cleanup（phase 1148 / C.1）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    tempDir = path.join(tmpdir(), `ready-self-cleanup-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
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
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    // phase 1310 α-1: diagnostic dump on assertion fail (mirror phase 1307/1309 模板)
    const isReadyResult = isReady(ctx, clawId);
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

    // mock delete to reject ENOENT (simulating race where another cleanup already removed it)
    vi.spyOn(nodeFsLocal, 'delete').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const ctx: ProcessManagerContext = {
      fs: nodeFsLocal,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    // should NOT throw despite delete rejecting ENOENT
    const result = isReady(ctx, clawId);
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
    expect(isReady(ctx, clawId)).toBe(false);

    // immediately markReady with current process pid
    await markReady(ctx, clawId);

    // next isReady should see fresh marker (not deleted by stale cleanup race)
    expect(isReady(ctx, clawId)).toBe(true);
  });

  it('反向 4：happy path 不动', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    expect(isReady(ctx, clawId)).toBe(false);

    await markReady(ctx, clawId);
    expect(isReady(ctx, clawId)).toBe(true);

    await markNotReady(ctx, clawId);
    expect(isReady(ctx, clawId)).toBe(false);
  });
});
