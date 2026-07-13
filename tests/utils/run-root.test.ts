import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { getRunRoot, getRunSubDir, getHostTmpDir } from './run-root.js';

describe('run-root utils', () => {
  it('getRunRoot returns CHESTNUT_RUN_ROOT env var', () => {
    const runRoot = getRunRoot();
    expect(runRoot).toBeDefined();
    expect(runRoot).toBe(process.env.CHESTNUT_RUN_ROOT);
  });

  it('getRunSubDir returns a child of run root', () => {
    const runRoot = getRunRoot();
    const subDir = getRunSubDir('claws');
    expect(subDir).toBeDefined();
    expect(subDir).toContain(runRoot!);
    expect(subDir).toContain('claws');
  });

  it('getHostTmpDir returns a real OS tmpdir path', () => {
    const hostTmp = getHostTmpDir();
    expect(hostTmp).toBeDefined();
    // 在 TMPDIR 被重定向的测试 invocation 中，getHostTmpDir 应不同于当前 os.tmpdir()
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    expect(hostTmp).not.toBe(os.tmpdir());
  });

  it('TMPDIR is redirected to run root', () => {
    const runRoot = getRunRoot();
    expect(process.env.TMPDIR).toBe(runRoot);
    expect(process.env.TMP).toBe(runRoot);
    expect(process.env.TEMP).toBe(runRoot);
  });
});
