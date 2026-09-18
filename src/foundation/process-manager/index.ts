// phase 474: audit-events barrel re-export
export { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';

/**
 * @module L2a.ProcessManager
 * ProcessManager module (L2a 通用基础设施)
 *
 * 进程生命周期管理。spawn、stop、存活检查。
 * 依赖：ProcessExec、FileSystem、ProcessManagerAuditSink（AuditLog 最小结构面）、NodeUtils
 *
 * phase 694: 撤 ClawId / CLAWS_DIR 业务依赖、API take daemonDir: DaemonDir brand。
 * Phase 1204 Step E: generation directory 是唯一权威；legacy lock/pidfile API 已删除。
 */

export { ProcessManager } from './manager.js';
// phase 1773: LivenessResult 展示/audit 纯渲染投影（决策必须走 discriminant）
export { describeLiveness } from './alive.js';
export { ProcessSpawnConflictError } from './types.js';
export type { ProcessSpawnConflictReason } from './types.js';
// phase 1852 Step B: barrel 一次性开放最小失败协议（真实 caller 可命名；
// src 跨模块禁止 deep import types.js —— 反向锁见 arch/process-manager-failure-surface）
export { ProcessGenerationStateError, ProcessWinnerConvergenceError } from './types.js';
export type { ProcessWinnerConvergenceReason, EnsureRunningOutcome } from './types.js';
// Phase 1464 Step B: Daemon spawn specification capability 消费通用 SpawnOptions type
export type { SpawnOptions } from './types.js';
export type { StopProcessOutcome, StopFailureStage } from './types.js';
// phase 1771: readiness owner typed union（禁 boolean 压平）
export type { ReadinessResult, ReadinessNotReadyReason } from './types.js';
// phase 1773: liveness owner typed union（probe 异常不伪装 alive）
export type { LivenessResult } from './types.js';
export type { DaemonDir } from './types.js';
export { makeDaemonDir } from './types.js';
// phase 1864 Step D（CT-D4）：PM own brand 构造 adapter（消费已解析位置事实）。
export { makeDaemonDirFromLocation } from './daemon-dir-location.js';
export type { DaemonDirLocation } from './daemon-dir-location.js';
export { DAEMON_SHUTDOWN_GRACE_MS } from './constants.js';
export { createProcessManagerForCLI } from './factories.js';
// phase 1423 F5: agent-factory (daemon-scoped) sister to factories (CLI-scoped)
// 同 phase 1416 F1 form 复用、跨模块 caller (daemon/) 走 barrel
// assembly/assemble.ts 装配根 by-design 保留 deep import (lint allowlist)。
export { createAgentProcessManager } from './agent-factory.js';
export { STATUS_SUBDIR } from './paths.js';
export { signalCleanStop, clearCleanStop } from './signal-clean-stop.js';

export { getActiveDir, PID_FILE, PROCESS_GENERATION_ENV } from './generation.js';
export type { ProcessGenerationRecord } from './generation.js';
export { PROCESS_STOP_POLL_INTERVAL_MS, SIGKILL_DEAD_VERIFY_GRACE_MS } from './constants.js';
