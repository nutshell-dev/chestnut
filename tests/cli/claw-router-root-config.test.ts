/**
 * Phase 1301 Step B: ClawRouter RootConfig 窄 DI owner test。
 *
 * 冻结：
 * - create/outbox 各恰好一次 rootConfig.loadGlobal()；
 * - help/list/chat 等无 guard 路径零 loadGlobal；
 * - ps existence guard 走 loadClaw：undefined → 既有 CliError("does not exist")；
 *   valid config → 进入 psCommand；corrupt/IO 错误同一实例上抛到 CLI 错误边界
 *   （不 catch、不伪装 missing）。
 *
 * 不跳过真实 dispatch 路径：verb 仍经 verbAction → cliAction supervision wrapper，
 * 只 mock OS 边界（watchdog ensure/pid）与下游 command 实现；RootConfig 判定本身
 * 不 mock 为旁路——fake 只计数/分流。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadGlobal: vi.fn(),
  loadClaw: vi.fn(),
  createCommand: vi.fn(),
  chatCommand: vi.fn(),
  stopCommand: vi.fn(),
  listCommand: vi.fn(),
  healthCommand: vi.fn(),
  sendCommand: vi.fn(),
  outboxCommand: vi.fn(),
  importCommand: vi.fn(),
  readCommand: vi.fn(),
  lsCommand: vi.fn(),
  clawStatusCommand: vi.fn(),
  watchCommand: vi.fn(),
  runStreamFromArgs: vi.fn(),
  clawTraceCommand: vi.fn(),
  psCommand: vi.fn(),
  clawDaemonCommand: vi.fn(),
  ensureWatchdog: vi.fn(),
  isWatchdogAlive: vi.fn(),
  createDirContext: vi.fn(),
  handleCliError: vi.fn(),
}));

vi.mock('../../src/cli/commands/claw.js', () => ({
  createCommand: h.createCommand,
  chatCommand: h.chatCommand,
  stopCommand: h.stopCommand,
  listCommand: h.listCommand,
  healthCommand: h.healthCommand,
  sendCommand: h.sendCommand,
  outboxCommand: h.outboxCommand,
  importCommand: h.importCommand,
  readCommand: h.readCommand,
  lsCommand: h.lsCommand,
  clawStatusCommand: h.clawStatusCommand,
  watchCommand: h.watchCommand,
  runStreamFromArgs: h.runStreamFromArgs,
  clawTraceCommand: h.clawTraceCommand,
}));
vi.mock('../../src/cli/commands/claw-ps.js', () => ({ psCommand: h.psCommand }));
vi.mock('../../src/cli/commands/claw-daemon.js', () => ({ clawDaemonCommand: h.clawDaemonCommand }));
vi.mock('../../src/watchdog/ensure.js', () => ({ ensureWatchdog: h.ensureWatchdog }));
vi.mock('../../src/watchdog/watchdog-pid.js', () => ({ isWatchdogAlive: h.isWatchdogAlive }));
vi.mock('../../src/foundation/audit/index.js', () => ({ createDirContext: h.createDirContext }));
vi.mock('../../src/cli/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/errors.js')>();
  return { ...actual, handleCliError: h.handleCliError };
});

import { dispatchClawSubcommand, type RouterDeps } from '../../src/cli/commands/claw-router.js';
import { CliError } from '../../src/cli/errors.js';

const deps: RouterDeps = {
  fsFactory: (() => ({})) as unknown as RouterDeps['fsFactory'],
  rootConfig: { loadGlobal: h.loadGlobal, loadClaw: h.loadClaw },
};

describe('claw-router RootConfig 窄 DI', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.createDirContext.mockReturnValue({ audit: { write: vi.fn() } });
    h.isWatchdogAlive.mockReturnValue(false);
    // 与真实 handleCliError 同语义的最小实现（CliError → message + code；Error → 'Error:' + 1）。
    h.handleCliError.mockImplementation((error: unknown) => {
      if (error instanceof CliError) {
        console.error(error.message);
        return error.code;
      }
      if (error instanceof Error) {
        console.error('Error:', error.message);
        return 1;
      }
      console.error('Error:', String(error));
      return 1;
    });
    // cliAction 错误边界会 process.exit；mock 为 no-op 防杀 test runner，调用参数仍可断言。
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it.each(['create', 'outbox'] as const)(
    'claw alice %s 恰好一次 loadGlobal',
    async (verb) => {
      await dispatchClawSubcommand('alice', [verb], deps);
      expect(h.loadGlobal).toHaveBeenCalledTimes(1);
      expect(h.loadClaw).not.toHaveBeenCalled();
    },
  );

  it.each([['bare claw', undefined, []], ['claw list', 'list', []], ['claw alice chat', 'alice', ['chat']]] as const)(
    '%s 零 loadGlobal / 零 loadClaw',
    async (_label, subject, args) => {
      await dispatchClawSubcommand(subject, [...args], deps);
      expect(h.loadGlobal).not.toHaveBeenCalled();
      expect(h.loadClaw).not.toHaveBeenCalled();
    },
  );

  it('ps missing（loadClaw → undefined）走既有 CliError does-not-exist，不进 psCommand', async () => {
    h.loadClaw.mockReturnValue(undefined);
    await dispatchClawSubcommand('alice', ['ps'], deps);
    expect(h.loadClaw).toHaveBeenCalledTimes(1);
    expect(h.psCommand).not.toHaveBeenCalled();
    expect(h.handleCliError).toHaveBeenCalledTimes(1);
    const err = h.handleCliError.mock.calls[0][0];
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe('Claw "alice" does not exist');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('ps valid config 进入 psCommand，零 loadGlobal', async () => {
    h.loadClaw.mockReturnValue({ schema_version: 1 });
    await dispatchClawSubcommand('alice', ['ps'], deps);
    expect(h.loadClaw).toHaveBeenCalledTimes(1);
    expect(h.psCommand).toHaveBeenCalledTimes(1);
    expect(h.loadGlobal).not.toHaveBeenCalled();
  });

  it('ps corrupt/IO：loadClaw 抛 sentinel，同一实例到达错误边界（不伪装 missing）', async () => {
    const sentinel = new Error('corrupt claw config sentinel');
    h.loadClaw.mockImplementation(() => {
      throw sentinel;
    });
    await dispatchClawSubcommand('alice', ['ps'], deps);
    expect(h.psCommand).not.toHaveBeenCalled();
    expect(h.handleCliError).toHaveBeenCalledTimes(1);
    expect(h.handleCliError).toHaveBeenCalledWith(sentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // phase 1324 Step B：read/ls 已迁入共享 ClawCommandDeps；Router 必须把同一个
  // deps 对象原样透传给 handler（不新构窄对象），自身保持零 config call。
  it.each([
    ['read', ['read', 'note.md'], h.readCommand],
    ['ls', ['ls'], h.lsCommand],
    ['health', ['health'], h.healthCommand],
    ['status', ['status'], h.clawStatusCommand],
    ['stop', ['stop'], h.stopCommand],
    ['daemon', ['daemon'], h.clawDaemonCommand],
    ['send', ['send', 'hello'], h.sendCommand],
    ['import', ['import', 'note.md'], h.importCommand],
    ['trace', ['trace', '--contract', 'C-1'], h.clawTraceCommand],
    ['stream', ['stream'], h.runStreamFromArgs],
    ['watch', ['watch'], h.watchCommand],
  ] as const)(
    'claw alice %s：Router 透传同一 deps 对象给 handler，自身零 loadGlobal/loadClaw',
    async (_verb, args, handler) => {
      await dispatchClawSubcommand('alice', [...args], deps);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBe(deps);
      expect(h.loadGlobal).not.toHaveBeenCalled();
      expect(h.loadClaw).not.toHaveBeenCalled();
    },
  );
});
