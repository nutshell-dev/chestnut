/**
 * @module L2c.Tools
 * Tools module
 * Phase 1: Tool registry and executor framework
 */

// Registry
export { createToolRegistry } from './registry.js';

// Executor (interfaces + implementation)
export {
  ToolExecutor,
  createToolExecutor,
} from './executor.js';

// Restricted overrides (e.g., shadow subagent DI overrides)
export { applyRestrictedOverrides } from './restricted-tools.js';

// Context
export { ExecContextImpl } from './context.js';




// Types (Tool, ExecContext now owned by L2c Tools)
export type { ToolResult } from '../tool-protocol/index.js';
export type {
  Tool,
  ExecContext,
  FileState,
  ToolRegistry,
  IToolExecutor,
  // phase 1459 α-1: 5 子接口 export for α-5 narrow helper 用例
  ClawIdentity,
  ToolPermissions,
  ExecutionInfra,
  ExecutionControl,
  ExecutionAudit,
} from './types.js';

export { ToolError, ToolTimeoutError } from './errors.js';



export { TOOLS_FILE_ROUTING } from './audit-events.js';
