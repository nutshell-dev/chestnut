/**
 * @module L5.Runtime
 * ClawRuntime — 核心运行时编排器。
 */

export { ClawRuntime } from './runtime.js';
export type { ClawRuntimeOptions, RuntimeDependencies, StreamCallbacks } from './runtime.js';
export { createRuntime, buildMotionSystemPrompt } from './create-runtime.js';
export type { CreateRuntimeOptions } from './create-runtime.js';
export { Heartbeat, createHeartbeat } from './heartbeat.js';
export type { HeartbeatOptions } from './heartbeat.js';
export { summarizeLastExit, readLastExitEvent } from './last-exit-summary.js';
export type {
  AuditPort,
  SnapshotPort,
  SessionStorePort,
  InboxPort,
  OutboxPort,
  ToolRegistryPort,
  ToolExecutorPort,
  ContextInjectorPort,
  ExecContextPort,
  ContractManagerPort,
  TaskLifecyclePort,
  SkillRegistryPort,
} from './runtime-ports.js';
