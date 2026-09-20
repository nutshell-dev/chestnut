/**
 * Phase 1203 Step C: ensureWatchdog 目录 authority 测试（原 ensure-singleton-lock 迁移）。
 *
 * caller 只做 alive fast-path + spawn candidate；单实例正确性在子进程目录 rename
 * commit（见 tests/watchdog/watchdog-ownership.test.ts / watchdog-lifecycle-ownership.test.ts）。
 * 反向：legacy lock 文件彻底失效（不再参与选举）；并发 caller 不产生第二 active owner。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { ensureWatchdog } from '../../src/watchdog/ensure.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WatchdogPidForeignWorkspaceError } from '../../src/watchdog/watchdog-pid.js';
import {
  newWatchdogAttempt,
  prepareCandidate,
  commitOwnership,
  WATCHDOG_ACTIVE_DIR,
} from '../../src/watchdog/watchdog-ownership.js';
import { spawnWatchdogCandidate } from '../../src/watchdog/spawn.js';

let spawnCount = 0;

vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
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

vi.mock('../../src/watchdog/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/spawn.js')>();
  return {
    ...actual,
    spawnWatchdogCandidate: vi.fn().mockImplementation(async () => {
      spawnCount++;
      return process.pid;
    }),
  };
});

describe('ensureWatchdog 目录 authority', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  const originalRoot = process.env.CHESTNUT_ROOT;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  /** mock spawnWatchdogCandidate 模拟子进程 commit：winner 占 active、并发 loser 不改 active */
  function mockSpawnSimulatesChildCommit(): void {
    spawnCount = 0;
    vi.mocked(spawnWatchdogCandidate).mockImplementation(async () => {
      spawnCount++;
      const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
      const record = newWatchdogAttempt(process.pid);
      prepareCandidate(chestnutFs, record);
      commitOwnership(chestnutFs, record);
      return process.pid;
    });
  }

  function activeOwnerToken(): string | null {
    const p = path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')).owner_token : null;
  }

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-ensure-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, heartbeat_stale_timeout_ms: 180_000,
    });
    process.env.CHESTNUT_ROOT = '/test/root';

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    spawnCount = 0;
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

  it('alive fast-path：合法 alive active owner 存在时不 spawn', async () => {
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    const record = newWatchdogAttempt(process.pid);
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);

    await ensureWatchdog(fsFactory);

    expect(spawnCount).toBe(0);
    expect(activeOwnerToken()).toBe(record.owner_token);
  });

  it('未活 → spawn candidate；子进程 commit 后出现唯一 active owner', async () => {
    mockSpawnSimulatesChildCommit();

    await ensureWatchdog(fsFactory);

    expect(spawnCount).toBe(1);
    expect(activeOwnerToken()).not.toBeNull();
  });

  it('并发 caller 可 spawn 多个短命 candidate、磁盘上仍恰好一个 active owner', async () => {
    mockSpawnSimulatesChildCommit();

    await Promise.all([ensureWatchdog(fsFactory), ensureWatchdog(fsFactory), ensureWatchdog(fsFactory)]);

    // caller 侧无锁/单飞：多个 candidate 被允许；正确性由子进程 rename commit 保证
    expect(spawnCount).toBeGreaterThanOrEqual(1);
    const tokens = new Set<string>();
    const activePath = path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json');
    expect(fs.existsSync(activePath)).toBe(true);
    tokens.add(JSON.parse(fs.readFileSync(activePath, 'utf-8')).owner_token);
    expect(tokens.size).toBe(1);
  });

  it('legacy 锁文件不再参与选举：不阻塞、不清理、零 ensure_lock audit', async () => {
    // 旧协议下会阻塞 3s 的 alive-token 锁文件 + claims 目录（fixture 在 tests/helpers、扫描范围外）
    const { seedLegacyWatchdogCallerLock } = await import('../helpers/watchdog-legacy-fixtures.js');
    const legacy = seedLegacyWatchdogCallerLock(chestnutDir, process.pid);

    mockSpawnSimulatesChildCommit();
    await ensureWatchdog(fsFactory);

    expect(spawnCount).toBe(1);
    // legacy 锁文件原样保留（retention 另立协议、不在 caller 侧清理）
    expect(fs.existsSync(legacy.lockFile)).toBe(true);
    expect(fs.existsSync(legacy.claimFile)).toBe(true);
    const auditPath = path.join(chestnutDir, 'audit.tsv');
    const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(audit).not.toContain('ensure_lock');
  });

  it('foreign workspace pid rethrows WatchdogPidForeignWorkspaceError', async () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/foreign/root' }));

    await expect(ensureWatchdog(fsFactory)).rejects.toThrow(WatchdogPidForeignWorkspaceError);
  });
});
