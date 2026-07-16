/**
 * ready-spawn integration
 *
 * Restored from ready-invariants.test.ts in Phase 1036.
 * These assertions exercise spawnProcess() and run in the integration-process project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// spawnDetached injected via ctx (phase 106 DI hygiene)

/** Delay before writing the ready marker to simulate a slow daemon boot (ms). */
const READY_MARKER_DELAY_MS = 50;

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
      }, READY_MARKER_DELAY_MS);

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
