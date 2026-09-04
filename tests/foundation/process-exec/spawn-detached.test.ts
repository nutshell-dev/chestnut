/**
 * phase 1763: spawnDetached typed outcome 与 failure sink 测试。
 *
 * 冻结设计（Phase 1762）：
 * - 提交点 = child 'spawn' 事件成功交付且 pid 已存在；
 * - 提交点前同步/异步失败 → SpawnDetachedOutcome.failed（原始 errno/时间/命令身份）；
 * - 提交点后异步失败 → 注入的 onSpawnFailure sink；sink 未注入默认 console.error；
 * - sink 自身抛错 fallback 到 stderr，任何失败不被空 listener 吞掉。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawnDetached } from '../../../src/foundation/process-exec/spawn-detached.js';
import type { SpawnDetachedFailure } from '../../../src/foundation/process-exec/types.js';

/** 手动控制事件时序的 ChildProcess double（真实 EventEmitter + pid/unref）。 */
function makeControllableChild(pid: number | undefined) {
  const proc = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: () => void;
  };
  proc.pid = pid;
  proc.unref = () => {};
  return proc;
}

function errnoError(message: string, code: string, errno: number): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno });
}

describe('spawnDetached typed outcome（phase 1763）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('提交点成功：spawn 事件交付后返回 spawned pid 并 unref', async () => {
    const proc = makeControllableChild(4321);
    const unrefSpy = vi.spyOn(proc, 'unref');
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp' });
    proc.emit('spawn');

    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'spawned', pid: 4321 });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it('异步 pre-commit 失败：error 事件交付 failed outcome，保留 errno/code/命令身份，不返回成功 pid', async () => {
    const proc = makeControllableChild(undefined);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp' });
    proc.emit('error', errnoError('spawn node ENOENT', 'ENOENT', -2));

    const outcome = await pending;
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failure.command).toBe('node');
      expect(outcome.failure.args).toEqual(['entry.js']);
      expect(outcome.failure.errno).toBe(-2);
      expect(outcome.failure.code).toBe('ENOENT');
      expect(outcome.failure.message).toContain('ENOENT');
      expect(outcome.failure.atMs).toBeTypeOf('number');
      expect(outcome.failure.pid).toBeUndefined();
    }
  });

  it('同步 pre-commit 失败：spawn 自身 throw 折叠为 failed outcome', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw errnoError('spawn EINVAL', 'EINVAL', -22);
    });

    const outcome = await spawnDetached('node', ['entry.js'], { cwd: '/tmp' });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failure.code).toBe('EINVAL');
    }
  });

  it('同步 pre-commit 失败：logFile openSync ENOENT 折叠为 failed outcome（保留 errno）', async () => {
    const proc = makeControllableChild(1);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    // 父目录不存在 → openSync 'a' 抛 ENOENT（真实 fs，无需 mock）
    const outcome = await spawnDetached('node', ['entry.js'], {
      cwd: '/tmp',
      logFile: '/nonexistent-dir-1763/logs/daemon.log',
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failure.code).toBe('ENOENT');
    }
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('spawn 事件无 pid 不视为提交成功', async () => {
    const proc = makeControllableChild(undefined);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp' });
    proc.emit('spawn');

    const outcome = await pending;
    expect(outcome.kind).toBe('failed');
  });

  it('post-commit 失败：经注入 sink 交付 pid/errno/时间，且不影响 spawned outcome', async () => {
    const proc = makeControllableChild(7777);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const sink = vi.fn();

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp', onSpawnFailure: sink });
    proc.emit('spawn');
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'spawned', pid: 7777 });

    proc.emit('error', errnoError('spawn node EACCES', 'EACCES', -13));
    expect(sink).toHaveBeenCalledTimes(1);
    const failure = sink.mock.calls[0][0] as SpawnDetachedFailure;
    expect(failure.pid).toBe(7777);
    expect(failure.command).toBe('node');
    expect(failure.code).toBe('EACCES');
    expect(failure.atMs).toBeTypeOf('number');
  });

  it('pre-commit 失败不触发 post-commit sink', async () => {
    const proc = makeControllableChild(undefined);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const sink = vi.fn();

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp', onSpawnFailure: sink });
    proc.emit('error', errnoError('spawn node ENOENT', 'ENOENT', -2));
    await pending;

    expect(sink).not.toHaveBeenCalled();
  });

  it('未注入 sink 时 post-commit 失败默认 console.error（不被空 listener 吞掉）', async () => {
    const proc = makeControllableChild(8888);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp' });
    proc.emit('spawn');
    await pending;

    proc.emit('error', errnoError('spawn node ENOENT', 'ENOENT', -2));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('ENOENT');
    expect(errSpy.mock.calls[0][0]).toContain('pid=8888');
  });

  it('sink 自身抛错 fallback 到 stderr 且带原 failure 证据', async () => {
    const proc = makeControllableChild(9999);
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = vi.fn(() => {
      throw new Error('audit disk full');
    });

    const pending = spawnDetached('node', ['entry.js'], { cwd: '/tmp', onSpawnFailure: sink });
    proc.emit('spawn');
    await pending;

    proc.emit('error', errnoError('spawn node EACCES', 'EACCES', -13));
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0][0] as string;
    expect(line).toContain('failure sink threw');
    expect(line).toContain('audit disk full');
    expect(line).toContain('EACCES');
    expect(line).toContain('9999');
  });
});
