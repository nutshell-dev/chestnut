import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { isAlive } from '../../../src/foundation/process-exec/process-control.js';
import * as startTimeModule from '../../../src/foundation/process-exec/process-starttime.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import {
  readPid,
  removePidIfMatch,
  selfWritePid,
} from '../../../src/foundation/process-manager/pid.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { makeAudit } from '../../helpers/audit.js';
import {
  testClawDaemonDir,
  testMotionDaemonDir,
} from '../../helpers/daemon-dir.js';
import {
  FAKE_LIVE_PID,
  FAKE_LIVE_PID_CAS,
} from '../../helpers/test-pids.js';
import {
  cleanupTempDir,
  createTrackedTempDir,
} from '../../utils/temp.js';

/**
 * PID file format migration (phase 1023)
 *
 * 验证点：
 * 1. readPid graceful fallback legacy raw int + audit PID_FILE_LEGACY_FORMAT
 * 2. readPid JSON format new caller
 * 3. selfWritePid emits JSON with startTime on POSIX
 */


describe('PID file format migration (phase 1023)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('pid-fmt-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
    };
  }

  it('readPid graceful fallback legacy raw int + audit PID_FILE_LEGACY_FORMAT', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, String(FAKE_LIVE_PID), 'utf-8');

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
    };

    const result = await readPid(ctx, testClawDaemonDir(tempDir, clawId));
    expect(result).toEqual({ status: 'valid', pid: FAKE_LIVE_PID, startTime: undefined });

    const legacyEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT,
    );
    expect(legacyEvents).toHaveLength(1);
    expect(legacyEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT,
        expect.stringContaining('daemon_dir='),        `pid=${FAKE_LIVE_PID}`,
      ]),
    );
  });

  it('readPid JSON format new caller', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID, startTime: 'Sat May 18 10:30:00 2026' }), 'utf-8');

    const result = await readPid(ctx, testClawDaemonDir(tempDir, clawId));
    expect(result).toEqual({ status: 'valid', pid: FAKE_LIVE_PID, startTime: 'Sat May 18 10:30:00 2026' });
  });

  it('readPid returns null for invalid content', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, 'not-a-number', 'utf-8');

    const result = await readPid(ctx, testClawDaemonDir(tempDir, clawId));
    expect(result).toEqual({ status: 'corrupt', error: expect.stringContaining('unparseable pid content') });
  });

  it('selfWritePid emits JSON with startTime on POSIX', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue('Sat May 18 10:30:00 2026');

    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
    };

    await selfWritePid(ctx, testClawDaemonDir(tempDir, clawId));

    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    const content = await fs.readFile(pidFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ pid: process.pid, startTime: 'Sat May 18 10:30:00 2026' });

    const writeOkEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK);
    expect(writeOkEvents).toHaveLength(1);
    expect(writeOkEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
        expect.stringContaining('daemon_dir='),        `pid=${process.pid}`,
        'startTime=Sat May 18 10:30:00 2026',
      ]),
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('selfWritePid emits JSON without startTime when getProcessStartTime returns undefined', async () => {
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue(undefined);

    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
    };

    await selfWritePid(ctx, testClawDaemonDir(tempDir, clawId));

    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    const content = await fs.readFile(pidFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ pid: process.pid });

    const writeOkEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK);
    expect(writeOkEvents).toHaveLength(1);
    expect(writeOkEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
        expect.stringContaining('daemon_dir='),        `pid=${process.pid}`,
        'startTime_skipped',
      ]),
    );
  });
});

/**
 * PID startTime verify + CAS (phase 1023)
 *
 * 验证点：
 * 1. isAlive false on stale pid + startTime mismatch (PID-wrap defense)
 * 2. isAlive true when startTime matches
 * 3. isAlive skip verify when expectedStartTime undefined
 * 4. isAlive skip verify on Windows
 * 5. removePidIfMatch CAS reject mismatched pid
 * 6. removePidIfMatch CAS reject mismatched startTime
 * 7. removePidIfMatch CAS accept matched pid + startTime
 */

describe('isAlive with expectedStartTime', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns false when startTime mismatches (PID-wrap defense)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue('Mon Jan 01 00:00:00 2020');

    expect(isAlive(12345, 'Sat May 18 10:30:00 2026')).toBe(false);
  });

  it('returns true when startTime matches', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue('Sat May 18 10:30:00 2026');

    expect(isAlive(12345, 'Sat May 18 10:30:00 2026')).toBe(true);
  });

  it('returns true when expectedStartTime is undefined (skip verify)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    expect(isAlive(12345)).toBe(true);
    expect(isAlive(12345, undefined)).toBe(true);
  });

  it('returns true on Windows even with mismatch', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue('Mon Jan 01 00:00:00 2020');

    expect(isAlive(12345, 'Sat May 18 10:30:00 2026')).toBe(true);
  });

  it('falls back to kill-only when getProcessStartTime returns undefined', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue(undefined);

    expect(isAlive(12345, 'Sat May 18 10:30:00 2026')).toBe(true);
  });
});

describe('removePidIfMatch CAS', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('pid-cas-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
    };
  }

  it('reject mismatched pid', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_CAS }), 'utf-8');

    const result = await removePidIfMatch(ctx, testClawDaemonDir(tempDir, clawId), 22222);
    expect(result).toBe(false);

    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);
  });

  it('reject mismatched startTime', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_CAS, startTime: 'A' }), 'utf-8');

    const result = await removePidIfMatch(ctx, testClawDaemonDir(tempDir, clawId), 11111, 'B');
    expect(result).toBe(false);

    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);
  });

  it('accept matched pid + startTime and remove', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_CAS, startTime: 'A' }), 'utf-8');

    const result = await removePidIfMatch(ctx, testClawDaemonDir(tempDir, clawId), 11111, 'A');
    expect(result).toBe(true);

    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
  });

  it('accept matched pid without startTime and remove', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_CAS }), 'utf-8');

    const result = await removePidIfMatch(ctx, testClawDaemonDir(tempDir, clawId), 11111);
    expect(result).toBe(true);

    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
  });
});

/**
 * pid.ts — PID validation + discriminated union (Phase 1003)
 */


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

