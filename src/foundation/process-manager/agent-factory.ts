/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation across daemon / motion / watchdog /
 * start / status / claw / stop / index.
 *
 * phase 694: 撤 resolveAgentDir 注入（phase 535 引入）；PM ctor 改 (fs, audit)
 * 两参、caller 调 PM API 时 take 已 resolved daemonDir、不再注入 resolver。
 */

import { ProcessManager } from './manager.js';
import { getChestnutRoot } from '../../core/claw-topology/claw-instance-paths.js';
import type { AuditLog } from '../audit/index.js';
import type { FileSystem } from '../fs/index.js';

export function createAgentProcessManager(
  deps: {
    fsFactory: (baseDir: string) => FileSystem;
  },
  audit: AuditLog,
): ProcessManager {
  const baseDir = getChestnutRoot();
  const fs = deps.fsFactory(baseDir);
  return new ProcessManager(fs, audit);
}
