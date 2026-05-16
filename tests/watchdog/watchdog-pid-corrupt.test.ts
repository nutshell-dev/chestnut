import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getMotionDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { getWatchdogPid, isWatchdogAlive } from '../../src/watchdog/watchdog-pid.js';
import { setAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getMotionDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

describe('watchdog-pid corrupt path', () => {
  let tmpDir: string;
  let clawforumDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CLAWFORUM_ROOT;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-pid-corrupt-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
    process.env.CLAWFORUM_ROOT = '/test/root';

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');
  });

  afterEach(() => {
    if (originalRoot !== undefined) {
      process.env.CLAWFORUM_ROOT = originalRoot;
    } else {
      delete process.env.CLAWFORUM_ROOT;
    }
    setAuditWriter(null);
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-JSON pid file: emits PID_CORRUPT audit + backup exists + returns null', () => {
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, '<malformed>');

    const result = getWatchdogPid();

    expect(result).toBeNull();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error='),
    );

    const files = fs.readdirSync(clawforumDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
    expect(fs.existsSync(path.join(clawforumDir, backupFile!))).toBe(true);
  });

  it('pid non-number: emits PID_CORRUPT audit + backup exists + returns null', () => {
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 'not-a-number', root: '/test/root' }));

    const result = getWatchdogPid();

    expect(result).toBeNull();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error=shape_mismatch'),
    );

    const files = fs.readdirSync(clawforumDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
  });

  it('root non-string: emits PID_CORRUPT audit + backup exists + returns false from isWatchdogAlive', () => {
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 12345, root: 99999 }));

    const result = isWatchdogAlive();

    expect(result).toBe(false);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('error=shape_mismatch'),
    );

    const files = fs.readdirSync(clawforumDir);
    const backupFile = files.find(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(backupFile).toBeDefined();
  });

  it('valid pid file still works (no false positive)', () => {
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 99999, root: '/test/root' }));

    const result = getWatchdogPid();

    expect(result).toBe(99999);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
