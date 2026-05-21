/**
 * @module L2.Tools
 * Tools module
 * Phase 1: Tool registry and executor framework
 */

// Registry
import { ToolRegistryImpl } from './registry.js';
import type { ToolRegistry } from './executor.js';

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}

// Executor (interfaces + implementation)
export {
  ToolExecutor,
  createToolExecutor,
} from './executor.js';

// Context
export { ExecContextImpl } from './context.js';

// Profiles
export { TOOL_PROFILES } from './profiles.js';
export { escapeForLog } from './types.js';

// Constants
export * from './constants.js';

// Types (Tool, ExecContext now owned by L2c Tools)
export type { ToolResult, ToolDescriptor } from '../tool-protocol/index.js';
export type { Tool, ExecContext, ToolRegistry, IToolExecutor, ExecuteOptions } from './types.js';

export type { ExecContextImplOptions } from './context.js';

export type { AsyncToolTaskArgs, ScheduleAsyncTool } from './async-dispatch.js';

export {
  SPAWN_TOOL_NAME,
  DONE_TOOL_NAME,
  DISPATCH_TOOL_NAME,
  SHADOW_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  LS_TOOL_NAME,
  SEARCH_TOOL_NAME,
  EXEC_TOOL_NAME,
  SEND_TOOL_NAME,
  NOTIFY_CLAW_TOOL_NAME,
  SUBMIT_SUBTASK_TOOL_NAME,
  SKILL_TOOL_NAME,
  STATUS_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
  ASK_CALLER_TOOL_NAME,
  ASK_MOTION_TOOL_NAME,
} from './tool-names.js';

