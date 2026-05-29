import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolveDaemonEntry, resolveWatchdogEntry } from '../../src/foundation/paths.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';

// daemon-entry.js / watchdog-entry.js 字符串字面量唯一权威 = foundation/paths.ts
// 的 resolveDaemonEntry / resolveWatchdogEntry。其他 src/ 文件不得持有该字面量
// （历史散落 8 caller × 6 种写法 → phase 1436 归一）。
//
// Allowlist 显式列：
// - paths.ts：单一权威 helper 自身
// - process-manager/types.ts：JSDoc 注释例（args 形态示例）
// - cli/commands/stop.ts：pgrep 子串匹配 pattern（非路径解析、目标进程命令行子串）
// - watchdog/orphan-sweep.ts：注释行（"扫 watchdog-entry.js 进程"）
const ALLOWLIST_DAEMON = [
  'src/cli/commands/stop.ts',
  'src/foundation/paths.ts',
  'src/foundation/process-manager/types.ts',
];
const ALLOWLIST_WATCHDOG = [
  'src/foundation/paths.ts',
  'src/watchdog/orphan-sweep.ts',
];

function grepLiteral(literal: string): string[] {
  // -F 字面量、-l 仅文件名、-r 递归、|| true 让 0 hit 不报 exit code
  const out = execSync(
    `grep -rlF "${literal}" src 2>/dev/null || true`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean).sort();
}

describe('foundation/paths.ts: entry-resolver single source', () => {
  it('daemon-entry.js literal only in allowlist files', () => {
    const hits = grepLiteral('daemon-entry.js');
    const unauthorized = hits.filter((f) => !ALLOWLIST_DAEMON.includes(f));
    expect(
      unauthorized,
      `daemon-entry.js literal outside allowlist: ${unauthorized.join(', ')}`,
    ).toEqual([]);
  });

  it('watchdog-entry.js literal only in allowlist files', () => {
    const hits = grepLiteral('watchdog-entry.js');
    const unauthorized = hits.filter((f) => !ALLOWLIST_WATCHDOG.includes(f));
    expect(
      unauthorized,
      `watchdog-entry.js literal outside allowlist: ${unauthorized.join(', ')}`,
    ).toEqual([]);
  });

  it('resolveDaemonEntry returns bundled path when bundled exists', () => {
    const fakeFs = {
      existsSync: (p: string) => p.endsWith('/foundation/daemon-entry.js'),
    } as unknown as FileSystem;
    const result = resolveDaemonEntry(fakeFs);
    expect(result).toMatch(/foundation\/daemon-entry\.js$/);
  });

  it('resolveWatchdogEntry returns bundled path when bundled exists', () => {
    const fakeFs = {
      existsSync: (p: string) => p.endsWith('/foundation/watchdog-entry.js'),
    } as unknown as FileSystem;
    const result = resolveWatchdogEntry(fakeFs);
    expect(result).toMatch(/foundation\/watchdog-entry\.js$/);
  });

  it('resolver falls back to one-level-up when bundled missing', () => {
    const fakeFs = { existsSync: () => false } as unknown as FileSystem;
    const result = resolveDaemonEntry(fakeFs);
    // 应在 src/ 根（PATHS_THIS_DIR=src/foundation/ 上溯一级）
    expect(result).toMatch(/\/src\/daemon-entry\.js$/);
  });

  it('resolveDaemonEntry imported by all 7 cli/commands + 1 watchdog caller', () => {
    const out = execSync(
      `grep -rlF "resolveDaemonEntry" src/cli/commands src/watchdog 2>/dev/null || true`,
      { encoding: 'utf8' },
    );
    const callers = out.split('\n').filter(Boolean).sort();
    const expected = [
      'src/cli/commands/claw-chat.ts',
      'src/cli/commands/claw-daemon.ts',
      'src/cli/commands/motion-daemon.ts',
      'src/cli/commands/motion.ts',
      'src/cli/commands/start.ts',
      'src/cli/commands/status.ts',
      'src/cli/commands/stop.ts',
      'src/watchdog/watchdog.ts',
    ];
    expect(callers).toEqual(expected);
  });
});
