/**
 * pid.ts — PID validation + discriminated union (Phase 1003)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { readPid } from '../../../src/foundation/process-manager/pid.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

describe('readPid discriminated union (Phase 1003)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `pid-validation-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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
