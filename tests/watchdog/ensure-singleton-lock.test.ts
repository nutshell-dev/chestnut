import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { ensureWatchdog } from '../../src/watchdog/ensure.js';
import { setAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WatchdogPidForeignWorkspaceError } from '../../src/watchdog/watchdog-pid.js';

let spawnCount = 0;

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/watchdog/watchdog-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-cli.js')>();
  return {
    ...actual,
    startCommand: vi.fn().mockImplementation(async () => {
      spawnCount++;
    }),
  };
});

describe('ensureWatchdog singleton lock', () => {
  let tmpDir: string;
  let clawforumDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CLAWFORUM_ROOT;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-ensure-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
    process.env.CLAWFORUM_ROOT = '/test/root';

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');
    spawnCount = 0;
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

  it('concurrent ensureWatchdog calls spawn only one watchdog', async () => {
    const [{ startCommand: mockedStart }] = await Promise.all([
      import('../../src/watchdog/watchdog-cli.js'),
    ]);
    const mockStart = vi.mocked(mockedStart);
    mockStart.mockImplementation(async () => {
      spawnCount++;
      // Small delay to exaggerate the race window
      await new Promise(r => setTimeout(r, 30));
      const pidFile = path.join(clawforumDir, 'watchdog.pid');
      // Use current process PID so isAlive() returns true in double-check
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/test/root' }));
    });

    await Promise.all([ensureWatchdog(fsFactory), ensureWatchdog(fsFactory)]);

    expect(spawnCount).toBe(1);
  });

  it('stale lock recovery: second caller cleans dead lock holder + spawns', async () => {
    const lockPath = path.join(clawforumDir, 'watchdog.lock');
    // Write a lock file with a dead PID
    fs.writeFileSync(lockPath, `${999999999}\n`);

    const [{ startCommand: mockedStart }] = await Promise.all([
      import('../../src/watchdog/watchdog-cli.js'),
    ]);
    const mockStart = vi.mocked(mockedStart);
    mockStart.mockImplementation(async () => {
      spawnCount++;
      const pidFile = path.join(clawforumDir, 'watchdog.pid');
      fs.writeFileSync(pidFile, JSON.stringify({ pid: 12345, root: '/test/root' }));
    });

    await ensureWatchdog(fsFactory);

    expect(spawnCount).toBe(1);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED,
      expect.stringContaining('path='),
    );
  });

  it('lock acquire timeout throws + audit ENSURE_LOCK_TIMEOUT', async () => {
    const lockPath = path.join(clawforumDir, 'watchdog.lock');
    // Write a lock file with the CURRENT process PID (alive, never releases)
    fs.writeFileSync(lockPath, `${process.pid}\n`);

    // Patch retry interval to make test fast
    const ensureModule = await import('../../src/watchdog/ensure.js');
    // We cannot patch module-level constants easily; instead we rely on the
    // default 3s timeout being acceptable. To keep test fast, create a live
    // lock holder in a child process that never releases.
    // Simpler: create lock file with alive PID and let tryAcquireLoop spin.
    // Vitest default test timeout is 5s, our lock timeout is 3s — acceptable.
    await expect(ensureWatchdog(fsFactory)).rejects.toThrow('Failed to acquire watchdog lock');

    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT,
      expect.stringContaining('timeout_ms='),
    );
  });

  it('foreign workspace pid rethrows WatchdogPidForeignWorkspaceError', async () => {
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    const foreignAlivePid = process.pid;
    fs.writeFileSync(pidFile, JSON.stringify({ pid: foreignAlivePid, root: '/foreign/root' }));

    await expect(ensureWatchdog(fsFactory)).rejects.toThrow(WatchdogPidForeignWorkspaceError);
  });
});
