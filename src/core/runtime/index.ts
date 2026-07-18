/**
 * @module L4.Runtime
 * phase 488: barrel re-export RELOAD_LLM_CONFIG_MESSAGE_TYPE for cli/config
 * Runtime — 核心运行时编排器。
 */

export { Runtime } from './runtime.js';
export type { RuntimeOptions, RuntimeDependencies, StreamCallbacks, IRuntimeLifecycle, IRuntimeDaemon, TurnResult } from './types.js';
export { createRuntime, buildMotionSystemPrompt } from './create-runtime.js';
export type { CreateRuntimeOptions } from './create-runtime.js';
// phase 488: runtime-audit-events barrel re-export (cli/config caller)
export { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './runtime-audit-events.js';

