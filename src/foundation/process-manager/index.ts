// phase 474: audit-events barrel re-export
export { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';

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
export { createProcessManagerForCLI } from './factories.js';
// phase 1423 F5: agent-factory (daemon-scoped) sister to factories (CLI-scoped)
// 同 phase 1416 F1 form 复用、跨模块 caller (daemon/) 走 barrel
// assembly/assemble.ts 装配根 by-design 保留 deep import (lint allowlist)。
export { createAgentProcessManager } from './agent-factory.js';
export { STATUS_SUBDIR } from './paths.js';
export { signalCleanStop } from './signal-clean-stop.js';
