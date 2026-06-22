/**
 * @module L5.Runtime
 * Core module exports
 */

export { Runtime, type RuntimeOptions } from './runtime/index.js';

// Re-export core modules for advanced usage
// phase 685: core/dialog 合并进 l4_context_manager、保 SDK 表面（ContextInjector + factory）不变、不暴露 trim-* 内部
// 走 deep import (./injector.js) 而非 barrel —— 走 barrel 会成环（barrel→injector→contract→...→step-executor→barrel）。
export { ContextInjector, createContextInjector, type ContextInjectorOptions } from './l4_context_manager/injector.js';
export * from './step-executor/index.js';
export * from './agent-executor/index.js';
export * from './async-task-system/index.js';
export * from './contract/index.js';
