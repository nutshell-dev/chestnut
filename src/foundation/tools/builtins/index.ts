/**
 * Builtin tools - Built-in tool implementations
 */

import type { ToolRegistry } from '../executor.js';
import { statusTool } from './status.js';

// Re-export all tools
export { statusTool };

/**
 * Register all non-FileTool builtin tools to a registry
 * (FileTool 4 tool 抽出 phase428 → src/foundation/file-tool/ / Assembly 显式 register 经 createFileTools)
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(statusTool);
}
