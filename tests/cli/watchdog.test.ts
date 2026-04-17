/**
 * watchdog tests — fix 4: per-claw try-catch in maybeCronClawInactivity
 *
 * When one claw's check throws, the loop should continue and check remaining claws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

// Mock config so getClawforumDir() and getGlobalConfig() return controllable values
vi.mock('../../src/cli/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/config.js')>();
  return {
    ...actual,
    getMotionDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

// Mock watchdog-utils so we can control clawHasContract
vi.mock('../../src/cli/commands/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/commands/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    getClawActivityInfo: vi.fn(),
    gatherClawSnapshot: vi.fn(),
    shouldResetNotifyCount: vi.fn().mockReturnValue(false),
    getEffectiveInterval: vi.fn().mockReturnValue(999_999_999),
  };
});

import { maybeCronClawInactivity, shutdownWatchdog } from '../../src/cli/commands/watchdog.js';
import { getMotionDir, loadGlobalConfig } from '../../src/cli/config.js';
import { clawHasContract } from '../../src/cli/commands/watchdog-utils.js';

describe('maybeCronClawInactivity — fix 4: per-claw error isolation', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wdfix4-${randomUUID()}`);
    // .clawforum layout: getMotionDir() returns .clawforum/motion, parent is .clawforum
    const clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });

    // Create two claw directories
    fs.mkdirSync(path.join(clawsDir, 'claw-a'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-b'), { recursive: true });

    // Wire up mocks
    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    mockPm = { isAlive: vi.fn().mockReturnValue(false) } as unknown as ProcessManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('continues checking claw-b even when claw-a check throws', () => {
    // claw-a throws; claw-b returns false (no contract → skip)
    vi.mocked(clawHasContract)
      .mockImplementationOnce(() => { throw new Error('stat error'); })
      .mockReturnValueOnce(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => maybeCronClawInactivity(mockPm)).not.toThrow();

    // clawHasContract should be called for both claws
    expect(clawHasContract).toHaveBeenCalledTimes(2);

    // Error for claw-a should have been logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking claw'),
    );

    logSpy.mockRestore();
  });

  it('does not throw even if all claws error', () => {
    vi.mocked(clawHasContract).mockImplementation(() => {
      throw new Error('all fail');
    });

    expect(() => maybeCronClawInactivity(mockPm)).not.toThrow();
    expect(clawHasContract).toHaveBeenCalledTimes(2);
  });
});

import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

describe('shutdownWatchdog — fix 005: save state on signal', () => {
  let tmpDir: string;
  let auditWriter: AuditWriter;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-fix5-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(path.join(clawforumDir, 'motion'), { recursive: true });
    // 预创建 watchdog.pid，用于验证 shutdown 时会被删除
    fs.writeFileSync(path.join(clawforumDir, 'watchdog.pid'), JSON.stringify({ pid: 12345 }));
    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir, enforcePermissions: false }),
      'audit.tsv',
      null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls saveWatchdogState before removeWatchdogPid and process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const stateFile = path.join(tmpDir, '.clawforum', 'watchdog-state.json');
    expect(fs.existsSync(stateFile)).toBe(false);

    expect(() => shutdownWatchdog(auditWriter, 'SIGTERM')).toThrow('exit');

    // saveWatchdogState 应该将状态写入文件
    expect(fs.existsSync(stateFile)).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(savedState).toHaveProperty('lastInactivityNotified');
    expect(savedState).toHaveProperty('inactivityNotifyCount');

    // 断言 audit.tsv 中有 watchdog_stop 记录
    const auditLines = fs.readFileSync(path.join(tmpDir, '.clawforum', 'audit.tsv'), 'utf-8');
    expect(auditLines).toContain('watchdog_stop');

    // 断言 watchdog.pid 已被 removeWatchdogPid 删除
    expect(fs.existsSync(path.join(tmpDir, '.clawforum', 'watchdog.pid'))).toBe(false);

    exitSpy.mockRestore();
  });

  it('writes save_failed to audit and exits with code 1 when saveWatchdogState fails', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    // 预先创建只读的 state 文件，让 saveWatchdogState 写入失败
    const stateFile = path.join(tmpDir, '.clawforum', 'watchdog-state.json');
    fs.writeFileSync(stateFile, '{}');
    fs.chmodSync(stateFile, 0o444);

    expect(() => shutdownWatchdog(auditWriter, 'SIGTERM')).toThrow('exit');

    const auditPath = path.join(tmpDir, '.clawforum', 'audit.tsv');
    const auditLines = fs.readFileSync(auditPath, 'utf-8');
    expect(auditLines).toContain('watchdog_stop');
    expect(auditLines).toContain('save_failed=');

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    fs.chmodSync(stateFile, 0o644);
  });
});
