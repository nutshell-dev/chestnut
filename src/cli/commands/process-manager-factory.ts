/**
 * ProcessManager factory — unified construction for all CLI commands
 *
 * Eliminates repeated baseDir calculation + dirResolver assembly
 * across daemon / motion / watchdog / start / status / claw / stop / index.
 */

import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { ProcessManager } from '../../foundation/process-manager/index.js';
import { getClawforumRoot, resolveAgentDir } from '../config.js';
import type { Audit } from '../../foundation/audit/index.js';

export function createAgentProcessManager(audit: Audit): ProcessManager {
  const baseDir = getClawforumRoot();
  const fs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  return new ProcessManager(fs, baseDir, audit, resolveAgentDir);
}
