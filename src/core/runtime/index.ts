/**
 * @module L4.Runtime
 * phase 488: barrel re-export RELOAD_LLM_CONFIG_MESSAGE_TYPE for cli/config
 * Runtime — 核心运行时编排器。
 */

export { Runtime } from './runtime.js';
export type { RuntimeOptions, RuntimeDependencies, TurnResult, GuidanceCompose, GuidanceEnvelope } from './types.js';
// phase 1856 (AE-D5): turn/provider 生命周期回调归 Runtime（invoke owner）；stream 段协议不转发
export type { TurnLifecycleCallbacks, ProviderLifecycleCallbacks, RuntimeTurnCallbacks } from './turn-callbacks.js';
// phase 1847: 原始批次交接 / 可失败格式化边界类型
export type { PreparedInboxEntry, PreparedInboxBatch, FormattedInboxBatch } from './types.js';
export { createRuntime } from './create-runtime.js';
// phase 488: reload inbox protocol barrel re-export (cli/config caller)
export { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './inbox-message-types.js';
export { runtimeMotionConfigSchema } from './config-schema.js';
export { clawConfigSchema } from './claw-config-schema.js';
