/**
 * Real subprocess stop race (Phase 1204 Step G).
 *
 * Uses an actual detached child that waits for a barrier, activates its own
 * generation (spawning → active), and then stays alive until SIGTERM. The stop
 * protocol is allowed to locate the generation in spawning; the barrier lets the
 * child activate while stop is waiting for the process to die, so the final
 * retire must converge on the active directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { stopProcess } from '../../../src/foundation/process-manager/stop.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  writeChildPid,
  inspectRetiredGeneration,
  getSpawningDir,
  getActiveDir,
  getRetiredDirFor,
  PROCESS_GENERATION_ENV,
} from '../../../src/foundation/process-manager/generation.js';
import {
  spawnDetached as defaultSpawnDetached,
  isAlive as defaultL1IsAlive,
  kill as defaultKill,
  getProcessStartTime as defaultGetProcessStartTime,
} from '../../../src/foundation/process-exec/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    DAEMON_SHUTDOWN_GRACE_MS: 0,
    PROCESS_STOP_POLL_INTERVAL_MS: 10,
    SIGKILL_DEAD_VERIFY_GRACE_MS: 50,
  };
});

const CHILD_SCRIPT = fileURLToPath(new URL('../../helpers/daemon-race-child.cjs', import.meta.url));

describe('stop real process race (Phase 1204 Step G)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  const childPids: number[] = [];

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('stop-real-');
    await fs.promises.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    childPids.length = 0;
  });

  afterEach(async () => {
    for (const pid of childPids) {
      try {
        defaultKill(pid, 'KILL');
      } catch {
        // already dead
      }
    }
    await cleanupTempDir(tempDir);
  });

  it('retires generation in active after child activates during stop', async () => {
    const { audit } = makeAudit();
    const clawId = 'stop-real-race';
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      l1IsAlive: defaultL1IsAlive,
      kill: defaultKill,
      spawnDetached: defaultSpawnDetached,
      getProcessStartTime: defaultGetProcessStartTime,
    };

    // Parent prepares the generation and commits it to spawning.
    const record = newProcessGeneration(ctx, daemonDir);
    const generationId = record.generation_id;
    prepareGeneration(ctx, record);
    expect(commitSpawning(ctx, record).kind).toBe('committed');

    // Spawn the real child that will activate on demand.
    const logFile = path.join(daemonDir, 'logs', 'child.log');
    nodeFs.ensureDirSync(path.dirname(logFile));
    // phase 1763: spawnDetached 返回 typed outcome（Promise），提交点 = spawn 事件
    const { pid } = await defaultSpawnDetached(process.execPath, [CHILD_SCRIPT, daemonDir], {
      logFile,
      env: { [PROCESS_GENERATION_ENV]: generationId, NODE_ENV: 'test' },
    });
    childPids.push(pid);

    const childStartTime = defaultGetProcessStartTime(pid);
    expect((await writeChildPid(ctx, record, pid, childStartTime)).kind).toBe('written');

    // Barrier: let stop locate the generation in spawning, then let the child
    // activate before the process actually dies.
    const barrierPath = path.join(daemonDir, 'status', 'process', 'child-go');
    let barrierWritten = false;
    const l1IsAlive = (checkedPid: number, startTime?: string): boolean => {
      if (!barrierWritten) {
        barrierWritten = true;
        nodeFs.ensureDirSync(path.dirname(barrierPath));
        nodeFs.writeAtomicSync(barrierPath, 'go');
        // Deterministically wait for the child to finish activating.
        const deadline = Date.now() + 5000;
        while (!nodeFs.existsSync(getActiveDir(daemonDir)) && Date.now() < deadline) {
          // spin
        }
      }
      return defaultL1IsAlive(checkedPid, startTime);
    };

    const result = await stopProcess({ ...ctx, l1IsAlive }, daemonDir);

    expect(result).toBe(true);
    expect(defaultL1IsAlive(pid, childStartTime)).toBe(false);
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
    const retired = inspectRetiredGeneration({ fs: nodeFs, audit }, daemonDir, generationId);
    expect(retired.status).toBe('ok');
    expect(retired.record.generation_id).toBe(generationId);
    expect(getRetiredDirFor(daemonDir, generationId)).toEqual(expect.any(String));
  });
});
