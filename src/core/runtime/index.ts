/**
 * @module L5.Runtime
 * Runtime — 核心运行时编排器。
 */

export { Runtime } from './runtime.js';
export type { RuntimeOptions, RuntimeDependencies, StreamCallbacks } from './runtime.js';
export { createRuntime, buildMotionSystemPrompt } from './create-runtime.js';
export type { CreateRuntimeOptions } from './create-runtime.js';
export { Heartbeat, createHeartbeat } from './heartbeat.js';
export type { HeartbeatOptions } from './heartbeat.js';
export { summarizeLastExit, readLastExitEvent } from './last-exit-summary.js';

