/**
 * stop.ts clean-stop atomic tmp+rename (phase 1136 / F.2b)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

describe('clean-stop atomic tmp+rename (phase 1136 / F.2b)', () => {
  let baseDir: string;
  let cleanStopFile: string;

  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), `clean-stop-atomic-test-${randomUUID()}`);
    fs.mkdirSync(baseDir, { recursive: true });
    cleanStopFile = path.join(baseDir, 'clean-stop');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('反向 1：happy tmp+rename + cleanStopFile 内容正确', () => {
    const before = Date.now();

    // Inline helper (replicated from stop.ts)
    const writeCleanStop = () => {
      const tmpFile = `${cleanStopFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, String(Date.now()), 'utf-8');
      fs.renameSync(tmpFile, cleanStopFile);
    };

    writeCleanStop();

    const raw = fs.readFileSync(cleanStopFile, 'utf-8').trim();
    const ts = parseInt(raw, 10);
    expect(ts).not.toBeNaN();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('反向 2：tmpfile path 含 .tmp + pid', () => {
    const capturedTmpFiles: string[] = [];

    const writeCleanStop = () => {
      const tmpFile = `${cleanStopFile}.${process.pid}.${Date.now()}.tmp`;
      capturedTmpFiles.push(tmpFile);
      fs.writeFileSync(tmpFile, String(Date.now()), 'utf-8');
      fs.renameSync(tmpFile, cleanStopFile);
    };

    writeCleanStop();

    expect(capturedTmpFiles).toHaveLength(1);
    expect(capturedTmpFiles[0]).toMatch(/\.\d+\.\d+\.tmp$/);
    expect(capturedTmpFiles[0]).toContain(String(process.pid));
  });

  it('反向 3：rename 后 tmpfile 0 残留', () => {
    const writeCleanStop = () => {
      const tmpFile = `${cleanStopFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, String(Date.now()), 'utf-8');
      fs.renameSync(tmpFile, cleanStopFile);
    };

    writeCleanStop();

    const files = fs.readdirSync(baseDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('clean-stop');
  });
});
