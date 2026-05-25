/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 */

import { NodeFileSystem } from '../fs/node-fs.js';
import { ProcessManager } from './index.js';
import { getClawforumRoot, getNamedSubrootDir, getClawDir } from '../config/index.js';
import type { AuditLog } from '../audit/index.js';

import { MOTION_CLAW_ID } from '../../constants.js';

export function createAgentProcessManager(audit: AuditLog): ProcessManager {
  const baseDir = getClawforumRoot();
  const fs = new NodeFileSystem({ baseDir });
  const resolveAgentDir = (id: string) =>
    id === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(id);
  return new ProcessManager(fs, baseDir, audit, resolveAgentDir);
}
