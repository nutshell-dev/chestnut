import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

/**
 * Phase 1397 invariant — M-2 行为契约 ratchet
 *
 * spawn.ts 把"already running"冲突显式为 LockConflictError 后，调用方必须用
 * `instanceof LockConflictError` 判别，禁止回退到 `err.message.includes('already running')`
 * 这类字符串嗅探（M#9「不可消除的耦合应显式表达，优先表达为让编译器检查」）。
 *
 * grep 必须 0 hit。重新引入字符串嗅探 → 此测试 fail。
 *
 * 例外：cli/index.ts 和 watchdog-cli.ts 的 console.warn 文案输出"already running"
 * 给用户看，不是 catch 路径的错误判等，不在 ratchet 范围内（grep 模式只匹配
 * `.includes('already running')` 或 `.message.match(...already running...)` 等
 * 错误嗅探形态）。
 */
describe('phase 1397 M-2 invariant: no error-message string-sniff for "already running"', () => {
  it('src 内 0 hit `message.includes("already running")` / `message.match(...already running...)`', () => {
    let out = '';
    try {
      out = execSync(
        `grep -rnE "message\\.(includes|match)\\([^)]*already running" src/`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ).trim();
    } catch (err: any) {
      // grep exit 1 = 0 hit (desired)
      if (err.status === 1) out = '';
      else throw err;
    }
    expect(out).toBe('');
  });

  it('catch 路径必走 `instanceof LockConflictError` (≥ 2 hit: daemon + watchdog)', () => {
    const out = execSync(
      `grep -rn "instanceof LockConflictError" src/`,
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
