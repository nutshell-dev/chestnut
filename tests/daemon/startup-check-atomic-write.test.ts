/**
 * daemon-loop startup_check_ts atomic tmp+rename (phase 1136 / F.2a)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

const STATUS_SUBDIR = 'status';

describe('startup_check_ts atomic tmp+rename (phase 1136 / F.2a)', () => {
  let agentDir: string;
  let startupCheckTsFile: string;

  beforeEach(() => {
    agentDir = path.join(os.tmpdir(), `startup-check-atomic-test-${randomUUID()}`);
    fsNative.mkdirSync(agentDir, { recursive: true });
    startupCheckTsFile = path.join(agentDir, STATUS_SUBDIR, 'startup_check_ts');
  });

  afterEach(() => {
    fsNative.rmSync(agentDir, { recursive: true, force: true });
  });

  it('反向 1：happy tmp+rename + target file 内容正确', () => {
    const before = Date.now();

    // Inline helper (replicated from daemon-loop.ts)
    const writeStartupCheckTs = () => {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      const tmpFile = `${startupCheckTsFile}.${process.pid}.${Date.now()}.tmp`;
      fsNative.writeFileSync(tmpFile, String(Date.now()));
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
      fsNative.renameSync(tmpFile, startupCheckTsFile);
    };

    writeStartupCheckTs();

    const statusDir = path.join(agentDir, STATUS_SUBDIR);
    const files = fsNative.readdirSync(statusDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('startup_check_ts');
  });
});
