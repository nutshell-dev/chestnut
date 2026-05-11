/**
 * @module L2.Tools
 * Tools module
 * Phase 1: Tool registry and executor framework
 */

// Registry
export { ToolRegistryImpl } from './registry.js';

import { ToolRegistryImpl } from './registry.js';
import type { ToolRegistry } from './executor.js';

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}

// Executor (interfaces + implementation)
export {
  ToolExecutorImpl,
  ToolExecutor,
  createToolExecutor,
} from './executor.js';

// Context
export { ExecContextImpl } from './context.js';

// Profiles
export { TOOL_PROFILES } from './profiles.js';
export { escapeForLog } from './types.js';

// Types (from tool-protocol - Phase 435)
export type { ToolResult, ExecContext, Tool } from '../tool-protocol/index.js';
export type { ToolRegistry, IToolExecutor, ExecuteOptions } from './executor.js';

export type { ExecContextImplOptions } from './context.js';

export type { AsyncToolTaskArgs, ScheduleAsyncTool } from './async-dispatch.js';

