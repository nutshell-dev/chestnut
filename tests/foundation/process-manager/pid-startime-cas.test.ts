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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAlive } from '../../../src/foundation/process-exec/process-control.js';
import * as startTimeModule from '../../../src/foundation/process-exec/process-starttime.js';
import { removePidIfMatch, readPid, selfWritePid } from '../../../src/foundation/process-manager/pid.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID_CAS } from '../../helpers/test-pids.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

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
    tempDir = path.join(tmpdir(), `pid-cas-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };
  }

  it('reject mismatched pid', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_CAS }), 'utf-8');

    const result = await removePidIfMatch(ctx, clawId, 22222);
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

    const result = await removePidIfMatch(ctx, clawId, 11111, 'B');
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

    const result = await removePidIfMatch(ctx, clawId, 11111, 'A');
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

    const result = await removePidIfMatch(ctx, clawId, 11111);
    expect(result).toBe(true);

    const stillExists = await fs.stat(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
  });
});
