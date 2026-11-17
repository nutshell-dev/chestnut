/**
 * Phase 1247 Step C: CLI 统一监督策略门测试。
 *
 * 验证：
 * - required 调用 ensureWatchdog 后再执行 handler；
 * - observe_only 只读存活状态、不启动；
 * - disabled / internal 不调用 ensure；
 * - ensure 失败时 handler 不执行、错误沿 withCliErrorHandling 边界暴露；
 * - 散点 ensure 归零后 policy helper 是 src/cli 唯一 ensure 入口。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { cliAction, cliDeferredRequiredAction, makeEnsureSupervision } from '../../src/cli/supervision-policy.js';
import type { HostSupervisor, SupervisorReceipt, SupervisorRequest } from '../../src/foundation/supervision/index.js';
import { ensureWatchdog } from '../../src/watchdog/ensure.js';
import { inspectWatchdogLivenessForCli } from '../../src/watchdog/watchdog-pid.js';
import { withCliErrorHandling } from '../../src/cli/with-cli-error-handling.js';
import { CliError } from '../../src/cli/errors.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

vi.mock('../../src/watchdog/ensure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/ensure.js')>();
  return {
    ...actual,
    ensureWatchdog: vi.fn(),
  };
});

vi.mock('../../src/watchdog/watchdog-pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-pid.js')>();
  return {
    ...actual,
    inspectWatchdogLivenessForCli: vi.fn().mockReturnValue('alive'),
  };
});

const fsFactory = (baseDir: string) => ({ baseDir } as any);

let handlerCalls: string[];

beforeEach(() => {
  handlerCalls = [];
  vi.mocked(ensureWatchdog).mockReset().mockResolvedValue(undefined);
  vi.mocked(inspectWatchdogLivenessForCli).mockReset().mockReturnValue('alive');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cliAction policy execution', () => {
  it('required: 先 ensureWatchdog 再 handler', async () => {
    let ensureResolved = false;
    vi.mocked(ensureWatchdog).mockImplementation(async () => {
      ensureResolved = true;
    });
    const wrapped = cliAction('required', async () => {
      expect(ensureResolved).toBe(true);
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(ensureWatchdog).toHaveBeenCalledWith(fsFactory);
    expect(handlerCalls).toContain('handler');
  });

  it('observe_only: 读取存活状态但不启动', async () => {
    const wrapped = cliAction('observe_only', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(inspectWatchdogLivenessForCli).toHaveBeenCalledWith(fsFactory);
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toContain('handler');
  });

  it('disabled: 不检查也不启动 watchdog', async () => {
    const wrapped = cliAction('disabled', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(inspectWatchdogLivenessForCli).not.toHaveBeenCalled();
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toContain('handler');
  });

  it('internal: 不检查也不启动 watchdog', async () => {
    const wrapped = cliAction('internal', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(inspectWatchdogLivenessForCli).not.toHaveBeenCalled();
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toContain('handler');
  });

  it('required ensure 失败时 handler 零副作用', async () => {
    vi.mocked(ensureWatchdog).mockRejectedValue(new Error('spawn failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });

    const wrapped = cliAction('required', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await expect(wrapped()).rejects.toThrow('exit:1');
    expect(handlerCalls).toEqual([]);
    exitSpy.mockRestore();
  });

  it('返回函数仍经过 withCliErrorHandling（非 CliError 也处理）', async () => {
    // withCliErrorHandling 会 catch 错误并 process.exit；这里只测它确实 wrap 了 handler
    const wrapped = cliAction('disabled', async () => {
      throw new Error('boom');
    }, { fsFactory });

    // withCliErrorHandling 调用 process.exit，mock 它以抛错让测试可观测
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const handleCliErrorModule = await import('../../src/cli/errors.js');
    const handleSpy = vi.spyOn(handleCliErrorModule, 'handleCliError').mockReturnValue(1);

    await expect(wrapped()).rejects.toThrow('exit');

    expect(handleSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    exitSpy.mockRestore();
    handleSpy.mockRestore();
  });
});

describe('cliAction argument forwarding', () => {
  it('required handler 接收原始参数', async () => {
    const wrapped = cliAction('required', async (a: string, b: number) => {
      handlerCalls.push(`${a}:${b}`);
    }, { fsFactory });

    await wrapped('hello', 42);

    expect(handlerCalls).toEqual(['hello:42']);
  });
});

describe('cliDeferredRequiredAction (phase 1280)', () => {
  it('不在 handler 前 ensure；capability 被调用时才委托 ensureWatchdog', async () => {
    const wrapped = cliDeferredRequiredAction(async (ensureSupervision) => {
      expect(ensureWatchdog).not.toHaveBeenCalled();
      handlerCalls.push('bootstrap');
      await ensureSupervision();
      handlerCalls.push('business');
    }, { fsFactory });

    await wrapped();

    expect(ensureWatchdog).toHaveBeenCalledTimes(1);
    expect(ensureWatchdog).toHaveBeenCalledWith(fsFactory);
    expect(handlerCalls).toEqual(['bootstrap', 'business']);
  });

  it('handler 不调用 capability 时 ensure 零次', async () => {
    const wrapped = cliDeferredRequiredAction(async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toEqual(['handler']);
  });

  it('phase 1874 Step K: 重复调用 capability → ensureWatchdog 恰一次 + 同一 receipt（幂等）', async () => {
    vi.mocked(ensureWatchdog).mockResolvedValue(undefined);
    const receipts: unknown[] = [];
    const wrapped = cliDeferredRequiredAction(async (ensureSupervision) => {
      receipts.push(await ensureSupervision());
      receipts.push(await ensureSupervision());
      receipts.push(await ensureSupervision());
    }, { fsFactory });

    await wrapped();

    // 恰好一次：不重复 spawn/check；receipt 同一引用 = 同一次行使
    expect(ensureWatchdog).toHaveBeenCalledTimes(1);
    expect(receipts[0]).toBe(receipts[1]);
    expect(receipts[1]).toBe(receipts[2]);
    const r = receipts[0] as { grantedAt: number; via: string };
    expect(typeof r.grantedAt).toBe('number');
    expect(r.via).toBe('watchdog_ensure');
  });

  it('phase 1874 Step K: 零次调用（handler 在提交点前失败）→ ensure 零次、无 receipt', async () => {
    const wrapped = cliDeferredRequiredAction(async () => {
      throw new CliError('bootstrap failed before commit point', 1);
    }, { fsFactory });

    await expect(wrapped()).rejects.toThrow();
    expect(ensureWatchdog).not.toHaveBeenCalled();
  });

  it('原样转发 Commander 参数（capability 之后的 args）', async () => {
    const wrapped = cliDeferredRequiredAction(async (_ensure, a: string, b: number) => {
      handlerCalls.push(`${a}:${b}`);
    }, { fsFactory });

    await wrapped('hello', 42);

    expect(handlerCalls).toEqual(['hello:42']);
  });

  it('capability 失败时错误进入 withCliErrorHandling 边界、后续动作零副作用', async () => {
    vi.mocked(ensureWatchdog).mockRejectedValue(new Error('spawn failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });

    const wrapped = cliDeferredRequiredAction(async (ensureSupervision) => {
      await ensureSupervision();
      handlerCalls.push('business');
    }, { fsFactory });

    await expect(wrapped()).rejects.toThrow('exit:1');
    expect(handlerCalls).toEqual([]);
    exitSpy.mockRestore();
  });
});


function supervisorReceipt(
  request: SupervisorRequest,
  result: SupervisorReceipt['result'],
): SupervisorReceipt {
  return {
    request,
    attempt: result === 'unavailable' ? null : 'attempt-1',
    owner: { ownerId: 'host-1', mechanism: 'fixture' },
    result,
    evidence: { adapter: 'fixture', result },
  };
}

describe('Phase 2184 host-supervisor policy boundary', () => {
  it('available supervisor performs ensure once and deferred callers share its receipt', async () => {
    const supervisor: HostSupervisor = {
      inspectAvailability: vi.fn().mockResolvedValue({
        kind: 'available', ownerId: 'host-1', mechanism: 'fixture',
      }),
      ensureWatchdog: vi.fn().mockImplementation(async (request) => supervisorReceipt(request, 'started')),
    };
    const receipts: unknown[] = [];
    const wrapped = cliDeferredRequiredAction(async (ensure) => {
      expect(supervisor.inspectAvailability).not.toHaveBeenCalled();
      receipts.push(await ensure());
      receipts.push(await ensure());
    }, { fsFactory, hostSupervisor: supervisor });

    await wrapped();

    expect(supervisor.inspectAvailability).toHaveBeenCalledTimes(1);
    expect(supervisor.ensureWatchdog).toHaveBeenCalledTimes(1);
    expect(supervisor.ensureWatchdog).toHaveBeenCalledWith({
      reason: 'cli_deferred_action', correlationId: expect.any(String),
    });
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(receipts[0]).toBe(receipts[1]);
    expect(receipts[0]).toMatchObject({
      via: 'host_supervisor_ensure',
      supervisorReceipt: { result: 'started' },
    });
  });

  it.each(['not_installed', 'permission_denied', 'unsupported'] as const)(
    'typed %s preserves manual ensure fallback and visible unavailable state',
    async (reason) => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const supervisor: HostSupervisor = {
        inspectAvailability: vi.fn().mockResolvedValue({ kind: 'unavailable', reason, evidence: {} }),
        ensureWatchdog: vi.fn(),
      };
      const wrapped = cliAction('required', async () => { handlerCalls.push('handler'); }, {
        fsFactory, hostSupervisor: supervisor,
      });

      await wrapped();

      expect(ensureWatchdog).toHaveBeenCalledTimes(1);
      expect(supervisor.ensureWatchdog).not.toHaveBeenCalled();
      expect(handlerCalls).toEqual(['handler']);
      expect(consoleSpy).toHaveBeenCalledWith(`[cli] supervision=unavailable reason=${reason}`);
      consoleSpy.mockRestore();
    },
  );

  it('available supervisor failure does not trigger a competing manual ensure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    const supervisor: HostSupervisor = {
      inspectAvailability: vi.fn().mockResolvedValue({
        kind: 'available', ownerId: 'host-1', mechanism: 'fixture',
      }),
      ensureWatchdog: vi.fn().mockImplementation(async (request) => supervisorReceipt(request, 'failed')),
    };
    const wrapped = cliAction('required', async () => { handlerCalls.push('handler'); }, {
      fsFactory, hostSupervisor: supervisor,
    });

    await expect(wrapped()).rejects.toThrow('exit:1');
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toEqual([]);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('rejects a mismatched supervisor correlation before accepting a started receipt', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supervisor: HostSupervisor = {
      inspectAvailability: vi.fn().mockResolvedValue({
        kind: 'available', ownerId: 'host-1', mechanism: 'fixture',
      }),
      ensureWatchdog: vi.fn().mockImplementation(async (request) =>
        supervisorReceipt({ ...request, correlationId: 'other-operation' }, 'started')),
    };

    await expect(makeEnsureSupervision(fsFactory, supervisor)()).rejects.toMatchObject({
      name: 'HostSupervisionError',
    });
    expect(ensureWatchdog).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('manual fallback and unavailable request share correlation evidence in audit', async () => {
    const previousRoot = process.env.CHESTNUT_ROOT;
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = path.join(os.tmpdir(), `cli-supervision-${randomUUID()}`);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(ensureWatchdog).mockResolvedValue({ kind: 'already_running', pid: 123 });
    try {
      process.env.CHESTNUT_ROOT = tmpDir;
      const realFsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });
      const supervisor: HostSupervisor = {
        inspectAvailability: vi.fn().mockResolvedValue({
          kind: 'unavailable', reason: 'not_installed', evidence: { installed: false },
        }),
        ensureWatchdog: vi.fn(),
      };
      const receipt = await makeEnsureSupervision(realFsFactory, supervisor)();
      const audit = fs.readFileSync(path.join(tmpDir, '.chestnut', 'audit', 'audit.tsv'), 'utf8');

      expect(receipt.via).toBe('watchdog_ensure');
      expect(audit).toContain('cli_supervision_unavailable');
      expect(audit).toContain('cli_watchdog_ensure');
      expect(audit).toContain('trigger=cli_manual');
      expect(audit).toContain(`correlation_id=${receipt.correlationId}`);
      expect(audit).not.toContain('supervision_takeover');
    } finally {
      consoleSpy.mockRestore();
      if (previousRoot === undefined) delete process.env.CHESTNUT_ROOT;
      else process.env.CHESTNUT_ROOT = previousRoot;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
