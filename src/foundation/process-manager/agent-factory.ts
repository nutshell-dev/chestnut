/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 */

import { ProcessManager } from './manager.js';
import { getClawforumRoot, getNamedSubrootDir, getClawDir } from '../config/index.js';
import type { AuditLog } from '../audit/index.js';
import type { FileSystem } from '../fs/types.js';

import { MOTION_CLAW_ID } from '../../constants.js';

export function createAgentProcessManager(deps: { fsFactory: (baseDir: string) => FileSystem }, audit: AuditLog): ProcessManager {
  const baseDir = getClawforumRoot();
  const fs = deps.fsFactory(baseDir);
  const resolveAgentDir = (id: string) =>
    id === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(id);
  return new ProcessManager(fs, baseDir, audit, resolveAgentDir);
}
