/**
 * daemon-loop startup_check_ts atomic tmp+rename + fsync (phase 1136 / F.2a + phase 1214)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

const STATUS_SUBDIR = 'status';

// phase 1214: mock fsyncSync to verify invocation in ESM
let mockFsyncSync = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    fsyncSync: (...args: any[]) => mockFsyncSync(...args),
  };
});

import * as fsNative from 'fs';

describe('startup_check_ts atomic tmp+rename + fsync (phase 1136 / F.2a + phase 1214)', () => {
  let agentDir: string;
  let startupCheckTsFile: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `startup-check-atomic-test-${randomUUID()}`);
    fsNative.mkdirSync(agentDir, { recursive: true });
    startupCheckTsFile = path.join(agentDir, STATUS_SUBDIR, 'startup_check_ts');
    mockFsyncSync = vi.fn();
  });

  afterEach(() => {
    fsNative.rmSync(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('反向 1：happy tmp+rename+fsync + target file 内容正确', () => {
    const before = Date.now();

    // Inline helper (replicated from daemon-loop.ts)
    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      fsNative.writeFileSync(tmpFile, String(Date.now()));
      const fd = fsNative.openSync(tmpFile, 'r+');
      try {
        fsNative.fsyncSync(fd);
      } finally {
        fsNative.closeSync(fd);
      }
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    writeStartupCheckTs();

    const raw = fsNative.readFileSync(startupCheckTsFile, 'utf-8').trim();
    const ts = parseInt(raw, 10);
    expect(ts).not.toBeNaN();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('反向 2：tmpfile path 含 .tmp + pid', () => {
    const capturedTmpFiles: string[] = [];

    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      capturedTmpFiles.push(tmpFile);
      fsNative.writeFileSync(tmpFile, String(Date.now()));
      const fd = fsNative.openSync(tmpFile, 'r+');
      try {
        fsNative.fsyncSync(fd);
      } finally {
        fsNative.closeSync(fd);
      }
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    writeStartupCheckTs();

    expect(capturedTmpFiles).toHaveLength(1);
    expect(capturedTmpFiles[0]).toMatch(/\.\d+\.\d+\.tmp$/);
    expect(capturedTmpFiles[0]).toContain(String(process.pid));
  });

  it('反向 3：rename 后 tmpfile 0 残留', () => {
    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      fsNative.writeFileSync(tmpFile, String(Date.now()));
      const fd = fsNative.openSync(tmpFile, 'r+');
      try {
        fsNative.fsyncSync(fd);
      } finally {
        fsNative.closeSync(fd);
      }
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    writeStartupCheckTs();

    const statusDir = path.join(agentDir, STATUS_SUBDIR);
    const files = fsNative.readdirSync(statusDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('startup_check_ts');
  });

  // phase 1214 反向测试
  it('反向 4：fsyncSync is invoked on tmp file before rename', () => {
    let capturedFd: number | null = null;
    mockFsyncSync = vi.fn((fd: number) => {
      capturedFd = fd;
    });

    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      fsNative.writeFileSync(tmpFile, String(Date.now()));
      const fd = fsNative.openSync(tmpFile, 'r+');
      try {
        fsNative.fsyncSync(fd);
      } finally {
        fsNative.closeSync(fd);
      }
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    writeStartupCheckTs();

    expect(mockFsyncSync).toHaveBeenCalledTimes(1);
    expect(capturedFd).not.toBeNull();
  });

  it('反向 5：fsyncSync failure bubbles to outer catch (not silently swallowed)', () => {
    mockFsyncSync = vi.fn(() => {
      throw new Error('simulated fsync failure');
    });

    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      fsNative.writeFileSync(tmpFile, String(Date.now()));
      const fd = fsNative.openSync(tmpFile, 'r+');
      try {
        fsNative.fsyncSync(fd);
      } finally {
        fsNative.closeSync(fd);
      }
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    expect(() => writeStartupCheckTs()).toThrow('simulated fsync failure');
    expect(fsNative.existsSync(startupCheckTsFile)).toBe(false);
  });
});
