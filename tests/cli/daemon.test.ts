import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { acquireDaemonLock } from '../../src/cli/commands/daemon.js';
import { CliError } from '../../src/cli/errors.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: vi.fn((...args: any[]) => actual.openSync(...args)),
    readFileSync: vi.fn((...args: any[]) => actual.readFileSync(...args)),
  };
});

describe('acquireDaemonLock — fix 004: TOCTOU race protection', () => {
  let tmpDir: string;
  let statusDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `daemon-fix4-${randomUUID()}`);
    statusDir = path.join(tmpDir, 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
  });

  afterEach(() => {
    vi.mocked(fsNative.openSync).mockRestore();
    vi.mocked(fsNative.readFileSync).mockRestore();
    vi.restoreAllMocks();
    fsNative.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws CliError when another daemon acquires the lock during retry', () => {
    // 第一次 openSync 抛 EEXIST（锁已存在）
    (fsNative.openSync as any)
      .mockImplementationOnce((p: any, flags: any) => {
        if (flags === 'wx') {
          const err: any = new Error('EEXIST');
          err.code = 'EEXIST';
          throw err;
        }
        return fsNative.openSync(p, flags);
      })
      // 第二次 openSync（重试时）也抛 EEXIST（模拟竞态抢占）
      .mockImplementationOnce((p: any, flags: any) => {
        if (flags === 'wx') {
          const err: any = new Error('EEXIST');
          err.code = 'EEXIST';
          throw err;
        }
        return fsNative.openSync(p, flags);
      });

    // 读取 PID 返回一个存在的 PID
    (fsNative.readFileSync as any).mockReturnValue('12345\n');
    // process.kill 抛异常（模拟原持有者已死）
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    expect(() => acquireDaemonLock(statusDir, 'test-claw')).toThrow(
      '[daemon] Another test-claw daemon acquired the lock during retry, exiting',
    );
  });

  it('throws CliError when lock file contains non-numeric pid', () => {
    (fsNative.openSync as any).mockImplementationOnce((p: any, flags: any) => {
      if (flags === 'wx') {
        const err: any = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return fsNative.openSync(p, flags);
    });
    (fsNative.readFileSync as any).mockReturnValue('not-a-number\n');

    expect(() => acquireDaemonLock(statusDir, 'test-claw')).toThrow(
      '[daemon] Lock file corrupted',
    );
  });
});
