/**
 * @module L5.Runtime
 * phase 488: barrel re-export RELOAD_LLM_CONFIG_MESSAGE_TYPE for cli/config
 * Runtime — 核心运行时编排器。
 */

export { Runtime } from './runtime.js';
export type { RuntimeOptions, RuntimeDependencies, StreamCallbacks, IRuntimeLifecycle, IRuntimeDaemon, TurnResult } from './types.js';
export { createRuntime, buildMotionSystemPrompt } from './create-runtime.js';
export type { CreateRuntimeOptions } from './create-runtime.js';
// phase 1406: Heartbeat 迁出 → src/core/heartbeat/（独立 L5 服务）。
// 此处保留 re-export 桥（backward compat）；新代码请直接 import from '../heartbeat/index.js'。
export { Heartbeat, createHeartbeat, HEARTBEAT_AUDIT_EVENTS } from '../heartbeat/index.js';
export type { HeartbeatOptions } from '../heartbeat/index.js';
export { summarizeLastExit, readLastExitEvent } from './last-exit-summary.js';

// phase 488: runtime-audit-events barrel re-export (cli/config caller)
export { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './runtime-audit-events.js';

