/**
 * Tools module
 * Phase 1: Tool registry and executor framework
 */

// Registry
export { ToolRegistryImpl } from './registry.js';

// Executor (interfaces + implementation)
export {
  ToolExecutorImpl,
  ToolExecutor,
} from './executor.js';

// Context
export { ExecContextImpl } from './context.js';

// Profiles
export { TOOL_PROFILES } from './profiles.js';

// Types (from executor.ts - Phase 0 interfaces)
export type {
  ToolResult,
  ExecContext,
  Tool,
  ToolRegistry,
  IToolExecutor,
  ExecuteOptions,
} from './executor.js';

export type { ExecContextImplOptions } from './context.js';

// Builtin tools
export { registerBuiltinTools } from './builtins/index.js';
