/** Phase 2153 Step B1：detached watchdog 的 raw stdout/stderr sink 装配。 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import { _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import {
  spawnWatchdogCandidate,
  WatchdogStartupCrashError,
  WatchdogStartupUnconfirmedError,
} from '../../src/watchdog/spawn.js';
import { inspectWatchdogOwner } from '../../src/watchdog/watchdog-pid.js';
import { admitWatchdogCandidate } from '../../src/watchdog/candidate-recovery.js';
import {
  commitOwnership,
  inspectTerminalForAttempt,
  newWatchdogAttempt,
  prepareCandidate,
  recordGenerationTerminal,
  WATCHDOG_ACTIVE_DIR,
  WATCHDOG_TERMINAL_FILE,
  type WatchdogGenerationTerminal,
} from '../../src/watchdog/watchdog-ownership.js';

const h = vi.hoisted(() => ({ spawnDetached: vi.fn(), sleep: vi.fn() }));

vi.mock('timers/promises', () => ({ setTimeout: h.sleep }));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return { ...actual, spawnDetached: h.spawnDetached };
});

vi.mock('../../src/watchdog/watchdog-pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-pid.js')>();
  return {
    ...actual,
    inspectWatchdogOwner: vi.fn(),
    assertWatchdogOwnerWorkspace: vi.fn(),
  };
});

const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });
const originalRoot = process.env.CHESTNUT_ROOT;
let tmpDir: string;

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-spawn-output-${randomUUID()}`);
  process.env.CHESTNUT_ROOT = tmpDir;
  h.spawnDetached.mockReset();
  h.spawnDetached.mockResolvedValue({ kind: 'spawned', pid: 4242 });
  h.sleep.mockReset();
  h.sleep.mockResolvedValue(undefined);
  vi.mocked(inspectWatchdogOwner).mockReturnValue({
    kind: 'alive',
    source: 'active',
    pid: 4242,
    workspaceRoot: tmpDir,
  } as ReturnType<typeof inspectWatchdogOwner>);
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function noneInspection(): ReturnType<typeof inspectWatchdogOwner> {
  return { kind: 'none' } as ReturnType<typeof inspectWatchdogOwner>;
}

function aliveInspection(pid: number): ReturnType<typeof inspectWatchdogOwner> {
  return {
    kind: 'alive', source: 'active', pid, workspaceRoot: tmpDir,
  } as ReturnType<typeof inspectWatchdogOwner>;
}

function admitAttempt(): string {
  const admission = admitWatchdogCandidate(
    fsFactory(path.join(tmpDir, '.chestnut')),
    null,
  );
  if (admission.kind !== 'admitted') throw new Error('expected candidate admission');
  return admission.admission.attemptId;
}

function seedOwner(attemptId: string) {
  const chestnutFs = fsFactory(path.join(tmpDir, '.chestnut'));
  const owner = { ...newWatchdogAttempt(4242), attempt_id: attemptId };
  prepareCandidate(chestnutFs, owner);
  expect(commitOwnership(chestnutFs, owner).kind).toBe('committed');
  return { chestnutFs, owner };
}

function seedTerminal(attemptId: string, terminal: WatchdogGenerationTerminal): void {
  const { chestnutFs, owner } = seedOwner(attemptId);
  expect(recordGenerationTerminal(chestnutFs, {
    attemptId, ownerToken: owner.owner_token, pid: owner.pid,
  }, terminal).kind).toBe('recorded');
}

async function captureSpawnFailure(attemptId: string): Promise<unknown> {
  try {
    await spawnWatchdogCandidate(fsFactory, attemptId);
  } catch (error) {
    return error;
  }
  throw new Error('expected spawn failure');
}

describe('spawnWatchdogCandidate process output', () => {
  it('创建 watchdog owner 目录并把 raw logFile 交给 detached child', async () => {
    await expect(spawnWatchdogCandidate(fsFactory)).resolves.toBe(4242);

    expect(h.spawnDetached).toHaveBeenCalledOnce();
    const options = h.spawnDetached.mock.calls[0][2];
    const expected = path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output);
    expect(options.logFile).toBe(expected);
    const committed = JSON.parse(fs.readFileSync(path.join(
      tmpDir,
      '.chestnut',
      'watchdog',
      'recovery',
      'windows',
      'recovery-initial',
      'attempts',
      '0',
      'admission.json',
    ), 'utf8'));
    expect(options.env.CHESTNUT_WATCHDOG_ATTEMPT_ID).toBe(committed.attemptId);
    expect(fs.statSync(path.dirname(expected)).isDirectory()).toBe(true);
  });

  it('兼容 spawn 入口也消费同一持久预算，第五次不绕过拒绝', async () => {
    for (let index = 0; index < 4; index++) {
      await spawnWatchdogCandidate(fsFactory);
    }

    await expect(spawnWatchdogCandidate(fsFactory)).rejects.toThrow(/budget_exhausted/);
    expect(h.spawnDetached).toHaveBeenCalledTimes(4);
  });

  it('raw sink pre-commit 打开失败仍以原 spawn failure fail-loud', async () => {
    h.spawnDetached.mockResolvedValue({
      kind: 'failed',
      failure: {
        command: 'node',
        args: ['watchdog-entry.js'],
        errno: 'EACCES',
        code: 'EACCES',
        message: 'raw sink denied',
        atMs: 123,
      },
    });

    await expect(spawnWatchdogCandidate(fsFactory))
      .rejects.toThrow(/pre-commit failure.*raw sink denied/);
    expect(h.spawnDetached.mock.calls[0][2].logFile).toBe(
      path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output),
    );
  });

  it('post-commit failure sink 保留 pid/errno/时间并写 stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await spawnWatchdogCandidate(fsFactory);
    const options = h.spawnDetached.mock.calls[0][2];

    options.onSpawnFailure?.({
      command: 'node',
      args: ['watchdog-entry.js'],
      pid: 4242,
      errno: 'ENOENT',
      message: 'child exec failed',
      atMs: 456,
    });

    const output = stderr.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).toContain('pid=4242');
    expect(output).toContain('errno=ENOENT');
    expect(output).toContain('at=456');
    expect(output).toContain('child exec failed');
    const raw = fs.readFileSync(
      path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output),
      'utf8',
    );
    expect(raw).toContain('pid=4242');
    expect(raw).toContain('errno=ENOENT');
    expect(raw).toContain('at=456');
    expect(raw).toContain('child exec failed');
  });
});


describe('spawnWatchdogCandidate startup terminal', () => {
  it('crashed 只呈现首行 240 字符摘要，错误保留完整 structured terminal', async () => {
    const attemptId = admitAttempt();
    const summary = 'x'.repeat(300);
    const terminal: WatchdogGenerationTerminal = {
      kind: 'crashed',
      reason: `${summary}\nfull child stack must stay in evidence`,
      recorded_at: new Date().toISOString(),
    };
    seedTerminal(attemptId, terminal);
    vi.mocked(inspectWatchdogOwner).mockReturnValue(noneInspection());

    const failure = await captureSpawnFailure(attemptId);

    expect(failure).toBeInstanceOf(WatchdogStartupCrashError);
    if (!(failure instanceof WatchdogStartupCrashError)) throw new Error('expected crash error');
    expect(failure.message).toContain('x'.repeat(240));
    expect(failure.message).not.toContain('x'.repeat(241));
    expect(failure.message).not.toContain('full child stack');
    expect(failure.message).toContain('Check watchdog log at');
    expect(failure.terminal).toEqual(terminal);
    expect(failure.cause).toBeUndefined();
    expect(inspectTerminalForAttempt(
      fsFactory(path.join(tmpDir, '.chestnut')),
      attemptId,
    )).toEqual({ kind: 'terminal', terminal });
    expect(h.sleep).toHaveBeenCalledTimes(30);
  });

  it('stopped 明确呈现停止状态与 signal，而非 timeout', async () => {
    const attemptId = admitAttempt();
    seedTerminal(attemptId, {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    });
    vi.mocked(inspectWatchdogOwner).mockReturnValue(noneInspection());

    const failure = await captureSpawnFailure(attemptId);
    expect((failure as Error).message).toContain('Watchdog stopped during startup (SIGTERM)');
    expect((failure as Error).message).not.toContain('within 3s');
  });

  it('unclean 明确呈现 unclean，而非 timeout', async () => {
    const attemptId = admitAttempt();
    seedTerminal(attemptId, {
      kind: 'unclean', detected_at: new Date().toISOString(), detected_by_pid: 999,
    });
    vi.mocked(inspectWatchdogOwner).mockReturnValue(noneInspection());

    const failure = await captureSpawnFailure(attemptId);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Watchdog startup ended unclean');
    expect((failure as Error).message).not.toContain('within 3s');
  });

  it('unknown 抛 typed unconfirmed error 并保留读取 evidence', async () => {
    const attemptId = admitAttempt();
    seedOwner(attemptId);
    fs.writeFileSync(path.join(
      tmpDir, '.chestnut', WATCHDOG_ACTIVE_DIR, WATCHDOG_TERMINAL_FILE,
    ), 'NOT_JSON');
    vi.mocked(inspectWatchdogOwner).mockReturnValue(noneInspection());

    const failure = await captureSpawnFailure(attemptId);

    expect(failure).toBeInstanceOf(WatchdogStartupUnconfirmedError);
    if (!(failure instanceof WatchdogStartupUnconfirmedError)) {
      throw new Error('expected unconfirmed error');
    }
    expect(failure.evidence).toMatchObject({ kind: 'unknown', reason: 'terminal_malformed' });
  });

  it('none 保留原 3 秒 timeout 文案', async () => {
    const attemptId = admitAttempt();
    vi.mocked(inspectWatchdogOwner).mockReturnValue(noneInspection());

    const failure = await captureSpawnFailure(attemptId);

    expect((failure as Error).message).toBe(
      'Watchdog failed to start within 3s. Check watchdog log at .chestnut/watchdog/watchdog.log.',
    );
    expect(h.sleep).toHaveBeenCalledTimes(30);
  });

  it('轮询中其他合法 alive winner 优先于本 attempt 的 crash', async () => {
    const attemptId = admitAttempt();
    seedTerminal(attemptId, {
      kind: 'crashed', reason: 'own crash', recorded_at: new Date().toISOString(),
    });
    vi.mocked(inspectWatchdogOwner)
      .mockReturnValueOnce(noneInspection())
      .mockReturnValue(aliveInspection(7777));

    await expect(spawnWatchdogCandidate(fsFactory, attemptId)).resolves.toBe(7777);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it('预算耗尽后的无 sleep 复核仍让其他 alive winner 优先', async () => {
    const attemptId = admitAttempt();
    seedTerminal(attemptId, {
      kind: 'crashed', reason: 'own crash', recorded_at: new Date().toISOString(),
    });
    let inspections = 0;
    vi.mocked(inspectWatchdogOwner).mockImplementation(() => {
      inspections++;
      return inspections === 32 ? aliveInspection(8888) : noneInspection();
    });

    await expect(spawnWatchdogCandidate(fsFactory, attemptId)).resolves.toBe(8888);
    expect(inspections).toBe(32);
    expect(h.sleep).toHaveBeenCalledTimes(30);
  });
});
