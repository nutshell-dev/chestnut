/**
 * stop.ts — sentinel / I/O guard / removePid result (Phase 1003)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { stopProcess } from '../../../src/foundation/process-manager/stop.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SIGKILL_DEAD_VERIFY_GRACE_MS: 0 };
});

describe('stopProcess Phase 1003 guards', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `stop-guard-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx(audit: ProcessManagerContext['audit']): ProcessManagerContext {
    return {
      fs: nodeFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(false),
      kill: vi.fn(),
    };
  }

  async function writePidFile(clawId: string, content: string): Promise<void> {
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, content, 'utf-8');
  }

  it('does not kill when pid file contains spawning sentinel', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-spawning';
    await writePidFile(clawId, JSON.stringify({ pid: 0 }));

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, testClawDaemonDir(tempDir, clawId));

    expect(result).toBe(true);
    expect(ctx.kill).not.toHaveBeenCalled();

    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);

    const stopFailed = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED);
    expect(stopFailed).toHaveLength(0);
  });

  it('returns false on I/O error reading pidfile', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-ioerr';
    await writePidFile(clawId, JSON.stringify({ pid: FAKE_LIVE_PID }));

    vi.spyOn(nodeFs, 'read').mockRejectedValueOnce(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    );

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, testClawDaemonDir(tempDir, clawId));

    expect(result).toBe(false);
    expect(ctx.kill).not.toHaveBeenCalled();

    const stopFailed = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED);
    expect(stopFailed).toHaveLength(1);
  });

  it('returns false and does not kill on corrupt pidfile', async () => {
    const { audit } = makeAudit();
    const clawId = 'stop-corrupt';
    await writePidFile(clawId, '-5');

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, testClawDaemonDir(tempDir, clawId));

    expect(result).toBe(false);
    expect(ctx.kill).not.toHaveBeenCalled();
  });

  it('returns false when pidfile removal fails', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-rmfail';
    await writePidFile(clawId, JSON.stringify({ pid: FAKE_LIVE_PID }));

    vi.spyOn(nodeFs, 'delete').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, testClawDaemonDir(tempDir, clawId));

    expect(result).toBe(false);

    const removeFailed = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED);
    expect(removeFailed).toHaveLength(1);
  });
});
