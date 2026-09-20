
/**
 * @module L2a.ProcessManager.SignalCleanStop
 * Explicit clean-stop flag API (phase 1373 sub-3).
 *
 * Provides a programmatic way to signal an intentional daemon stop,
 * so the next boot can detect graceful shutdown and skip backoff state.
 *
 * phase 694: 撤 chestnutRoot + clawName 形态、改 take daemonDir 直接、
 * PM 不再知 chestnut 拓扑（caller 经 L4 ClawTopology resolveClawDaemonDir 算）。
 */

import * as path from 'path';
import type { DaemonDir } from './types.js';
import type { FileSystem } from '../fs/index.js';
import type { ProcessManagerAuditSink } from './audit-sink.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';

export async function signalCleanStop(
  fs: FileSystem,
  daemonDir: DaemonDir,
  audit?: ProcessManagerAuditSink,
): Promise<void> {
  const flagPath = path.join(daemonDir, 'clean-stop');
  await fs.writeAtomic(flagPath, '');
  audit?.write(PROCESS_MANAGER_AUDIT_EVENTS.CLEAN_STOP_SIGNALED, `daemon_dir=${daemonDir}`);
}

/**
 * phase 1124: 清除 clean-stop marker（signalCleanStop 的 mirror API）。
 * 用于 stop 失败路径，防止残留 marker 导致后续真崩溃被误判为 active_user_stopped。
 */
export async function clearCleanStop(
  fs: FileSystem,
  daemonDir: DaemonDir,
  audit?: ProcessManagerAuditSink,
): Promise<void> {
  const flagPath = path.join(daemonDir, 'clean-stop');
  await fs.delete(flagPath);
  audit?.write(PROCESS_MANAGER_AUDIT_EVENTS.CLEAN_STOP_CLEARED, `daemon_dir=${daemonDir}`);
}

/**
 * Phase 1878 Step E（watchdog-clean-stop-storage-bypass）：clean-stop 意图稳定查询。
 *
 * marker 路径知识与演化收归 PM owner；caller（Watchdog executor-recovery）
 * 不再直读 `'clean-stop'` 文件字面量。查询语义 1:1 = 存在即 true（现状语义）。
 * 写端一致性：signalCleanStop 写 `<daemonDir>/clean-stop`；CLI stop 的 per-claw
 * marker 写 `<clawDir>/clean-stop`——local claw 的 daemonDir 即 clawDir
 * （makeDaemonDirFromLocation 恒等），同一路径语义。
 */
export function hasCleanStopIntent(fs: FileSystem, daemonDir: DaemonDir): boolean {
  const flagPath = path.join(daemonDir, 'clean-stop');
  return fs.existsSync(flagPath);
}
