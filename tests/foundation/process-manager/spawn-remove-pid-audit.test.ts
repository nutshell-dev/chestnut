/**
 * spawn — removePid silent → audit (P1.1)
 *
 * 验证点：spawn retry overwrite 路径中 removePid 失败时写入 PID_REMOVE_FAILED audit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 0 };
});

// Mock removePid to simulate failure (returns false and audits)
vi.mock('../../../src/foundation/process-manager/pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-manager/pid.js')>();
  return {
    ...actual,
    removePid: vi.fn().mockImplementation(async (ctx: any, _daemonDir: any, context: any) => {
      ctx.audit.write('pid_remove_failed', `daemon_dir=${_daemonDir}`, `context=${context}`, 'reason=[EACCES] EACCES permission denied');
      return false;
    }),
  };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('spawn — removePid silent → audit (P1.1)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    const { removePid } = await import('../../../src/foundation/process-manager/pid.js');
    vi.mocked(removePid).mockImplementation(async (ctx: any, _daemonDir: any, context: any) => {
      ctx.audit.write('pid_remove_failed', `daemon_dir=${_daemonDir}`, `context=${context}`, 'reason=[EACCES] EACCES permission denied');
      return false;
    });

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `spawn-audit-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('removePid 失败时写 PID_REMOVE_FAILED audit（不阻塞 retry overwrite）', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    let writeExclusiveCallCount = 0;
    vi.spyOn(nodeFs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
      writeExclusiveCallCount++;
      if (writeExclusiveCallCount === 1) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      return (NodeFileSystem.prototype as any).writeExclusiveSync.call(nodeFs, p, c);
    });

    const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(FAKE_LIVE_PID);
    expect(writeExclusiveCallCount).toBe(2);

    const pidRemoveEvents = events.filter(e => e[0] === 'pid_remove_failed');
    expect(pidRemoveEvents).toHaveLength(1);
    expect(pidRemoveEvents[0]).toEqual(
      expect.arrayContaining([
        'pid_remove_failed',
        expect.stringContaining('daemon_dir='),
        'context=spawn_retry_overwrite',
        expect.stringContaining('reason=[EACCES]'),
      ]),
    );
  });
});
