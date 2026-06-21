/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 *
 * phase 535: caller pre-bakes resolveAgentDir (motion-vs-claw dir mapping is chestnut topology fact、
 * 归 core/claw-topology 或 caller 业务层；foundation 0 motion 知识).
 */

import { ProcessManager } from './manager.js';
import { getChestnutRoot } from '../config/index.js';
import type { AuditLog } from '../audit/index.js';
import type { FileSystem } from '../fs/index.js';

export function createAgentProcessManager(
  deps: {
    fsFactory: (baseDir: string) => FileSystem;
    /** caller-pre-baked clawId → fs dir resolver (knows motion-vs-claw mapping) */
    resolveAgentDir: (id: string) => string;
  },
  audit: AuditLog,
): ProcessManager {
  const baseDir = getChestnutRoot();
  const fs = deps.fsFactory(baseDir);
  return new ProcessManager(fs, baseDir, audit, deps.resolveAgentDir);
}
