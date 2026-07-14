/**
 * pid.ts — PID validation + discriminated union (Phase 1003)
 *           + spawning CAS deletion (Phase 1009)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { readPid, removePidIfSpawning } from '../../../src/foundation/process-manager/pid.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';

describe('readPid discriminated union (Phase 1003)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('pid-validation-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return { fs: nodeFs, audit };
  }

  async function writePidFile(clawId: string, content: string): Promise<void> {
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, content, 'utf-8');
  }

  it('returns valid for positive integer JSON pid', async () => {
    const ctx = makeCtx();
    await writePidFile('valid-json', JSON.stringify({ pid: FAKE_LIVE_PID }));

    const result = await readPid(ctx, testClawDaemonDir(tempDir, 'valid-json'));
    expect(result).toEqual({ status: 'valid', pid: FAKE_LIVE_PID, startTime: undefined });
  });

  it('returns spawning for pid=0 sentinel', async () => {
    const ctx = makeCtx();
    await writePidFile('spawning', JSON.stringify({ pid: 0 }));

    const result = await readPid(ctx, testClawDaemonDir(tempDir, 'spawning'));
    expect(result).toEqual({ status: 'spawning' });
  });

  it('rejects negative PID from legacy format', async () => {
    const ctx = makeCtx();
    await writePidFile('negative', '-5');

    const result = await readPid(ctx, testClawDaemonDir(tempDir, 'negative'));
    expect(result.status).toBe('corrupt');
  });

  it('rejects float PID from JSON', async () => {
    const ctx = makeCtx();
    await writePidFile('float', JSON.stringify({ pid: 3.14 }));

    const result = await readPid(ctx, testClawDaemonDir(tempDir, 'float'));
    expect(result.status).toBe('corrupt');
  });

  it('returns missing when pidfile does not exist', async () => {
    const ctx = makeCtx();

    const result = await readPid(ctx, testClawDaemonDir(tempDir, 'missing'));
    expect(result).toEqual({ status: 'missing' });
  });

  it('returns io_error when reading pidfile fails', async () => {
    const ctx = makeCtx();
    const clawId = 'io-err';
    await writePidFile(clawId, JSON.stringify({ pid: FAKE_LIVE_PID }));

    vi.spyOn(nodeFs, 'read').mockRejectedValueOnce(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    );

    const result = await readPid(ctx, testClawDaemonDir(tempDir, clawId));
    expect(result.status).toBe('io_error');
    expect('error' in result && (result as { error: string }).error).toContain('EIO');
  });
});

describe('removePidIfSpawning CAS (Phase 1009)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('pid-spawning-cas-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function makeCtx() {
    const { audit, events } = makeAudit();
    return { ctx: { fs: nodeFs, audit }, events };
  }

  async function writePidFile(clawId: string, content: string): Promise<void> {
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, content, 'utf-8');
  }

  async function pidFileExists(clawId: string): Promise<boolean> {
    try {
      await fs.access(path.join(tempDir, 'claws', clawId, 'status', 'pid'));
      return true;
    } catch {
      return false;
    }
  }

  it('deletes a stable {pid:0} sentinel and returns true', async () => {
    const { ctx, events } = makeCtx();
    await writePidFile('stable-spawn', JSON.stringify({ pid: 0 }));
    const daemonDir = testClawDaemonDir(tempDir, 'stable-spawn');

    const removed = await removePidIfSpawning(ctx, daemonDir);

    expect(removed).toBe(true);
    expect(await pidFileExists('stable-spawn')).toBe(false);
    expect(events.some(e => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_OK)).toBe(true);
  });

  it('returns false without deleting when pid transitions between reads', async () => {
    const { ctx, events } = makeCtx();
    await writePidFile('race-spawn', JSON.stringify({ pid: 0 }));
    const daemonDir = testClawDaemonDir(tempDir, 'race-spawn');

    vi.spyOn(nodeFs, 'read')
      .mockResolvedValueOnce(JSON.stringify({ pid: 0 }))
      .mockResolvedValueOnce(JSON.stringify({ pid: FAKE_LIVE_PID }));

    const removed = await removePidIfSpawning(ctx, daemonDir);

    expect(removed).toBe(false);
    expect(await pidFileExists('race-spawn')).toBe(true);
    expect(events.some(e => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_SPAWNING_RACE_AVOIDED)).toBe(true);
  });

  it('returns false when pidfile is not spawning', async () => {
    const { ctx, events } = makeCtx();
    await writePidFile('valid-pid', JSON.stringify({ pid: FAKE_LIVE_PID }));
    const daemonDir = testClawDaemonDir(tempDir, 'valid-pid');

    const removed = await removePidIfSpawning(ctx, daemonDir);

    expect(removed).toBe(false);
    expect(await pidFileExists('valid-pid')).toBe(true);
    expect(events.some(e => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_SPAWNING_RACE_AVOIDED)).toBe(false);
  });
});
