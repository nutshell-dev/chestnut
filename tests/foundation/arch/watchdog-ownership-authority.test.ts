/**
 * Phase 1203 Step D: watchdog 目录 ownership authority ratchet。
 *
 * 单一职责：单实例 authority 只在子进程目录 rename commit。
 * - 规则 1 禁锁：src/watchdog 0 锁协议/单飞/legacy claim 引用；
 * - 规则 2 禁 PID overwrite：`writeWatchdogPid(` 调用点唯一（loop 内 legacy mirror）；
 * - 规则 3 禁入口旁路：`runWatchdogLoop` 引用仅在定义文件 / entry shim / CLI daemon 装配。
 *
 * scanner 在 tests/helpers/watchdog-ownership-scanners.ts；每条带反向 fixture。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import {
  RATCHET_PATHS,
  findForbiddenLockReferences,
  findPidWriteCallSites,
  findLoopEntryReferences,
} from '../../helpers/watchdog-ownership-scanners.js';

const { repoRoot } = RATCHET_PATHS;
const SELF = path.resolve(repoRoot, 'tests', 'foundation', 'arch', 'watchdog-ownership-authority.test.ts');

function grepSrc(pattern: string): string[] {
  const out = execSync(
    `grep -rnE "${pattern}" ${path.join(repoRoot, 'src')} --include='*.ts' || true`,
    { encoding: 'utf8' },
  ).trim();
  return out === '' ? [] : out.split('\n');
}

function fileOf(line: string): string {
  return path.resolve(repoRoot, line.split(':')[0]);
}

describe('Phase 1203: watchdog ownership authority ratchet', () => {
  it('规则 1：src/watchdog 禁锁引用为 0', () => {
    const lines = grepSrc(
      'lock-protocol|watchdog-lock|tryAcquireLock|releaseLock|ensurePromise|tryAcquireClaim|releaseClaim|ENSURE_LOCK_',
    ).filter((l) => fileOf(l).includes(`${path.sep}src${path.sep}watchdog${path.sep}`));
    expect(lines).toEqual([]);
  });

  it('规则 1 反向 fixture：锁引用会被 scanner 检出', () => {
    const bad = [
      "import { tryAcquireClaim, releaseClaim } from '../foundation/fs/lock-protocol.js';",
      'let ensurePromise = null;',
      "audit.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT);",
    ].join('\n');
    expect(findForbiddenLockReferences(bad)).toHaveLength(3);
    expect(findForbiddenLockReferences('const ok = 1;')).toHaveLength(0);
  });

  it('规则 2：writeWatchdogPid 调用点唯一（watchdog.ts loop legacy mirror）', () => {
    const lines = grepSrc('writeWatchdogPid\\s*\\(')
      .filter((l) => !/function\s+writeWatchdogPid/.test(l)) // 定义行
      .filter((l) => fileOf(l) !== SELF);
    const files = new Set(lines.map(fileOf));
    expect([...files]).toEqual([path.join(repoRoot, 'src', 'watchdog', 'watchdog.ts')]);
  });

  it('规则 2 反向 fixture：第二调用点会被检出', () => {
    const bad = "writeWatchdogPid(fsFactory, process.pid);";
    expect(findPidWriteCallSites(bad)).toHaveLength(1);
    const def = 'export function writeWatchdogPid(fsFactory: X, pid: number): void {';
    expect(findPidWriteCallSites(def)).toHaveLength(0);
  });

  it('规则 3：runWatchdogLoop 引用仅在定义/entry/CLI 装配三处', () => {
    const allowed = new Set([
      path.join(repoRoot, 'src', 'watchdog', 'watchdog.ts'),
      path.join(repoRoot, 'src', 'watchdog-entry.ts'),
      path.join(repoRoot, 'src', 'cli', 'index.ts'),
    ]);
    const lines = grepSrc('import[^\n;]*runWatchdogLoop|runWatchdogLoop\s*\(').filter((l) => fileOf(l) !== SELF);
    const offenders = lines.filter((l) => !allowed.has(fileOf(l)));
    expect(offenders).toEqual([]);
  });

  it('规则 3 反向 fixture：新入口旁路会被检出', () => {
    const bad = "import { runWatchdogLoop } from '../watchdog/watchdog.js';";
    expect(findLoopEntryReferences(bad)).toHaveLength(1);
    const def = 'export async function runWatchdogLoop(fsFactory: X): Promise<void> {';
    expect(findLoopEntryReferences(def)).toHaveLength(0);
  });
});
