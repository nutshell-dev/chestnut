/**
 * @module L2.ProcessManager
 * ProcessManager module (L2)
 *
 * 进程生命周期管理。spawn、stop、存活检查、PID 文件管理。
 * 依赖：FileSystem
 */

export { ProcessManager, LockConflictError } from './manager.js';
export type { SpawnOptions } from './manager.js';
export { ProcessListUnavailable } from './errors.js';
export { DAEMON_SHUTDOWN_GRACE_MS } from './manager.js';
export { createProcessManagerForCLI, createDirContext } from './factories.js';
export { STATUS_SUBDIR, getStatusDir, getPidFile, getLockFile, getReadyFile, ensureStatusDir } from './paths.js';
