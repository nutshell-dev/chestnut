/**
 * ready marker — spawn poll predicate 切换 verify (phase 1114)
 *
 * 验证点：
 * 1. spawn poll 等 markReady 才返回（mock 慢 boot）
 * 2. spawn 超时当 ready marker 始终不出现，error msg 含 alive 状态
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, PROCESS_SPAWN_CONFIRM_MS: 500, SPAWN_POLL_INTERVAL_MS: 10 };
});

// Mock spawnDetached so no real process starts; use process.pid so l1IsAlive passes for real
vi.mock('../../../src/foundation/process-exec/spawn-detached.js', () => ({
  spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
}));

describe('ready-spawn integration', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    const { spawnDetached } = await import('../../../src/foundation/process-exec/spawn-detached.js');
    vi.mocked(spawnDetached).mockReturnValue({ pid: process.pid } as any);

    tempDir = path.join(tmpdir(), `ready-spawn-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('spawn poll 等 markReady 才返回（mock 慢 boot）', async () => {
    const { audit } = makeAudit();
    const clawId = 'test-claw';
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    // 延迟写 ready marker，模拟 daemon 慢 boot
    setTimeout(async () => {
      const statusDir = path.join(tempDir, 'claws', clawId, 'status');
      await fs.mkdir(statusDir, { recursive: true });
      await fs.writeFile(path.join(statusDir, 'ready'), JSON.stringify({ pid: process.pid }), 'utf-8');
    }, 50);

    const result = await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(process.pid);
  });

  it('spawn 超时当 ready marker 始终不出现，error msg 含 alive=true', async () => {
    const { audit } = makeAudit();
    const clawId = 'test-claw';
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    await expect(
      spawnProcess(ctx, clawId, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(`Process "${clawId}" failed to become ready (alive=true)`);
  });
});
