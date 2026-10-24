/**
 * phase 1986 Step H：motion CLI 调用者守卫测试（Step G 行为）。
 *
 * 真实 commander + registerMotionCliGuard，矩阵覆盖：
 * - caller 三态（无 marker / motion / 其他 agent）
 * - 四类入口：顶层 motion 家族、stop/start、任意命令 --claw motion、claw motion <verb>
 * - skill install/list 缺省 --claw = motion
 * - help 放行
 * - wiring source-scan：src/cli/index.ts 顶部 capture + program 注册钩子
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  captureCliCallerIdentity,
  registerMotionCliGuard,
} from '../../src/cli/motion-cli-guard.js';
import { CALLER_AGENT_ID_ENV } from '../../src/foundation/command-tool/index.js';

class ExitSentinel extends Error {
  constructor(public readonly exitCode: unknown) {
    super(`__exit__:${String(exitCode)}`);
  }
}

/**
 * 镜像 src/cli/index.ts 的相关命令形状：
 * - claw 命令：passThroughOptions + allowUnknownOption + helpOption(false)
 * - --claw 选项定义在各 leaf 子命令上
 */
function buildProgram(actionSpy: ReturnType<typeof vi.fn>): Command {
  const program = new Command();
  program.name('chestnut').exitOverride();
  // 镜像 src/cli/index.ts：claw 子命令 passThroughOptions 要求父级 enablePositionalOptions
  program.enablePositionalOptions();
  registerMotionCliGuard(program);

  const motion = program.command('motion');
  motion.command('inbox').action(actionSpy);

  program.command('stop').action(actionSpy);
  program.command('start').action(actionSpy);

  const contract = program.command('contract');
  contract.command('status').option('--claw <id>').action(actionSpy);

  program.command('audit').option('--claw <id>').action(actionSpy);

  program
    .command('claw [subject] [args...]')
    .passThroughOptions()
    .allowUnknownOption()
    .helpOption(false)
    .action(actionSpy);

  const skill = program.command('skill');
  skill.command('install').option('--claw <id>').action(actionSpy);
  skill.command('list').option('--claw <id>').action(actionSpy);

  return program;
}

interface RunResult {
  actionCalls: number;
  exitCode: unknown;
}

async function runCli(argv: string[], caller: string | undefined): Promise<RunResult> {
  const actionSpy = vi.fn();
  const program = buildProgram(actionSpy);
  if (caller !== undefined) {
    vi.stubEnv(CALLER_AGENT_ID_ENV, caller);
  }
  captureCliCallerIdentity();

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitSentinel(code);
  });

  let exitCode: unknown;
  try {
    await program.parseAsync(['node', 'chestnut', ...argv]);
  } catch (err) {
    if (err instanceof ExitSentinel) {
      exitCode = err.exitCode;
    } else {
      throw err;
    }
  }
  exitSpy.mockRestore();
  return { actionCalls: actionSpy.mock.calls.length, exitCode };
}

describe('motion CLI guard (phase 1986 Step G/H)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // 重置模块级 captured caller，防跨用例泄漏
    captureCliCallerIdentity();
  });

  it('captureCliCallerIdentity 读取后立即删除 env marker', () => {
    vi.stubEnv(CALLER_AGENT_ID_ENV, 'alice');
    captureCliCallerIdentity();
    expect(process.env[CALLER_AGENT_ID_ENV]).toBeUndefined();
  });

  // ── 其他 agent 调用者：motion 目标一律拒（exit 1、action 不执行）────────────
  it.each([
    ['顶层 motion 家族', ['motion', 'inbox']],
    ['顶层 stop', ['stop']],
    ['顶层 start', ['start']],
    ['--claw motion（contract）', ['contract', 'status', '--claw', 'motion']],
    ['--claw motion（audit）', ['audit', '--claw', 'motion']],
    ['claw motion <verb>', ['claw', 'motion', 'send', 'hello']],
    ['skill install 缺省 claw=motion', ['skill', 'install']],
    ['skill list 缺省 claw=motion', ['skill', 'list']],
  ])('caller=alice → %s 被拒：exit 1、action 0 次', async (_label, argv) => {
    const result = await runCli(argv, 'alice');
    expect(result.exitCode).toBe(1);
    expect(result.actionCalls).toBe(0);
  });

  // ── 其他 agent 调用者：非 motion 目标放行 ─────────────────────────────────
  it.each([
    ['--claw alice（contract）', ['contract', 'status', '--claw', 'alice']],
    ['--claw alice（skill install）', ['skill', 'install', '--claw', 'alice']],
    ['claw alice <verb>', ['claw', 'alice', 'send', 'hello']],
    ['claw list', ['claw', 'list']],
    ['claw motion <verb> --help 放行', ['claw', 'motion', 'send', '--help']],
    ['claw motion -h 放行', ['claw', 'motion', '-h']],
  ])('caller=alice → %s 放行：action 1 次', async (_label, argv) => {
    const result = await runCli(argv, 'alice');
    expect(result.exitCode).toBeUndefined();
    expect(result.actionCalls).toBe(1);
  });

  // ── motion 主代理调用者：全放行 ────────────────────────────────────────────
  it.each([
    ['顶层 stop', ['stop']],
    ['claw motion <verb>', ['claw', 'motion', 'ps']],
    ['顶层 motion 家族', ['motion', 'inbox']],
  ])('caller=motion → %s 放行：action 1 次', async (_label, argv) => {
    const result = await runCli(argv, 'motion');
    expect(result.exitCode).toBeUndefined();
    expect(result.actionCalls).toBe(1);
  });

  // ── 无 marker（用户终端）：全放行 ──────────────────────────────────────────
  it.each([
    ['顶层 stop', ['stop']],
    ['顶层 motion 家族', ['motion', 'inbox']],
    ['claw motion <verb>', ['claw', 'motion', 'ps']],
  ])('无 marker → %s 放行：action 1 次', async (_label, argv) => {
    const result = await runCli(argv, undefined);
    expect(result.exitCode).toBeUndefined();
    expect(result.actionCalls).toBe(1);
  });

  // ── wiring source-scan：CLI 唯一入口必须 capture + 注册钩子 ────────────────
  it('src/cli/index.ts 顶部 capture caller 且 program 注册守卫钩子', () => {
    const source = readFileSync(
      path.join(__dirname, '../../src/cli/index.ts'),
      'utf8',
    );
    expect(source).toContain('captureCliCallerIdentity();');
    expect(source).toContain('registerMotionCliGuard(program);');
  });
});
