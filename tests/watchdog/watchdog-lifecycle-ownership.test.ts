/**
 * Phase 1203 Step B: 子进程持有 ownership — generation lifecycle 测试。
 * Phase 1203 Step E: active 目录为唯一 owner authority — liveness-based stale 判断。
 *
 * 反向覆盖：
 * - loser 零主 loop 副作用（无 state load / WATCHDOG_START / signal / pid 写）
 * - 旧 generation 迟到 shutdown 不动 fresh active、不删新 owner pid 镜像
 * - stale owner 判死 retire 后接管（含 dead foreign active — Step E 关闭缺口）
 * - foreign live owner 拒绝接管（fail-loud）
 * - winner 进入 loop 后磁盘无新版创建的 watchdog.pid
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { aliveLiveness } from '../helpers/liveness-fixtures.js';

vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
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
vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/foundation/process-manager/factories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/factories.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(),
    createDirContext: vi.fn((...args: any[]) => (actual as any).createDirContext(...args)),
  };
});

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import {
  setAuditWriter,
  _resetWatchdogContextForTest,
} from '../../src/watchdog/watchdog-context.js';
import {
  acquireWatchdogOwnership,
  runWatchdogLoop,
  shutdownWatchdog,
  _resetShutdownGuard,
  _setWatchdogOwnershipForTest,
} from '../../src/watchdog/watchdog.js';
import {
  newWatchdogAttempt,
  prepareCandidate,
  commitOwnership,
  inspectTerminal,
  WATCHDOG_ACTIVE_DIR,
  WATCHDOG_CANDIDATES_DIR,
  WATCHDOG_RETIRED_DIR,
  type WatchdogOwnerRecord,
} from '../../src/watchdog/watchdog-ownership.js';
import {
  WatchdogPidForeignWorkspaceError,
  _setPidArgvVerifierForTest,
} from '../../src/watchdog/watchdog-pid.js';

const DEAD_PID = 999999999;
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let chestnutDir: string;
let auditWriter: AuditWriter;
const originalRoot = process.env.CHESTNUT_ROOT;

function auditLines(): string {
  // Phase 1288 Step C: runWatchdogLoop 生产 writer 写 audit/audit.tsv（AUDIT_PATHS.audit）；
  // 直接调用 acquireWatchdogOwnership 的用例走 beforeEach 手动 set 的 writer（legacy 根 audit.tsv）。
  // 两路径合读，覆盖两类写入。
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
  return read(path.join(chestnutDir, 'audit.tsv')) + read(path.join(chestnutDir, 'audit', 'audit.tsv'));
}

function activeOwner(): WatchdogOwnerRecord | null {
  const p = path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

/** 以外部 record 占住 active（模拟另一进程已 commit） */
function seedActive(record: WatchdogOwnerRecord): void {
  const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
  prepareCandidate(chestnutFs, record);
  commitOwnership(chestnutFs, record);
}

function candidateOutcomeFiles(): string[] {
  const dir = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR);
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const attemptDir of fs.readdirSync(dir)) {
    const outcome = path.join(dir, attemptDir, 'outcome.json');
    if (fs.existsSync(outcome)) found.push(outcome);
  }
  return found;
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  _resetShutdownGuard();
  _setWatchdogOwnershipForTest(null);
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-lifecycle-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(path.join(chestnutDir, 'motion', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });
  vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
  vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
    interval_ms: 5_000, heartbeat_stale_timeout_ms: 180_000,
  });
  process.env.CHESTNUT_ROOT = tmpDir;
  auditWriter = new AuditWriter(new NodeFileSystem({ baseDir: chestnutDir }), 'audit.tsv', null);
  setAuditWriter(auditWriter);
});

afterEach(() => {
  _setWatchdogOwnershipForTest(null);
  _setPidArgvVerifierForTest(null);
  setAuditWriter(null);
  if (originalRoot !== undefined) {
    process.env.CHESTNUT_ROOT = originalRoot;
  } else {
    delete process.env.CHESTNUT_ROOT;
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireWatchdogOwnership', () => {
  it('空目录 commit 成功；active owner.json 是可解释完整事实（commit 后崩溃不丢事实）', () => {
    const result = acquireWatchdogOwnership(fsFactory);
    expect(result.kind).toBe('committed');

    const owner = activeOwner();
    expect(owner).not.toBeNull();
    expect(owner!.pid).toBe(process.pid);
    expect(owner!.workspace_root).toBe(tmpDir);
    expect(owner!.attempt_id.length).toBeGreaterThan(0);
    expect(owner!.owner_token.length).toBeGreaterThan(0);
    expect(auditLines()).toContain('watchdog_ownership_committed');
  });

  it('live owner（同 workspace）→ lost + immutable outcome + active 不动', () => {
    const foreign = newWatchdogAttempt(process.pid); // alive（本进程）
    seedActive(foreign);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('lost');
    if (result.kind === 'lost') expect(result.owner.owner_token).toBe(foreign.owner_token);
    expect(activeOwner()!.owner_token).toBe(foreign.owner_token);
    const outcomes = candidateOutcomeFiles();
    expect(outcomes.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(outcomes[0], 'utf-8'))).toMatchObject({
      outcome: 'lost',
      winner_owner_token: foreign.owner_token,
    });
  });

  it('stale owner（dead pid）判死 retire 后接管；旧 generation 完整保留在 retired/<token>', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    expect(activeOwner()!.pid).toBe(process.pid);
    const retiredPath = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token, 'owner.json');
    expect(JSON.parse(fs.readFileSync(retiredPath, 'utf-8'))).toMatchObject({
      attempt_id: stale.attempt_id,
    });
    const audit = auditLines();
    expect(audit).toContain('watchdog_ownership_retired');
    expect(audit).toContain('reason=stale_recovery');
  });

  it('live foreign owner（不同 workspace）→ foreign_owned + active 保留、不写 outcome', () => {
    const foreign = { ...newWatchdogAttempt(process.pid), workspace_root: '/foreign/root' };
    seedActive(foreign);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('foreign_owned');
    if (result.kind === 'foreign_owned') expect(result.owner.owner_token).toBe(foreign.owner_token);
    // active 保留原样；foreign 分型不写 lost outcome（entry fail-loud 处理）
    expect(activeOwner()!.owner_token).toBe(foreign.owner_token);
    expect(activeOwner()!.workspace_root).toBe('/foreign/root');
    expect(candidateOutcomeFiles().length).toBe(0);
  });

  it('dead foreign active 可被 generation-guarded retire 后接管（Step E 关闭 dead-foreign 缺口）', () => {
    const foreign = { ...newWatchdogAttempt(DEAD_PID), workspace_root: '/foreign/root' };
    seedActive(foreign);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    expect(activeOwner()!.pid).toBe(process.pid);
    expect(activeOwner()!.workspace_root).toBe(tmpDir);
    // 旧 foreign generation 完整保留在 retired/<token>（不误删证据）
    const retiredPath = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, foreign.owner_token, 'owner.json');
    expect(JSON.parse(fs.readFileSync(retiredPath, 'utf-8'))).toMatchObject({
      attempt_id: foreign.attempt_id,
      workspace_root: '/foreign/root',
    });
    const audit = auditLines();
    expect(audit).toContain('watchdog_ownership_retired');
    expect(audit).toContain('reason=stale_recovery');
  });

  it('PID-reuse 且 argv 不符的 foreign active 按 dead 处理（不误杀无关进程）', () => {
    _setPidArgvVerifierForTest(() => false);
    const foreign = { ...newWatchdogAttempt(process.pid), workspace_root: '/foreign/root' };
    seedActive(foreign);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, foreign.owner_token))).toBe(true);
    expect(activeOwner()!.pid).toBe(process.pid);
  });

  it('畸形 active → failed（不伪装 loser）+ failed outcome', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{broken');

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('failed');
    const outcomes = candidateOutcomeFiles();
    expect(outcomes.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(outcomes[0], 'utf-8')).outcome).toBe('failed');
  });
});

describe('runWatchdogLoop ownership 门', () => {
  let capturedHandlers: Record<string, Function>;

  beforeEach(() => {
    const mockPm = {
      liveness: vi.fn().mockReturnValue(aliveLiveness()),
      isAlive: vi.fn().mockReturnValue(true),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);
    capturedHandlers = {};
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      capturedHandlers[event] = handler;
      return process;
    });
  });

  it('loser 零主 loop 副作用：无 pid 写 / 无 WATCHDOG_START / 无 signal install / 无 tick', async () => {
    const foreign = newWatchdogAttempt(process.pid);
    seedActive(foreign);

    await runWatchdogLoop(fsFactory);

    expect(fs.existsSync(path.join(chestnutDir, 'watchdog.pid'))).toBe(false);
    expect(capturedHandlers['SIGTERM']).toBeUndefined();
    expect(capturedHandlers['SIGINT']).toBeUndefined();
    const audit = auditLines();
    expect(audit).not.toContain('watchdog_start');
    expect(audit).not.toContain('watchdog_check');
    expect(fs.existsSync(path.join(chestnutDir, 'watchdog-state.json'))).toBe(false);
    // loser outcome 留痕
    expect(candidateOutcomeFiles().length).toBe(1);
    // active 仍属 foreign
    expect(activeOwner()!.owner_token).toBe(foreign.owner_token);
  });

  it('live foreign active owner → entry fail-loud throw + active 保留', async () => {
    const foreign = { ...newWatchdogAttempt(process.pid), workspace_root: '/foreign/root' };
    seedActive(foreign);

    await expect(runWatchdogLoop(fsFactory))
      .rejects.toThrow(WatchdogPidForeignWorkspaceError);

    // active 原样保留；零主 loop 副作用
    expect(activeOwner()!.owner_token).toBe(foreign.owner_token);
    expect(capturedHandlers['SIGTERM']).toBeUndefined();
    expect(auditLines()).not.toContain('watchdog_start');
  });

  it('winner commit 后进入 loop；SIGTERM shutdown 只 retire 自身 generation', async () => {
    const { setTimeout: setTimeoutP } = await import('timers/promises');
    vi.mocked(setTimeoutP).mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      try { capturedHandlers['SIGTERM']?.(); } catch { /* exit mock throws */ }
      exitSpy.mockRestore();
    });
    try {
      await runWatchdogLoop(fsFactory);
    } catch { /* process.exit mock may throw */ }

    const owner = activeOwner();
    const audit = auditLines();
    expect(audit).toContain('watchdog_ownership_committed');
    expect(audit).toContain('watchdog_start');
    expect(audit).toContain('watchdog_ownership_retired');
    expect(audit).toContain('reason=shutdown');
    // active 已 retire（owner 为 null 因为 active 被移走）
    expect(owner).toBeNull();
    expect(fs.existsSync(path.join(chestnutDir, 'watchdog.pid'))).toBe(false);
  });

  it('graceful shutdown 在 retire 前写 stopped terminal，retired 目录保留 terminal', async () => {
    const { setTimeout: setTimeoutP } = await import('timers/promises');
    vi.mocked(setTimeoutP).mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      try { capturedHandlers['SIGTERM']?.(); } catch { /* exit mock throws */ }
      exitSpy.mockRestore();
    });
    try {
      await runWatchdogLoop(fsFactory);
    } catch { /* process.exit mock may throw */ }

    const retiredDirs = fs.readdirSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR));
    expect(retiredDirs.length).toBe(1);
    const terminalPath = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, retiredDirs[0], 'terminal.json');
    const terminal = JSON.parse(fs.readFileSync(terminalPath, 'utf-8'));
    expect(terminal.kind).toBe('stopped');
    expect(terminal.signal).toBe('SIGTERM');
  });
});

describe('stale recovery 补记 unclean terminal', () => {
  it('dead owner 无 terminal 时，recovery 先写 unclean 再 retire 并接管', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    const retiredPath = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token);
    expect(fs.existsSync(retiredPath)).toBe(true);
    const terminal = JSON.parse(fs.readFileSync(path.join(retiredPath, 'terminal.json'), 'utf-8'));
    expect(terminal.kind).toBe('unclean');
    expect(terminal.detected_by_pid).toBe(process.pid);
    const audit = auditLines();
    expect(audit).toContain('watchdog_unclean_termination_detected');
    expect(audit).toContain('watchdog_ownership_retired');
    expect(audit).toContain('reason=stale_recovery');
  });

  it('已有 crashed terminal 时，recovery 不覆盖为 unclean，仍 retire 并接管', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    fs.writeFileSync(
      path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'),
      JSON.stringify({ kind: 'crashed', reason: 'test', recorded_at: new Date().toISOString() }),
    );

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token, 'terminal.json'), 'utf-8'));
    expect(terminal.kind).toBe('crashed');
    expect(terminal.reason).toBe('test');
  });

  it('已有 stopped terminal 时，recovery 不覆盖为 unclean，仍 retire 并接管', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);
    fs.writeFileSync(
      path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'),
      JSON.stringify({ kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString() }),
    );

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token, 'terminal.json'), 'utf-8'));
    expect(terminal.kind).toBe('stopped');
  });

  it('unclean terminal 已被另一 reclaimer 写下时，本 reclaimer 仍成功接管', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    fs.writeFileSync(
      path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'),
      JSON.stringify({ kind: 'unclean', detected_at: new Date().toISOString(), detected_by_pid: 111111 }),
    );

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token, 'terminal.json'), 'utf-8'));
    expect(terminal.kind).toBe('unclean');
    expect(terminal.detected_by_pid).toBe(111111);
  });
});

describe('legacy watchdog.pid 迁移（Phase 1203 Step D）', () => {
  const legacyPidFile = () => path.join(chestnutDir, 'watchdog.pid');

  it('live legacy owner（同 workspace）保守阻止接管：legacy_live + outcome + 无 active', () => {
    fs.writeFileSync(legacyPidFile(), JSON.stringify({ pid: process.pid, root: tmpDir }));

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('legacy_live');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR))).toBe(false);
    // legacy 文件不得删除
    expect(fs.existsSync(legacyPidFile())).toBe(true);
    const outcomes = candidateOutcomeFiles();
    expect(outcomes.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(outcomes[0], 'utf-8'))).toMatchObject({
      outcome: 'lost',
      reason: 'legacy_live',
    });
  });

  it('dead legacy pid 保留证据迁移到 retired/legacy-<pid> 后放行 commit', () => {
    const legacyContent = JSON.stringify({ pid: DEAD_PID, root: tmpDir });
    fs.writeFileSync(legacyPidFile(), legacyContent);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    expect(fs.existsSync(legacyPidFile())).toBe(false);
    const migrated = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, `legacy-${DEAD_PID}`, 'owner.json');
    expect(fs.readFileSync(migrated, 'utf-8')).toBe(legacyContent);
    const audit = auditLines();
    expect(audit).toContain('watchdog_ownership_legacy_migrated');
    expect(audit).toContain(`pid=${DEAD_PID}`);
    expect(activeOwner()!.pid).toBe(process.pid);
  });

  it('corrupt legacy pid 走 quarantine 保留证据后放行 commit', () => {
    fs.writeFileSync(legacyPidFile(), 'NOT_VALID_JSON{{{');

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    expect(fs.existsSync(legacyPidFile())).toBe(false);
    const quarantined = fs.readdirSync(chestnutDir).filter(f => f.startsWith('watchdog.pid.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(auditLines()).toContain('watchdog_pid_corrupt');
  });

  it('foreign workspace live legacy → throw WatchdogPidForeignWorkspaceError、legacy 文件保留', () => {
    fs.writeFileSync(legacyPidFile(), JSON.stringify({ pid: process.pid, root: '/foreign/root' }));

    expect(() => acquireWatchdogOwnership(fsFactory)).toThrow(WatchdogPidForeignWorkspaceError);
    expect(fs.existsSync(legacyPidFile())).toBe(true);
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR))).toBe(false);
  });

  it('PID reuse：legacy pid 活着但 argv 非 watchdog → 判死迁移放行', () => {
    _setPidArgvVerifierForTest(() => false);
    fs.writeFileSync(legacyPidFile(), JSON.stringify({ pid: process.pid, root: tmpDir }));

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    const migrated = path.join(chestnutDir, WATCHDOG_RETIRED_DIR, `legacy-${process.pid}`, 'owner.json');
    expect(fs.existsSync(migrated)).toBe(true);
  });

  it('active 存在时 legacy 镜像不参与处置（目录 authority 优先）', () => {
    const stale = newWatchdogAttempt(DEAD_PID);
    seedActive(stale);
    const mirror = JSON.stringify({ pid: DEAD_PID, root: tmpDir });
    fs.writeFileSync(legacyPidFile(), mirror);

    const result = acquireWatchdogOwnership(fsFactory);

    expect(result.kind).toBe('committed');
    // active 经 stale_recovery retire；legacy 镜像文件不动（Step E：winner 不再覆写，
    // 残留仅作 legacy 输入，由 stop 兼容清理，永不再是 authority）
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, stale.owner_token))).toBe(true);
    expect(fs.readFileSync(legacyPidFile(), 'utf-8')).toBe(mirror);
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, `legacy-${DEAD_PID}`))).toBe(false);
  });
});

describe('phase 1878 Step H: graceful shutdown terminal 写失败保 active', () => {
  it('terminal 写失败（malformed active）→ 保 active + WATCHDOG_TERMINAL_WRITE_FAILED audit + 仍退出', () => {
    const record = newWatchdogAttempt(process.pid);
    seedActive(record);
    // 弄坏 active owner.json → recordGenerationTerminal 返回 malformed
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), 'NOT_JSON{{{');
    _setWatchdogOwnershipForTest({
      attemptId: record.attempt_id,
      ownerToken: record.owner_token,
      pid: record.pid,
      activeDir: WATCHDOG_ACTIVE_DIR,
      record,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');
    exitSpy.mockRestore();

    // active 保留（未 retire）——收束交下次启动 stale-owner 检测链
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR))).toBe(true);
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token))).toBe(false);
    // 留证：ctx=graceful_shutdown + generation identity
    const audit = auditLines();
    expect(audit).toContain('watchdog_terminal_write_failed');
    expect(audit).toContain('ctx=graceful_shutdown');
    expect(audit).toContain(`attempt=${record.attempt_id}`);
    expect(audit).toContain('signal=SIGTERM');
  });

  it('terminal 写成功后 retire 语义零漂移（对照）', () => {
    const record = newWatchdogAttempt(process.pid);
    seedActive(record);
    _setWatchdogOwnershipForTest({
      attemptId: record.attempt_id,
      ownerToken: record.owner_token,
      pid: record.pid,
      activeDir: WATCHDOG_ACTIVE_DIR,
      record,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');
    exitSpy.mockRestore();

    // terminal recorded → retire 正常收束
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR))).toBe(false);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token, 'terminal.json'), 'utf-8'));
    expect(terminal.kind).toBe('stopped');
    expect(auditLines()).toContain('watchdog_terminal_recorded');
    expect(auditLines()).not.toContain('watchdog_terminal_write_failed');
  });
});

describe('旧 generation 迟到 shutdown', () => {
  it('不动 fresh active、不删新 owner legacy pid 镜像', () => {
    // fresh generation（gen2）占 active + legacy pid 镜像
    const fresh = newWatchdogAttempt(DEAD_PID);
    seedActive(fresh);
    fs.writeFileSync(
      path.join(chestnutDir, 'watchdog.pid'),
      JSON.stringify({ pid: fresh.pid, root: tmpDir }),
    );
    // 旧 generation（gen1）迟到 shutdown
    const staleRecord = newWatchdogAttempt(88888888);
    _setWatchdogOwnershipForTest({
      attemptId: staleRecord.attempt_id,
      ownerToken: staleRecord.owner_token,
      pid: staleRecord.pid,
      activeDir: WATCHDOG_ACTIVE_DIR,
      record: staleRecord,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');
    exitSpy.mockRestore();

    // fresh active 未被移动、retired/<gen1 token> 不存在、pid 镜像未删
    expect(activeOwner()!.owner_token).toBe(fresh.owner_token);
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, staleRecord.owner_token))).toBe(false);
    expect(fs.existsSync(path.join(chestnutDir, 'watchdog.pid'))).toBe(true);
  });
});
