/**
 * Phase 1203 Step D: watchdog 目录 ownership authority ratchet。
 * Phase 1203 Step E: 规则 2 升级为 zero universe —— active 目录是唯一 owner 事实。
 * Phase 1203 Step F: fail-closed —— 测试进程内枚举/读取 src，不再 shell grep + `|| true`
 * （旧实现把 JS `\n` 拼进 grep -E 导致 "brackets not balanced"，错误被压成空结果假绿）。
 *
 * 单一职责：单实例 authority 只在子进程目录 rename commit。
 * - 规则 1 禁锁：src/watchdog 0 锁协议/单飞/legacy claim 引用；
 * - 规则 2 禁 PID writer 回归：`writeWatchdogPid` 定义/调用在 src 均为 0；
 * - 规则 3 禁入口旁路：`runWatchdogLoop` 引用仅在定义文件 / entry shim / CLI daemon 装配。
 *
 * scanner 在 tests/helpers/watchdog-ownership-scanners.ts；每条带反向 fixture。
 * 枚举/读取失败直接 throw 使测试失败，绝不返回空集合冒充 0 违规。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RATCHET_PATHS,
  findForbiddenLockReferences,
  findPidWriterReferences,
  findLoopEntryReferences,
} from '../../helpers/watchdog-ownership-scanners.js';

const { repoRoot } = RATCHET_PATHS;

/** 递归枚举 dir 下全部 .ts 文件（失败抛错，不静默） */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface SourceFile {
  file: string;
  text: string;
}

/** 读取真实 src universe；任一读取失败直接 throw（测试失败，不压成空集合） */
function loadSources(): SourceFile[] {
  const files = sourceFiles(path.join(repoRoot, 'src'));
  if (files.length === 0) {
    throw new Error('src universe enumeration returned 0 files — refusing to pass on empty universe');
  }
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

describe('Phase 1203: watchdog ownership authority ratchet', () => {
  it('规则 1：src/watchdog 禁锁引用为 0', () => {
    const hits = loadSources()
      .filter(({ file }) => file.includes(`${path.sep}watchdog${path.sep}`))
      .flatMap(({ file, text }) => findForbiddenLockReferences(text, file));
    expect(hits).toEqual([]);
  });

  it('规则 1 反向 fixture：锁引用会被 scanner 检出', () => {
    const bad = [
      "import { tryAcquireClaim, releaseClaim } from '../foundation/fs/lock-protocol.js';",
      'let ensurePromise = null;',
      'audit.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT);',
    ].join('\n');
    expect(findForbiddenLockReferences(bad)).toHaveLength(3);
    expect(findForbiddenLockReferences('const ok = 1;')).toHaveLength(0);
  });

  it('规则 2：writeWatchdogPid 定义/调用在 src 均为 0（zero universe）', () => {
    const hits = loadSources()
      .flatMap(({ file, text }) => findPidWriterReferences(text, file));
    expect(hits).toEqual([]);
  });

  it('规则 2 反向 fixture：定义或调用插入都会被检出', () => {
    expect(findPidWriterReferences('writeWatchdogPid(fsFactory, process.pid);')).toHaveLength(1);
    const def = 'export function writeWatchdogPid(fsFactory: X, pid: number): void {';
    expect(findPidWriterReferences(def)).toHaveLength(1);
    // 拼写相近的合法 legacy reader/cleanup 不误报
    expect(findPidWriterReferences('removeWatchdogPid(fsFactory);')).toHaveLength(0);
    expect(findPidWriterReferences('getWatchdogPid(fsFactory);')).toHaveLength(0);
  });

  it('规则 3：runWatchdogLoop 引用仅在定义/entry/CLI 装配三处', () => {
    const allowed = new Set([
      path.join(repoRoot, 'src', 'watchdog', 'watchdog.ts'),
      path.join(repoRoot, 'src', 'watchdog-entry.ts'),
      path.join(repoRoot, 'src', 'cli', 'index.ts'),
    ]);
    // 逐文件扫描，hit 携带传入的绝对路径 file，不解析冒号字符串
    const offenders = loadSources()
      .filter(({ file }) => !allowed.has(file))
      .flatMap(({ file, text }) => findLoopEntryReferences(text, file));
    expect(offenders).toEqual([]);
  });

  it('规则 3 反向 fixture：新入口旁路会被检出', () => {
    const bad = "import { runWatchdogLoop } from '../watchdog/watchdog.js';";
    expect(findLoopEntryReferences(bad)).toHaveLength(1);
    const def = 'export async function runWatchdogLoop(fsFactory: X): Promise<void> {';
    expect(findLoopEntryReferences(def)).toHaveLength(0);
  });
});
