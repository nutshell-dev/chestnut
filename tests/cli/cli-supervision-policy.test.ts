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

import { cliAction, cliDeferredRequiredAction } from '../../src/cli/supervision-policy.js';
import { ensureWatchdog } from '../../src/watchdog/ensure.js';
import { isWatchdogAlive } from '../../src/watchdog/watchdog-pid.js';
import { withCliErrorHandling } from '../../src/cli/with-cli-error-handling.js';

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
    isWatchdogAlive: vi.fn().mockReturnValue(true),
  };
});

const fsFactory = (baseDir: string) => ({ baseDir } as any);

let handlerCalls: string[];

beforeEach(() => {
  handlerCalls = [];
  vi.mocked(ensureWatchdog).mockReset().mockResolvedValue(undefined);
  vi.mocked(isWatchdogAlive).mockReset().mockReturnValue(true);
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

    expect(isWatchdogAlive).toHaveBeenCalledWith(fsFactory);
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toContain('handler');
  });

  it('disabled: 不检查也不启动 watchdog', async () => {
    const wrapped = cliAction('disabled', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(isWatchdogAlive).not.toHaveBeenCalled();
    expect(ensureWatchdog).not.toHaveBeenCalled();
    expect(handlerCalls).toContain('handler');
  });

  it('internal: 不检查也不启动 watchdog', async () => {
    const wrapped = cliAction('internal', async () => {
      handlerCalls.push('handler');
    }, { fsFactory });

    await wrapped();

    expect(isWatchdogAlive).not.toHaveBeenCalled();
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
