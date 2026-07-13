/**
 * ready marker — isReady / markReady / markNotReady (phase 1114)
 *
 * 验证点：
 * 1. markReady → isReady true → markNotReady → isReady false
 * 2. 反向 1：mark 写完不 delete → isReady 持 true
 * 3. 反向 2：corrupt JSON → isReady false
 * 4. 反向 3：stale marker (PID mismatch) → isReady false + READY_MARK_STALE audit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { markReady, markNotReady, isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_STRING } from '../../helpers/test-pids.js';
import { waitForPathGone } from '../../helpers/wait-for-file.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

/** Stale marker self-cleanup safety budget (1s). phase 368: event-driven 替原 50ms × 20 polling. */
const STALE_MARKER_BUDGET_MS = 1000;

describe('isReady / markReady / markNotReady', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    tempDir = path.join(tmpdir(), `ready-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

  it('markReady → isReady true → markNotReady → isReady false', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);

    await markReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(true);

    await markNotReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);
  });

  it('反向 1：mark 写完不 delete → isReady 持 true', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    await markReady(ctx, testClawDaemonDir(tempDir, clawId));
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(true);

    // 不调用 markNotReady，isReady 仍应为 true
    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(true);
  });

  it('反向 2：corrupt JSON → isReady false', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, 'not-json', 'utf-8');

    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);
  });

  it('反向 3：stale marker (PID mismatch) → isReady false + READY_MARK_STALE audit + self-cleanup', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const nodeFsLocal = new NodeFileSystem({ baseDir: tempDir });
    const ctx: ProcessManagerContext = {
      fs: nodeFsLocal,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };

    // pidFile 写当前进程 PID
    await writePidFile(clawId, process.pid);

    // ready marker 写不同的 PID（模拟 stale）
    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    expect(isReady(ctx, testClawDaemonDir(tempDir, clawId))).toBe(false);

    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
        expect.stringContaining('daemon_dir='),
        expect.stringContaining(`ready_pid=${FAKE_LIVE_PID}`),
        expect.stringContaining(`pid_file_pid=${process.pid}`),
      ]),
    );

    // r127 C.1: stale marker self-cleanup — async delete (fire-and-forget in isReady).
    // phase 368: file-watcher 'unlink' event 替原 polling.
    await waitForPathGone(readyFile, STALE_MARKER_BUDGET_MS);
    const markerStillExists = await fs.access(readyFile).then(() => true).catch(() => false);
    expect(markerStillExists).toBe(false);
  });
});
