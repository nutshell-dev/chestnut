/**
 * @module L2.Tools
 * Tools module
 * Phase 1: Tool registry and executor framework
 */

// Registry
import { ToolRegistryImpl } from './registry.js';
import type { ToolRegistry } from './types.js';

export { ToolRegistryImpl } from './registry.js';

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}

// Executor (interfaces + implementation)
export {
  ToolExecutor,
  ToolExecutorImpl,
  createToolExecutor,
} from './executor.js';

// Context
export { ExecContextImpl } from './context.js';

export { escapeForLog } from './types.js';

// Constants
export * from './constants.js';

// Types (Tool, ExecContext now owned by L2c Tools)
export type { ToolResult, ToolDescriptor } from '../tool-protocol/index.js';
export type { Tool, ExecContext, ToolRegistry, IToolExecutor, ExecuteOptions } from './types.js';

export type { ExecContextImplOptions } from './context.js';

export type { AsyncToolTaskArgs, ScheduleAsyncTool } from './async-dispatch.js';



