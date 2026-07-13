import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHostTmpDir } from './run-root.js';

describe('run-root teardown integration', () => {
  it('spawn vitest → run root created → vitest exits → run root cleaned up', () => {
    const hostTmp = getHostTmpDir();
    const beforeDirs = fs.readdirSync(hostTmp)
      .filter(d => d.startsWith('chestnut-run-'));

    // 跑一个最小测试文件，触发 globalSetup + teardown
    const testFile = path.join(__dirname, 'run-root.test.ts');
    const result = spawnSync('npx', ['vitest', 'run', testFile, '--no-color'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, CHESTNUT_KEEP_TEST_TMP: undefined },
      timeout: 120000,
      encoding: 'utf-8',
    });

    // 不管测试本身 pass/fail，teardown 应该清理 run root
    const afterDirs = fs.readdirSync(hostTmp)
      .filter(d => d.startsWith('chestnut-run-'));

    const newDirs = afterDirs.filter(d => !beforeDirs.includes(d));
    expect(newDirs).toHaveLength(0,
      `Teardown failed: run root(s) left behind: ${newDirs.join(', ')}\nspawn output:\n${result.stdout}\n${result.stderr}`);
  });

  it('CHESTNUT_KEEP_TEST_TMP=1 preserves run root', () => {
    const hostTmp = getHostTmpDir();
    const testFile = path.join(__dirname, 'run-root.test.ts');
    const result = spawnSync('npx', ['vitest', 'run', testFile, '--no-color'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, CHESTNUT_KEEP_TEST_TMP: '1' },
      timeout: 120000,
      encoding: 'utf-8',
    });

    // KEEP_TEST_TMP=1 时应保留 run root
    const afterDirs = fs.readdirSync(hostTmp)
      .filter(d => d.startsWith('chestnut-run-'));
    expect(afterDirs.length).toBeGreaterThan(0,
      `Expected run root to be preserved with CHESTNUT_KEEP_TEST_TMP=1\nspawn output:\n${result.stdout}\n${result.stderr}`);

    // 清理我们自己创建的
    for (const d of afterDirs) {
      const fullPath = path.join(hostTmp, d);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // 忽略并发/过期目录
      }
    }
  });
});
