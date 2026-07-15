/**
 * createInterruptWatcher unit test (phase 361 event-driven 替原 polling)
 *
 * 覆盖契约：
 *   - 'add' 事件 → deleteSync('interrupt') 成功 → onInterrupt() 调用
 *   - deleteSync ENOENT (race) → onError 不触发 (silent ignore)
 *   - deleteSync 非 ENOENT 错 → onError(err) 调用
 *   - 'change' 事件 → 同 add 路径
 *   - 'unlink' 事件 → 不触发 onInterrupt
 *
 * 不依赖 daemon-loop / vi.useFakeTimers — 直接 mock fs 和 file-watcher event 触发.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInterruptWatcher } from '../../src/daemon/interrupt-watcher.js';
import type { Watcher } from '../../src/foundation/file-watcher/index.js';

interface MockFs {
  deleteSync: ReturnType<typeof vi.fn>;
}

describe('createInterruptWatcher (phase 361 event-driven)', () => {
  function makeFs(): MockFs {
    return {
      deleteSync: vi.fn(),
    };
  }

  function makeCreateWatcher() {
    return vi.fn((_path: string, callback: (ev: { type: string; path: string }) => void) => {
      return {
        close: vi.fn(),
        _callback: callback,
      } as unknown as Watcher;
    });
  }

  function captureCallback(createWatcher: ReturnType<typeof makeCreateWatcher>): (event: { type: string; path: string }) => void {
    const calls = createWatcher.mock.calls;
    return calls[calls.length - 1][1];
  }

  it('add 事件 → deleteSync 成功 → onInterrupt 调用', () => {
    const agentFs = makeFs();
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const createWatcher = makeCreateWatcher();

    createInterruptWatcher({
      agentFs: agentFs as never,
      agentDir: '/test/agent',
      onInterrupt,
      onError,
      createWatcher,
    });

    const callback = captureCallback(createWatcher);
    callback({ type: 'add', path: '/test/agent/interrupt' });

    expect(agentFs.deleteSync).toHaveBeenCalledWith('interrupt');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('deleteSync ENOENT (race) → silent ignore, 不调 onError', () => {
    const agentFs = makeFs();
    agentFs.deleteSync.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const createWatcher = makeCreateWatcher();

    createInterruptWatcher({
      agentFs: agentFs as never,
      agentDir: '/test/agent',
      onInterrupt,
      onError,
      createWatcher,
    });

    const callback = captureCallback(createWatcher);
    callback({ type: 'add', path: '/test/agent/interrupt' });

    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('deleteSync 非 ENOENT 错 → onError 调用', () => {
    const agentFs = makeFs();
    const ioError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    ioError.code = 'EACCES';
    agentFs.deleteSync.mockImplementation(() => {
      throw ioError;
    });
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const createWatcher = makeCreateWatcher();

    createInterruptWatcher({
      agentFs: agentFs as never,
      agentDir: '/test/agent',
      onInterrupt,
      onError,
      createWatcher,
    });

    const callback = captureCallback(createWatcher);
    callback({ type: 'add', path: '/test/agent/interrupt' });

    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(ioError);
  });

  it('change 事件 → 同 add 路径 (deleteSync + onInterrupt)', () => {
    const agentFs = makeFs();
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const createWatcher = makeCreateWatcher();

    createInterruptWatcher({
      agentFs: agentFs as never,
      agentDir: '/test/agent',
      onInterrupt,
      onError,
      createWatcher,
    });

    const callback = captureCallback(createWatcher);
    callback({ type: 'change', path: '/test/agent/interrupt' });

    expect(agentFs.deleteSync).toHaveBeenCalledWith('interrupt');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('unlink 事件 → 不触发 onInterrupt (interrupt 文件被外部清理后不应再 abort)', () => {
    const agentFs = makeFs();
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const createWatcher = makeCreateWatcher();

    createInterruptWatcher({
      agentFs: agentFs as never,
      agentDir: '/test/agent',
      onInterrupt,
      onError,
      createWatcher,
    });

    const callback = captureCallback(createWatcher);
    callback({ type: 'unlink', path: '/test/agent/interrupt' });

    expect(agentFs.deleteSync).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
