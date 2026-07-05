/**
 * @module L2c.Tools
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

// Restricted overrides (e.g., shadow subagent DI overrides)
export { applyRestrictedOverrides } from './restricted-tools.js';

// Context
export { ExecContextImpl } from './context.js';


// Constants
// phase 137 M#8 ratify: wildcard export * by-design、constants.ts 内 const (phase 109 + phase 100 立) 通过 wildcard 暴露、M#7 模块对外承诺扩张策略优先 M#8、与 async-task audit-emit wildcard (phase 132) 同模板
export * from './constants.js';

// Types (Tool, ExecContext now owned by L2c Tools)
export type { ToolResult, ToolDescriptor } from '../tool-protocol/index.js';
export type {
  Tool,
  ExecContext,
  ToolRegistry,
  IToolExecutor,
  ExecuteOptions,
  // phase 1459 α-1: 5 子接口 export for α-5 narrow helper 用例
  ClawIdentity,
  ToolPermissions,
  ExecutionInfra,
  ExecutionControl,
  ExecutionAudit,
} from './types.js';



