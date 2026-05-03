/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 */

import { NodeFileSystem } from '../fs/node-fs.js';
import { ProcessManager } from './index.js';
import { getClawforumRoot, resolveAgentDir } from '../config/index.js';
import type { AuditLog } from '../audit/index.js';

export function createAgentProcessManager(audit: AuditLog): ProcessManager {
  const baseDir = getClawforumRoot();
  const fs = new NodeFileSystem({ baseDir });
  return new ProcessManager(fs, baseDir, audit, resolveAgentDir);
}
