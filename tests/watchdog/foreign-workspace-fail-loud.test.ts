import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import { isWatchdogAlive, WatchdogPidForeignWorkspaceError } from '../../src/watchdog/watchdog-pid.js';
import { startCommand } from '../../src/watchdog/watchdog-cli.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { DEAD_PID } from '../helpers/dead-pid.js';

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

describe('watchdog-pid foreign workspace fail-loud', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CHESTNUT_ROOT;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-pid-foreign-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
    process.env.CHESTNUT_ROOT = '/test/root';

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');
  });

  afterEach(() => {
    if (originalRoot !== undefined) {
      process.env.CHESTNUT_ROOT = originalRoot;
    } else {
      delete process.env.CHESTNUT_ROOT;
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('foreign workspace alive: throws WatchdogPidForeignWorkspaceError + audit PID_FOREIGN_WORKSPACE + does NOT delete pid file', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    // Use current process PID as a guaranteed-alive foreign PID
    const foreignAlivePid = process.pid;
    fs.writeFileSync(pidFile, JSON.stringify({ pid: foreignAlivePid, root: '/foreign/root' }));

    expect(() => isWatchdogAlive(fsFactory)).toThrow(WatchdogPidForeignWorkspaceError);

    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      expect.stringContaining(`foreign_pid=${foreignAlivePid}`),
      expect.stringContaining('foreign_root=/foreign/root'),
      expect.stringContaining('current_root=/test/root'),
    );
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it('foreign workspace dead: returns false + audit PID_STALE_AUTO_CLEANED + deletes pid file', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: DEAD_PID, root: '/foreign/root' }));

    const result = isWatchdogAlive(fsFactory);

    expect(result).toBe(false);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
      expect.stringContaining(`foreign_pid=${DEAD_PID}`),
      expect.stringContaining('foreign_root=/foreign/root'),
      expect.stringContaining('current_root=/test/root'),
    );
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('pid file ENOENT: returns false + no throw + no audit', () => {
    const result = isWatchdogAlive(fsFactory);

    expect(result).toBe(false);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('pid file read EACCES: throws + audit PID_READ_FAILED', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, 'locked');
    fs.chmodSync(pidFile, 0o000);

    try {
      expect(() => isWatchdogAlive(fsFactory)).toThrow();
      // phase 580: 加 path forensic col
      expect(auditSpy).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
        expect.stringContaining('path='),
        expect.stringContaining('error='),
      );
    } finally {
      // Restore permissions so cleanup can delete the temp dir
      fs.chmodSync(pidFile, 0o644);
    }
  });

  it('startCommand surfaces foreign workspace as CliError with guidance', async () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    const foreignAlivePid = process.pid;
    fs.writeFileSync(pidFile, JSON.stringify({ pid: foreignAlivePid, root: '/foreign/root' }));

    await expect(startCommand(fsFactory)).rejects.toThrow('Watchdog already running for foreign workspace');
    await expect(startCommand(fsFactory)).rejects.toThrow('chestnut stop');
  });
});
