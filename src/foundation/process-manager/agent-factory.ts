/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 */

import { ProcessManager } from './manager.js';
import { getChestnutRoot, getNamedSubrootDir, getClawDir } from '../config/index.js';
import type { AuditLog } from '../audit/index.js';
import type { FileSystem } from '../fs/types.js';

/**
 * phase 520: deps.motionClawId 由 caller 注入（foundation 不再 import MOTION_CLAW_ID、owner=core/claw-topology）。
 * agent-factory 仍持有 motion-vs-claw dir 分支逻辑（参数化、不 import 字面）。
 */
export function createAgentProcessManager(
  deps: { fsFactory: (baseDir: string) => FileSystem; motionClawId: string },
  audit: AuditLog,
): ProcessManager {
  const baseDir = getChestnutRoot();
  const fs = deps.fsFactory(baseDir);
  const resolveAgentDir = (id: string) =>
    id === deps.motionClawId ? getNamedSubrootDir('motion') : getClawDir(id);
  return new ProcessManager(fs, baseDir, audit, resolveAgentDir);
}
