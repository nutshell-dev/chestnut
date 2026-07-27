/**
 * Phase 1203 Step D: watchdog ownership authority ratchet scanners。
 * 每条 scanner 为纯函数、在 ratchet 测试中带反向 fixture。
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RATCHET_PATHS = {
  repoRoot: path.resolve(HERE, '..', '..'),
  scannerHelperFile: path.resolve(HERE, 'watchdog-ownership-scanners.ts'),
} as const;

function matchingLines(text: string, pattern: RegExp, file: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, i }) => `${file}:${i + 1}:${line.trim()}`);
}

const LOCK_PATTERN =
  /lock-protocol|watchdog-lock|tryAcquireLock|releaseLock|ensurePromise|tryAcquireClaim|releaseClaim|ENSURE_LOCK_/;

/** 规则 1：禁锁 —— watchdog 域 0 锁协议/单飞/legacy claim 引用 */
export function findForbiddenLockReferences(text: string, file = '<text>'): string[] {
  return matchingLines(text, LOCK_PATTERN, file);
}

/** 规则 2：禁 PID writer 回归 —— `writeWatchdogPid` 定义/调用均为 0（zero universe） */
export function findPidWriterReferences(text: string, file = '<text>'): string[] {
  return matchingLines(text, /\bwriteWatchdogPid\b/, file);
}

/** 规则 3：禁入口旁路 —— `runWatchdogLoop` import/调用引用（定义行与注释除外） */
export function findLoopEntryReferences(text: string, file = '<text>'): string[] {
  return matchingLines(text, /import[^\n;]*\brunWatchdogLoop\b|\brunWatchdogLoop\s*\(/, file).filter(
    (hit) => !/function\s+runWatchdogLoop/.test(hit),
  );
}
