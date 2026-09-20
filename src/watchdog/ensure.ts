/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (M#1)
 *
 * Phase 1203 Step C: caller-side 锁/单飞/legacy lock migration 全部删除。
 * 单实例 authority 在真正执行主 loop 的子进程（目录 rename commit、M#4 磁盘即权威）；
 * caller 只做 alive fast-path + spawn candidate，成功条件是出现合法且 alive 的
 * `watchdog/active/owner.json`，不要求自己的 child 获胜。
 */
import type { FileSystem } from '../foundation/fs/index.js';
import { isWatchdogAlive } from './watchdog-pid.js';
import { spawnWatchdogCandidate } from './spawn.js';
import { createWatchdogActionAudit } from './audit-wiring.js';

/**
 * 唯一入口、所有 caller 必经此。
 * - foreign workspace → throw（caller 决定如何 surface）
 * - 已有合法 alive active owner → no-op（alive fast-path 仅为优化，非正确性条件）
 * - 未活 → spawn candidate；子进程在副作用前 commit ownership，
 *   并发 caller 可 spawn 多个短命 candidate，目录 rename 恰好一个 winner。
 */
export async function ensureWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
): Promise<void> {
  // Phase 1878 Step I: writer 生命周期归 action/进程——CLI action 已安装则复用
  // （非 owner handle、dispose no-op）；未安装则本调用 scoped own + 终态 dispose
  // （旧 ensureAuditWired lazy 悬挂语义退役）。
  const actionAudit = createWatchdogActionAudit(fsFactory);
  try {
    if (isWatchdogAlive(fsFactory)) return; // throws WatchdogPidForeignWorkspaceError if foreign
    await spawnWatchdogCandidate(fsFactory);
  } finally {
    actionAudit.dispose();
  }
}
