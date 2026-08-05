import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { isWatchdogAlive, WatchdogPidForeignWorkspaceError } from '../../src/watchdog/watchdog-pid.js';
import {
  newWatchdogAttempt, prepareCandidate, commitOwnership, WATCHDOG_ACTIVE_DIR,
} from '../../src/watchdog/watchdog-ownership.js';
import { startCommand } from '../../src/cli/commands/watchdog-cli.js';
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

// Phase 1289 Step C: watchdog runtime 消费自家 workspace config store
vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return {
    ...actual,
    readWorkspaceWatchdogConfig: vi.fn(),
  };
});

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
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
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

describe('active owner 与 legacy 输入分型（Phase 1203 Step E）', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CHESTNUT_ROOT;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  /** 以外部 record 占住 active（模拟另一进程已 commit） */
  function seedActive(record: ReturnType<typeof newWatchdogAttempt>): void {
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);
  }

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-active-foreign-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
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

  it('active live foreign owner → fail-loud throw + active 保留；legacy 输入不参与分型', () => {
    seedActive({ ...newWatchdogAttempt(process.pid), workspace_root: '/foreign/root' });
    // 同 workspace 的 legacy 输入同时存在也不被咨询（active 是唯一 authority）
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/test/root' }));

    expect(() => isWatchdogAlive(fsFactory)).toThrow(WatchdogPidForeignWorkspaceError);

    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      expect.stringContaining(`foreign_pid=${process.pid}`),
      expect.stringContaining('foreign_root=/foreign/root'),
      expect.stringContaining('current_root=/test/root'),
    );
    // active 与 legacy 输入均原样保留
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'))).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it('active dead foreign owner → false（不删 active、不碰 legacy 输入、不 auto-clean）', () => {
    seedActive({ ...newWatchdogAttempt(DEAD_PID), workspace_root: '/foreign/root' });
    // legacy 输入即使指向 live 同 workspace pid 也不参与（active authority 优先）
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/test/root' }));

    expect(isWatchdogAlive(fsFactory)).toBe(false);

    // active 不动（recovery 走 generation-guarded retire，不走查询路径删除）
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'))).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(auditSpy).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('active malformed → fail-closed false，不 fallback legacy 输入', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{broken');
    // legacy live 输入存在也不得被当作 alive 证据
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/test/root' }));

    expect(isWatchdogAlive(fsFactory)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(true);
  });
});
