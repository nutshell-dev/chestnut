/**
 * PID file format migration (phase 1023)
 *
 * 验证点：
 * 1. readPid graceful fallback legacy raw int + audit PID_FILE_LEGACY_FORMAT
 * 2. readPid JSON format new caller
 * 3. selfWritePid emits JSON with startTime on POSIX
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { readPid, selfWritePid } from '../../../src/foundation/process-manager/pid.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import * as startTimeModule from '../../../src/foundation/process-exec/process-starttime.js';

describe('PID file format migration (phase 1023)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `pid-fmt-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
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
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    const result = await readPid(ctx, clawId);
    expect(result).toEqual({ pid: FAKE_LIVE_PID, startTime: undefined });

    const legacyEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT,
    );
    expect(legacyEvents).toHaveLength(1);
    expect(legacyEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT,
        'claw=test-claw',
        `pid=${FAKE_LIVE_PID}`,
      ]),
    );
  });

  it('readPid JSON format new caller', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID, startTime: 'Sat May 18 10:30:00 2026' }), 'utf-8');

    const result = await readPid(ctx, clawId);
    expect(result).toEqual({ pid: FAKE_LIVE_PID, startTime: 'Sat May 18 10:30:00 2026' });
  });

  it('readPid returns null for invalid content', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, 'not-a-number', 'utf-8');

    const result = await readPid(ctx, clawId);
    expect(result).toBeNull();
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
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    await selfWritePid(ctx, clawId);

    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    const content = await fs.readFile(pidFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ pid: process.pid, startTime: 'Sat May 18 10:30:00 2026' });

    const writeOkEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK);
    expect(writeOkEvents).toHaveLength(1);
    expect(writeOkEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
        'claw=test-claw',
        `pid=${process.pid}`,
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
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    await selfWritePid(ctx, clawId);

    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    const content = await fs.readFile(pidFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ pid: process.pid });

    const writeOkEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK);
    expect(writeOkEvents).toHaveLength(1);
    expect(writeOkEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
        'claw=test-claw',
        `pid=${process.pid}`,
        'startTime_skipped',
      ]),
    );
  });
});
