/**
 * stop.ts — generation authority (Phase 1204 Step D/E)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { stopProcess } from '../../../src/foundation/process-manager/stop.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

import {
  GENERATION_FILE,
  PID_FILE,
  READY_FILE,
  getSpawningDir,
  getActiveDir,
  getRetiredDirFor,
  getStopIntentsDir,
} from '../../../src/foundation/process-manager/generation.js';

async function writeGeneration(
  baseDir: string,
  daemonDir: string,
  source: 'spawning' | 'active',
  generationId: string,
  pid: number,
  startTime?: string,
): Promise<void> {
  const dir = source === 'spawning' ? getSpawningDir(daemonDir) : getActiveDir(daemonDir);
  await fs.mkdir(dir, { recursive: true });
  const record = {
    schema_version: 1,
    generation_id: generationId,
    daemon_dir: daemonDir,
    parent_pid: process.pid,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, GENERATION_FILE), JSON.stringify(record), 'utf-8');
  const pidRecord = {
    schema_version: 1,
    generation_id: generationId,
    pid,
    ...(startTime ? { start_time: startTime } : {}),
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, PID_FILE), JSON.stringify(pidRecord), 'utf-8');
  if (source === 'active') {
    const readyRecord = { ...pidRecord };
    await fs.writeFile(path.join(dir, READY_FILE), JSON.stringify(readyRecord), 'utf-8');
  }
}

describe('stopProcess generation authority (Phase 1204 Step D)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('stop-gen-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(audit: ProcessManagerContext['audit']): ProcessManagerContext {
    return {
      fs: nodeFs,
      audit,
      l1IsAlive: () => true,
      kill: vi.fn(),
    };
  }

  it('stops active generation and retires it', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-active';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-active-1';
    await writeGeneration(tempDir, daemonDir, 'active', generationId, FAKE_LIVE_PID);

    let alive = false;
    const ctx = { ...makeCtx(audit), l1IsAlive: () => alive };

    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(ctx.kill).not.toHaveBeenCalled();
    expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, generationId))).toBe(true);

    const stoppedEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED);
    expect(stoppedEvents).toHaveLength(1);
  });

  it('kills spawning generation with pid and retires it', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-spawning-pid';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-spawning-pid';
    await writeGeneration(tempDir, daemonDir, 'spawning', generationId, FAKE_LIVE_PID);

    let alive = true;
    const ctx = { ...makeCtx(audit), l1IsAlive: () => alive, kill: vi.fn(() => { alive = false; }) };

    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(ctx.kill).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, generationId))).toBe(true);
  });

  it('records stop intent when spawning generation has no pid yet', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-spawning-intent';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-spawning-intent';
    const spawningDir = getSpawningDir(daemonDir);
    await fs.mkdir(spawningDir, { recursive: true });
    const record = {
      schema_version: 1,
      generation_id: generationId,
      daemon_dir: daemonDir,
      parent_pid: process.pid,
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(spawningDir, GENERATION_FILE), JSON.stringify(record), 'utf-8');

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(ctx.kill).not.toHaveBeenCalled();
    const intentsDir = getStopIntentsDir(daemonDir);
    const intentFiles = await fs.readdir(intentsDir);
    expect(intentFiles.length).toBe(1);

    const intentEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.STOP_INTENT_RECORDED);
    expect(intentEvents).toHaveLength(1);
  });

  it('returns false idempotently when no generation or pidfile exists', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-idempotent';
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(false);
    expect(ctx.kill).not.toHaveBeenCalled();
  });

  it('returns false on malformed active generation', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-malformed';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const activeDir = getActiveDir(daemonDir);
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, GENERATION_FILE), 'not-json', 'utf-8');

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(false);
    expect(ctx.kill).not.toHaveBeenCalled();
  });

  it('tracks generation across spawning → active relocation', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-relocate';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-relocate';
    const spawningDir = getSpawningDir(daemonDir);
    await fs.mkdir(spawningDir, { recursive: true });
    const record = {
      schema_version: 1,
      generation_id: generationId,
      daemon_dir: daemonDir,
      parent_pid: process.pid,
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(spawningDir, GENERATION_FILE), JSON.stringify(record), 'utf-8');
    const pidRecord = {
      schema_version: 1,
      generation_id: generationId,
      pid: FAKE_LIVE_PID,
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(spawningDir, PID_FILE), JSON.stringify(pidRecord), 'utf-8');

    let moved = false;
    let alive = true;
    const killSpy = vi.fn((_pid: number, signal: string) => {
      if (signal === 'TERM') alive = false;
    });
    const ctx = {
      ...makeCtx(audit),
      kill: killSpy,
      l1IsAlive: () => {
        if (!moved) {
          // Simulate child activate between intent write and signal delivery.
          nodeFs.moveDirSync(spawningDir, getActiveDir(daemonDir));
          moved = true;
        }
        return alive;
      },
    };

    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
    expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, generationId))).toBe(true);
  });

  it('fails closed when active slot generation identity is inconsistent', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'stop-foreign-active';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const targetGenerationId = 'gen-expected';
    const observedGenerationId = 'gen-foreign';
    const activeDir = getActiveDir(daemonDir);
    await fs.mkdir(activeDir, { recursive: true });
    // Active directory names one generation but pid.json belongs to another.
    const record = {
      schema_version: 1,
      generation_id: targetGenerationId,
      daemon_dir: daemonDir,
      parent_pid: process.pid,
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(activeDir, GENERATION_FILE), JSON.stringify(record), 'utf-8');
    const pidRecord = {
      schema_version: 1,
      generation_id: observedGenerationId,
      pid: FAKE_LIVE_PID,
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(activeDir, PID_FILE), JSON.stringify(pidRecord), 'utf-8');

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(false);
    expect(ctx.kill).not.toHaveBeenCalled();
  });

  it('does not falsely report not_running when generation activates between active and spawning reads', async () => {
    const { audit } = makeAudit();
    const clawId = 'stop-lookup-race';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-lookup-race';
    await writeGeneration(tempDir, daemonDir, 'spawning', generationId, FAKE_LIVE_PID);

    const activeGenerationPath = path.join(getActiveDir(daemonDir), GENERATION_FILE);
    let moved = false;
    const originalReadSync = nodeFs.readSync.bind(nodeFs);
    vi.spyOn(nodeFs, 'readSync').mockImplementation((p) => {
      if (p === activeGenerationPath && !moved) {
        moved = true;
        nodeFs.moveDirSync(getSpawningDir(daemonDir), getActiveDir(daemonDir));
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return originalReadSync(p as string);
    });

    let alive = false;
    const ctx = { ...makeCtx(audit), l1IsAlive: () => alive };

    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(ctx.kill).not.toHaveBeenCalled();
    expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, generationId))).toBe(true);
  });

  it('retries retire from active when generation activates between locate and retire', async () => {
    const { audit } = makeAudit();
    const clawId = 'stop-retire-race';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const generationId = 'gen-retire-race';
    await writeGeneration(tempDir, daemonDir, 'spawning', generationId, FAKE_LIVE_PID);

    const spawningGenerationPath = path.join(getSpawningDir(daemonDir), GENERATION_FILE);
    let moved = false;
    let readCount = 0;
    const originalReadSync = nodeFs.readSync.bind(nodeFs);
    vi.spyOn(nodeFs, 'readSync').mockImplementation((p) => {
      if (p === spawningGenerationPath) {
        readCount++;
        // 第一次：inspectTarget 读 spawning generation
        // 第二次：locateGeneration 读 spawning generation
        // 第三次：retireGeneration 读 spawning generation（触发 move）
        if (readCount === 3 && !moved) {
          moved = true;
          nodeFs.moveDirSync(getSpawningDir(daemonDir), getActiveDir(daemonDir));
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalReadSync(p as string);
    });

    let alive = false;
    const ctx = { ...makeCtx(audit), l1IsAlive: () => alive };

    const result = await stopProcess(ctx, daemonDir);

    expect(result).toBe(true);
    expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, generationId))).toBe(true);
  });
});
