
/**
 * @module L2.ProcessManager.SignalCleanStop
 * Explicit clean-stop flag API (phase 1373 sub-3).
 *
 * Provides a programmatic way to signal an intentional daemon stop,
 * so the next boot can detect graceful shutdown and skip backoff state.
 */

import { type ChestnutRoot } from '../../assembly/install-paths.js';
import * as path from 'path';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';

export async function signalCleanStop(
  fs: FileSystem,
  chestnutRoot: ChestnutRoot,
  clawName: string,
  audit?: AuditLog,
): Promise<void> {
  const flagPath = path.join(chestnutRoot, clawName, 'clean-stop');
  await fs.writeAtomic(flagPath, '');
  audit?.write(PROCESS_MANAGER_AUDIT_EVENTS.CLEAN_STOP_SIGNALED, `claw=${clawName}`);
}
