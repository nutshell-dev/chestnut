/**
 * Phase 1929 Step B：dispatch-skill 命令族真实 CLI 契约测试。
 *
 * - `dispatch-skill --help` / `dispatch-skill edit --help`：新命令族可解析，
 *   catalog 投影的 help 覆盖 begin/submit/basis/retry/status/history；
 * - 旧 `skill edit` / `skill history` 入口：明确非零迁移错误、指向新命令族，
 *   绝不调用 owner（版本服务状态目录零落盘）；`skill --help` 不再宣传旧接口；
 * - 反向：迁移错误不创建任何编辑事务/版本状态；旧 saved editId 的事务文件
 *   在新命令族下仍可继续（行为等价由 skill-edit.test.ts handler 级覆盖）。
 *
 * 真实链：spawn `node dist/cli.js`（CHESTNUT_ROOT 指向临时工作区），
 * 命令解析与迁移门控在真实 Commander 上验收。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChildProcessLifecycleError,
  runChildProcess,
  withCleanupPreservingError,
  type ChildProcessFailureDetails,
  type ChildProcessResult,
} from '../utils/child-process.js';
import * as fsSync from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

/** Vitest protection budget only; the tested I/O has its own owner. */
const CLI_DISPATCH_RUNNER_TIMEOUT_MS = 120_000;
const CLI_DISPATCH_CASE_EXECUTION_BUDGET_MS = 12_000; // 15s test budget minus termination and assertions.
const CLI_DISPATCH_LONG_CASE_EXECUTION_BUDGET_MS = 117_000; // 120s case minus termination and assertions.

const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');

function executionDeadline(budgetMs: number): number {
  return performance.now() + budgetMs;
}

interface DispatchCase {
  root: string;
  signal: AbortSignal;
  deadline: number;
  finishing: boolean;
  outcomes: Array<Promise<PromiseSettledResult<unknown>>>;
  finishPromise?: Promise<void>;
}

function createDispatchCase(
  root: string,
  signal: AbortSignal,
  budgetMs = CLI_DISPATCH_CASE_EXECUTION_BUDGET_MS,
): DispatchCase {
  return { root, signal, deadline: executionDeadline(budgetMs), finishing: false, outcomes: [] };
}

async function finishCase(state: DispatchCase): Promise<void> {
  if (!state.finishPromise) {
    state.finishPromise = withCleanupPreservingError(async () => {
      state.finishing = true;
      const results = await Promise.all(state.outcomes);
      const errors = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'CLI operations failed', { cause: errors[0] });
      }
    }, () => cleanupTempDir(state.root));
  }
  return state.finishPromise;
}

async function runCli(
  args: string[],
  state: DispatchCase,
  execute: typeof runChildProcess = runChildProcess,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (state.finishing) throw new Error('dispatch-skill case is already finishing');
  const remainingMs = Math.floor(state.deadline - performance.now());
  if (remainingMs <= 0) throw new Error('dispatch-skill case execution budget exhausted');
  const operation = execute(process.execPath, [CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      CHESTNUT_ROOT: state.root,
      CHESTNUT_CALLER_AGENT_ID: undefined,
      NODE_ENV: 'test',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    cwd: state.root,
    timeoutMs: remainingMs,
    signal: state.signal,
  }).then(result => {
    if (result.error) throw result.error;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
  });
  const observed = operation.then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason }),
  );
  state.outcomes.push(observed);
  return await operation;
}

async function captureFailure(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (error: unknown) => error);
}

function injectedLifecycleFailure(directChild: 'exited' | 'unconfirmed' = 'unconfirmed'): ChildProcessLifecycleError {
  return new ChildProcessLifecycleError({
    command: process.execPath,
    args: [],
    pid: 123,
    status: null,
    signal: directChild === 'exited' ? 'SIGTERM' : null,
    stdout: '',
    stderr: '',
    errors: [],
    directChild: directChild === 'exited'
      ? { state: 'exited', status: null, signal: 'SIGTERM' }
      : { state: 'unconfirmed' },
    stdio: 'detached',
    outputTruncated: true,
    outputTruncatedAt: null,
    reason: 'cancelled',
    timeoutMs: CLI_DISPATCH_CASE_EXECUTION_BUDGET_MS,
    killGraceMs: 0,
    exitConfirmMs: 0,
    killSignals: [],
    killAttempts: [],
    killErrors: [],
    cleanup: 'detached',
    resourceEvidence: { state: 'not_configured' },
  } as ChildProcessFailureDetails, new Error('injected dispatch cancellation'));
}

function successfulChildResult(): ChildProcessResult {
  return {
    command: process.execPath,
    args: [],
    pid: 123,
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    errors: [],
    directChild: { state: 'exited', status: 0, signal: null },
    stdio: 'closed',
    outputTruncated: false,
    outputTruncatedAt: null,
  };
}

describe('dispatch-skill 命令族 CLI（phase 1929 Step B）', () => {
  let tmpDir: string;
  let currentCase: DispatchCase;

  beforeEach(async context => {
    tmpDir = await createTrackedTempDir('dispatch-skill-cli-');
    currentCase = createDispatchCase(tmpDir, context.signal);
    expect(fsSync.existsSync(CLI_ENTRY)).toBe(true);
    const ownedCase = currentCase;
    context.onTestFinished(() => finishCase(ownedCase));
  });

  const runCurrentCli = (args: string[]) => runCli(args, currentCase);

  it('dispatch-skill --help 列出 list/edit/history；edit 子族 help 列出全部事务命令', async () => {
    const help = await runCurrentCli(['dispatch-skill', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('dispatch skill pool');
    // Phase 1929 Step C：已发布池列表入口
    expect(help.stdout).toContain('list');
    expect(help.stdout).toContain('edit');
    expect(help.stdout).toContain('history');

    const editHelp = await runCurrentCli(['dispatch-skill', 'edit', '--help']);
    expect(editHelp.exitCode).toBe(0);
    for (const sub of ['begin', 'submit', 'basis', 'retry', 'status']) {
      expect(editHelp.stdout).toContain(sub);
    }
  });

  it('旧 skill edit/history 入口：非零迁移错误指向新命令族，owner 零调用（无版本状态落盘）', async () => {
    const edit = await runCurrentCli(['skill', 'edit', 'begin', 'alpha', '--reason', 'x']);
    expect(edit.exitCode).not.toBe(0);
    expect(edit.stderr).toContain('dispatch-skill edit');

    const history = await runCurrentCli(['skill', 'history', 'alpha']);
    expect(history.exitCode).not.toBe(0);
    expect(history.stderr).toContain('dispatch-skill history');

    // 迁移错误发生在 CLI 呈现层：绝不触碰 dispatch 版本服务（无状态目录落盘）
    expect(fsSync.existsSync(
      path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state'),
    )).toBe(false);
    expect(fsSync.existsSync(
      path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills'),
    )).toBe(false);
  });

  it('skill --help 不再宣传旧 edit/history 接口；install/list 仍在', async () => {
    const help = await runCurrentCli(['skill', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('install');
    expect(help.stdout).toContain('list');
    expect(help.stdout).not.toContain('edit');
    expect(help.stdout).not.toContain('history');
  });

  it('dispatch-skill list 空池：observe_only 可读，已发布空态如实呈现', async () => {
    const list = await runCurrentCli(['dispatch-skill', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('Dispatch skill pool (published):');
    expect(list.stdout).toContain('No skills loaded.');
  });

  it('dispatch-skill history 空池：observe_only 可读，空态如实呈现', async () => {
    const history = await runCurrentCli(['dispatch-skill', 'history', 'alpha']);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain('No history for dispatch skill "alpha".');
  });

  it('dispatch-skill 未知子命令：非零 + 可用命令列表', async () => {
    const res = await runCurrentCli(['dispatch-skill', 'frobnicate']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("unknown command 'frobnicate'");
  });

  // Phase 1929 Step F：查询入口经 createDispatchVersions 触发 owner 初始化/恢复/
  // 维护时，业务审计事件必须持久落盘（不再 noop），action scope 统一释放
  it('查询入口 owner 维护审计落盘；失败路径审计保留；重复查询不产生用户编辑', async () => {
    currentCase.deadline = executionDeadline(CLI_DISPATCH_LONG_CASE_EXECUTION_BUDGET_MS);
    // 预置旧 live 树 → 首次构造版本服务触发 baseline 迁移（owner 业务事件）
    const legacyDir = path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills', 'alpha');
    fsSync.mkdirSync(legacyDir, { recursive: true });
    fsSync.writeFileSync(path.join(legacyDir, 'SKILL.md'), '---\nname: alpha\ndescription: legacy\n---\n# Alpha\n');

    const list = await runCurrentCli(['dispatch-skill', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('alpha: legacy');

    // 业务审计落盘（cli_invoke/cli_settled 之外、来自 owner 的事件）
    const auditFile = path.join(tmpDir, '.chestnut', 'audit.tsv');
    expect(fsSync.existsSync(auditFile)).toBe(true);
    expect(fsSync.readFileSync(auditFile, 'utf-8')).toContain('skill_version_baseline_created');

    const history = await runCurrentCli(['dispatch-skill', 'history', 'alpha']);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain('History for dispatch skill "alpha"');

    // 不存在的 edit status：factory 初始化后失败——非零退出且初始化审计保留
    const status = await runCurrentCli(['dispatch-skill', 'edit', 'status', 'edit-nonexistent']);
    expect(status.exitCode).not.toBe(0);
    expect(status.stderr).toContain('Unknown edit');
    expect(fsSync.readFileSync(auditFile, 'utf-8')).toContain('skill_version_baseline_created');

    // 重复查询不产生用户编辑事务/发布
    await runCurrentCli(['dispatch-skill', 'list']);
    const editsDir = path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state', 'edits');
    const edits = fsSync.existsSync(editsDir)
      ? fsSync.readdirSync(editsDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(edits).toEqual([]);
  }, CLI_DISPATCH_RUNNER_TIMEOUT_MS);
});


describe('dispatch case fixture finalization', () => {
  it('retains a rejected operation outcome and preserves its root after no work is pending', async () => {
    const root = await createTrackedTempDir('dispatch-unconfirmed-case-');
    const state = createDispatchCase(root, new AbortController().signal);
    const failure = injectedLifecycleFailure();
    const observed = await captureFailure(runCli(['dispatch-skill', 'list'], state, async () => {
      throw failure;
    }));
    expect(observed).toBe(failure);
    await Promise.all(state.outcomes);

    const finished = await captureFailure(finishCase(state));
    expect(finished).toBe(failure);
    expect(fsSync.existsSync(root)).toBe(true);
    await expect(finishCase(state)).rejects.toBe(failure);
    await cleanupTempDir(root);
  });

  it('waits for every operation before preserving a failed shared root', async () => {
    const root = await createTrackedTempDir('dispatch-multiple-outcomes-case-');
    const state = createDispatchCase(root, new AbortController().signal);
    let completeFirst!: (result: ChildProcessResult) => void;
    const first = runCli(['first'], state, () => new Promise(resolve => {
      completeFirst = resolve;
    }));
    const failure = injectedLifecycleFailure();
    expect(await captureFailure(runCli(['second'], state, async () => { throw failure; }))).toBe(failure);

    const finishing = captureFailure(finishCase(state));
    let settled = false;
    void finishing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fsSync.existsSync(root)).toBe(true);
    await expect(runCli(['third'], state)).rejects.toThrow('already finishing');

    completeFirst(successfulChildResult());
    await first;
    expect(await finishing).toBe(failure);
    expect(fsSync.existsSync(root)).toBe(true);
    await cleanupTempDir(root);
  });

  it('cleans an exited cancellation and never touches the next case root or inputs', async () => {
    const firstRoot = await createTrackedTempDir('dispatch-cancelled-case-');
    const firstState = createDispatchCase(firstRoot, new AbortController().signal);
    const failure = injectedLifecycleFailure('exited');
    expect(await captureFailure(runCli(['cancel'], firstState, async () => { throw failure; }))).toBe(failure);

    const nextRoot = await createTrackedTempDir('dispatch-next-case-');
    const nextController = new AbortController();
    const nextState = createDispatchCase(nextRoot, nextController.signal);
    const nextDeadline = nextState.deadline;
    expect(await captureFailure(finishCase(firstState))).toBe(failure);
    expect(fsSync.existsSync(firstRoot)).toBe(false);
    expect(fsSync.existsSync(nextRoot)).toBe(true);
    expect(nextState.signal).toBe(nextController.signal);
    expect(nextState.deadline).toBe(nextDeadline);

    await finishCase(nextState);
    expect(fsSync.existsSync(nextRoot)).toBe(false);
  });
});
