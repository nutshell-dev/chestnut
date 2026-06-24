import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import { getWatchdogPid, isWatchdogAlive } from '../../src/watchdog/watchdog-pid.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_ALT } from '../helpers/test-pids.js';
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

describe('watchdog-pid corrupt path', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CHESTNUT_ROOT;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(os.tmpdir(), `wd-pid-corrupt-${randomUUID()}`);
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

  it('non-JSON pid file: emits PID_CORRUPT audit + backup exists + returns null', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, '<malformed>');

    const result = getWatchdogPid(fsFactory);

    expect(result).toBeNull();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error='),
    );

    const files = fs.readdirSync(chestnutDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
    expect(fs.existsSync(path.join(chestnutDir, backupFile!))).toBe(true);
  });

  it('pid non-number: emits PID_CORRUPT audit + backup exists + returns null', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 'not-a-number', root: '/test/root' }));

    const result = getWatchdogPid(fsFactory);

    expect(result).toBeNull();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error=shape_mismatch'),
    );

    const files = fs.readdirSync(chestnutDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
  });

  it('root non-string: emits PID_CORRUPT audit + backup exists + returns false from isWatchdogAlive', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    // Note: root: 99999 is intentional type-corruption fixture (root field should be string path;
    //       testing corruption recovery). pid: FAKE_LIVE_PID is normal use.
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID, root: 99999 }));

    const result = isWatchdogAlive(fsFactory);

    expect(result).toBe(false);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error=shape_mismatch'),
    );

    const files = fs.readdirSync(chestnutDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
  });

  it('valid pid file still works (no false positive)', () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/test/root' }));

    const result = getWatchdogPid(fsFactory);

    expect(result).toBe(FAKE_LIVE_PID_ALT);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
