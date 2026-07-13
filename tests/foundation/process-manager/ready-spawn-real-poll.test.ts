/**
 * ready marker — real poll interval reverse (phase 1168 α-3 sub-α)
 *
 * 验证点：ready marker 在真实 SPAWN_POLL_INTERVAL_MS（50ms）内被检测。
 * 此文件独立以避免外层 vi.mock(constants) 污染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';

import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('ready-spawn real-poll interval', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    tempDir = path.join(tmpdir(), `ready-spawn-real-poll-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('ready marker 在真 poll interval 内被检测（不 mock SPAWN_POLL_INTERVAL_MS）', async () => {
    const { audit } = makeAudit();
    const clawId = 'real-poll-claw';
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
    };

    // 在 200ms 后写 ready marker（event-driven loop 无 deadline，永等到 ready）
    const writeDelay = 200;
    setTimeout(async () => {
      const statusDir = path.join(tempDir, 'claws', clawId, 'status');
      await fs.mkdir(statusDir, { recursive: true });
      await fs.writeFile(path.join(statusDir, 'ready'), JSON.stringify({ pid: process.pid }), 'utf-8');
    }, writeDelay);

    const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(process.pid);
  }, 10000); // 10s timeout 兜底
});
